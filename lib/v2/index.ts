import type { Plugin } from "@opencode/plugin"
import type { ToolDefinition } from "@opencode-ai/plugin"
import { tool } from "../tool"
import { getConfig } from "../config"
import { Logger } from "../logger"
import { PromptStore } from "../prompts/store"
import { createCompressMessageTool, createCompressRangeTool } from "../compress"
import { attachCompressionDuration } from "../compress/state"
import { createCommandExecuteHandler, createSystemPromptHandler } from "../hooks"
import {
    createSessionState,
    ensureSessionInitialized,
    checkSession,
    saveSessionState,
    syncToolCache,
    type SessionState,
} from "../state"
import { assignMessageRefs } from "../message-ids"
import { applyPendingManualTrigger } from "../commands/manual"
import {
    buildPriorityMap,
    buildToolIdList,
    injectCompressNudges,
    injectMessageIds,
    injectExtendedSubAgentResults,
    prune,
    stripHallucinations,
    syncCompressionBlocks,
} from "../messages"
import { countTokens } from "../token-utils"
import { matchesGlob } from "../protected-patterns"
import { history, project } from "./messages"
import { analyzeContextTokens } from "../commands/context"
import { buildStatsReport } from "../commands/stats"
import { rpc } from "./rpc"
import { elideCommittedCompressSummaries } from "./compress-inputs"
import { classifyRewrite } from "../compress/range-utils"
import {
    DEFAULT_MINIMUM_REDUCTION_PERCENT,
    takeLowYieldAdvisory,
    validateMinimumReductionPercent,
} from "../compress/low-yield"
import { injectAnchoredNudge } from "../messages/inject/utils"
import { rewriteBlocks, completeRewrite, type RewriteInput } from "../compress/rewrite"

// Extension point for future model-invisible V2 reports. Never use synthetic()
// here: its text would enter the model's context, unlike V1 ignored messages.
export async function report(logger: Logger, text: string, sessionID?: string) {
    logger.debug("V2 report (display pending)", { sessionID, text })
}

export async function setup(ctx: Plugin.Context) {
    const warned = new Set<string>()
    function unavailable(contract: string) {
        if (warned.has(contract)) return
        warned.add(contract)
        console.warn(`DCP: unavailable ${contract}`)
    }
    // Validate the complete baseline before exposing any mutating registration.
    const required = [
        ["session.get", ctx.session?.get],
        ["session.context", ctx.session?.context],
        ["session.hook", ctx.session?.hook],
        ["agent.get", ctx.agent?.get],
        ["tool.transform", ctx.tool?.transform],
    ] as const
    const missing = required.filter(([, method]) => typeof method !== "function")
    if (missing.length) {
        unavailable(
            `V2 baseline (${missing.map(([name]) => name).join(", ")}); compression not registered`,
        )
        return
    }
    if (typeof ctx.location?.directory !== "string" || !ctx.location.directory) {
        unavailable("V2 baseline (location.directory); compression not registered")
        return
    }
    const hasRpc = typeof ctx.rpc?.register === "function"
    const hasCommands = typeof ctx.command?.transform === "function"
    const hasPrompt = typeof ctx.session.prompt === "function"
    const hasModels = typeof ctx.model?.transform === "function"
    const warnings = {
        tui: {
            showToast: async (input: { body: { message: string } }) => {
                console.warn(`DCP: ${input.body.message}`)
            },
        },
    }
    const config = getConfig({ directory: ctx.location.directory, client: warnings })
    if (!config.enabled) {
        if (hasRpc)
            await ctx.rpc.register(
                { ...rpc, methods: { status: rpc.methods.status } },
                { status: async () => ({ enabled: false }) },
            )
        return
    }
    const logger = new Logger(config.debug)
    const prompts = new PromptStore(
        logger,
        ctx.location.directory,
        config.experimental.customPrompts,
        "compact",
    )
    const sessions = new Map<string, SessionState>()
    const queues = new Map<string, Promise<unknown>>()
    const limits = new Map<string, number>()
    const aliases: Record<string, string> = {
        task: "subagent",
        bash: "shell",
        apply_patch: "patch",
    }
    for (const list of [
        config.compress.protectedTools,
        config.commands.protectedTools,
        config.strategies.deduplication.protectedTools,
        config.strategies.purgeErrors.protectedTools,
    ]) {
        for (const name of [...list])
            if (aliases[name] && !list.includes(aliases[name]!)) list.push(aliases[name]!)
    }

    function serial<T>(sessionID: string, operation: () => Promise<T>): Promise<T> {
        const pending = (queues.get(sessionID) ?? Promise.resolve()).catch(() => {}).then(operation)
        queues.set(sessionID, pending)
        void pending
            .finally(() => {
                if (queues.get(sessionID) === pending) queues.delete(sessionID)
            })
            .catch(() => {})
        return pending
    }

    async function read(sessionID: string) {
        const [session, entries] = await Promise.all([
            ctx.session.get({ sessionID }),
            ctx.session.context({ sessionID }),
        ])
        if (
            session?.id !== sessionID ||
            !Array.isArray(entries) ||
            entries.some((entry) => !entry || typeof entry.id !== "string" || !entry.id) ||
            new Set(entries.map((entry) => entry.id)).size !== entries.length
        )
            throw new Error(
                "DCP: invalid V2 session context identity; compression was not performed",
            )
        return { session, entries }
    }

    const client = {
        session: {
            get: async ({ path }: { path: { id: string } }) => ({
                data: await ctx.session.get({ sessionID: path.id }),
            }),
            messages: async ({ path }: { path: { id: string } }) => {
                const { session, entries } = await read(path.id)
                return { data: history(entries, session) }
            },
            prompt: async (input: {
                path: { id: string }
                body: { parts: Array<{ text: string }> }
            }) =>
                report(logger, input.body.parts.map((part) => part.text).join("\n"), input.path.id),
        },
        tui: {
            showToast: async (input: { body: { message: string } }) =>
                report(logger, input.body.message),
        },
    }

    function compressionPermission(
        permissions: Array<{ action: string; resource: string; effect: string }>,
    ): SessionState["compressPermission"] {
        const rule = permissions.findLast(
            (rule) => matchesGlob("compress", rule.action) && matchesGlob("*", rule.resource),
        )
        return config.compress.permission === "deny" || rule?.effect === "deny"
            ? "deny"
            : config.compress.permission === "ask" || rule?.effect === "ask"
              ? "ask"
              : "allow"
    }

    async function readPolicy(sessionID: string, agentID?: string) {
        const { session, entries } = await read(sessionID)
        const selected =
            agentID ??
            session.agent ??
            entries.findLast((entry) => entry.type === "assistant")?.agent
        if (!selected) throw new Error("DCP commands require a session with a selected agent")
        const { data: agent } = await ctx.agent.get({ agentID: selected })
        if (
            !Array.isArray(agent?.permissions) ||
            (session.permissions !== undefined && !Array.isArray(session.permissions))
        )
            throw new Error("DCP: invalid V2 permission rules; compression was not performed")
        const permissions = [...agent.permissions, ...(session.permissions ?? [])]
        if (
            permissions.some(
                (rule) =>
                    !rule ||
                    typeof rule.action !== "string" ||
                    typeof rule.resource !== "string" ||
                    !["allow", "deny", "ask"].includes(rule.effect),
            )
        )
            throw new Error("DCP: invalid V2 permission rules; compression was not performed")
        return {
            session,
            entries,
            policy: {
                compressPermission: compressionPermission(permissions),
                isSubAgent: !!session.parentID,
            },
        }
    }

    async function load(sessionID: string, agentID?: string) {
        const { session, entries, policy } = await readPolicy(sessionID, agentID)
        let state = sessions.get(sessionID)
        if (!state) {
            state = createSessionState("compact")
            sessions.set(sessionID, state)
        }
        const messages = history(entries, session)
        await ensureSessionInitialized(
            client,
            state,
            sessionID,
            logger,
            messages,
            config.manualMode.enabled,
        )
        await checkSession(client, state, logger, messages, config.manualMode.enabled)
        state.compressPermission = policy.compressPermission
        return { state, entries, session, messages }
    }

    function allowed(state: SessionState) {
        if (state.isSubAgent && !config.experimental.allowSubAgents)
            throw new Error("DCP compression is disabled in subagents")
        if (state.compressPermission === "deny") throw new Error("DCP compression is denied")
        if (state.compressPermission === "ask")
            throw new Error(
                "DCP: permission 'ask' is not integrated by this V2 adapter. Compression was not performed.",
            )
    }

    if (hasModels)
        await ctx.model.transform((editor) => {
            limits.clear()
            for (const model of editor.list()) {
                if (
                    !model ||
                    typeof model.providerID !== "string" ||
                    !model.providerID ||
                    typeof model.id !== "string" ||
                    !model.id ||
                    typeof model.limit?.context !== "number" ||
                    !Number.isFinite(model.limit.context) ||
                    model.limit.context <= 0
                ) {
                    unavailable(
                        "valid model context metadata for an entry; unknown models use configured absolute thresholds",
                    )
                    continue
                }
                limits.set(`${model.providerID}/${model.id}`, model.limit.context)
            }
        })
    else unavailable("model.transform; using configured absolute thresholds only")
    for (const kind of ["context", "compaction"] as const)
        await ctx.session.hook(kind, (event) =>
            serial(event.sessionID, async () => {
                const { state, entries, session, messages } = await load(
                    event.sessionID,
                    event.agent,
                )
                if (state.isSubAgent && !config.experimental.allowSubAgents) {
                    delete event.tools.compress
                    return
                }
                if (state.compressPermission === "deny") delete event.tools.compress
                if (kind === "compaction") state.lowYield = null
                state.modelContextLimit = limits.get(`${event.model.providerID}/${event.model.id}`)
                state.systemPromptTokens = await countTokens(
                    event.system.map((part) => part.text).join("\n"),
                )
                const view = project(event.messages, entries, {
                    ...session,
                    agent: event.agent,
                    model: event.model,
                })
                stripHallucinations(view.messages, state.idFormat)
                assignMessageRefs(state, view.messages)
                // Compaction may select only a prefix; block origins can be in the retained tail.
                syncCompressionBlocks(state, logger, messages)
                await syncToolCache(state, config, logger, view.messages)
                buildToolIdList(state, view.messages)
                const rendered = prune(state, logger, config, view.messages, view.summaryBase)
                await injectExtendedSubAgentResults(
                    client,
                    state,
                    logger,
                    view.messages,
                    config.experimental.allowSubAgents,
                )
                const priorities = await buildPriorityMap(config, state, view.messages)
                prompts.reload()
                injectCompressNudges(
                    state,
                    config,
                    logger,
                    view.messages,
                    prompts.getRuntimePrompts(),
                    priorities,
                    kind === "context",
                )
                injectMessageIds(state, config, view.messages, priorities)
                if (kind === "context") {
                    const advisory = takeLowYieldAdvisory(state, entries)
                    const last = view.messages.at(-1)
                    if (
                        advisory &&
                        last &&
                        config.compress.mode === "range" &&
                        state.compressPermission === "allow" &&
                        !state.manualMode
                    )
                        injectAnchoredNudge(last, advisory)
                }
                applyPendingManualTrigger(state, view.messages, logger)
                event.messages = elideCommittedCompressSummaries(
                    view.restore(),
                    entries,
                    state,
                    rendered,
                    config,
                )
                const system = { system: event.system.map((part) => part.text) }
                await createSystemPromptHandler(
                    state,
                    logger,
                    config,
                    prompts,
                )(
                    {
                        sessionID: event.sessionID,
                        model: { limit: { context: state.modelContextLimit ?? 0 } },
                    },
                    system,
                )
                event.system = system.system.map((text, index) => ({
                    ...event.system[index],
                    type: "text",
                    text,
                }))
                await logger.saveContext(event.sessionID, view.messages)
                if (kind === "context") state.prune.messages.visibleBlockIds = new Set(rendered)
            }),
        )

    if (config.compress.permission !== "deny") {
        const define = (state: SessionState): ToolDefinition =>
            (config.compress.mode === "message"
                ? createCompressMessageTool
                : createCompressRangeTool)({
                client,
                state,
                logger,
                config,
                prompts,
                nativeInputProof: true,
                supportsRewrite: config.compress.mode === "range" ? true : undefined,
            })
        const definition = define(createSessionState("compact"))
        const inputSchema = tool.schema.object(definition.args)
        await ctx.tool.transform((editor) =>
            editor.add({
                name: "compress",
                description: definition.description,
                input: inputSchema,
                options: { codemode: false, permission: "compress" },
                execute: (input, context) =>
                    serial(context.sessionID, async () => {
                        const rewrite = classifyRewrite(input, config.compress.mode === "range")
                        validateMinimumReductionPercent(
                            (input as { minimumReductionPercent?: unknown })
                                ?.minimumReductionPercent,
                        )
                        if (rewrite) {
                            input = inputSchema.parse(input)
                            const state = sessions.get(context.sessionID)
                            if (!state || state.sessionId !== context.sessionID)
                                throw new Error(
                                    "DCP rewrite requires an initialised visible session",
                                )
                            const { policy } = await readPolicy(context.sessionID, context.agent)
                            allowed({ ...state, ...policy })
                            const shared = {
                                client,
                                state,
                                logger,
                                config,
                                prompts,
                                nativeInputProof: true as const,
                                supportsRewrite: true as const,
                                rewritePolicy: policy,
                            }
                            const run = {
                                sessionID: context.sessionID,
                                messageID: context.messageID,
                                ask: async () => allowed({ ...state, ...policy }),
                                metadata: () => {},
                            }
                            const started = Date.now()
                            const result = await rewriteBlocks(
                                shared,
                                run,
                                input as unknown as RewriteInput,
                                context.id,
                            )
                            if (
                                result.status === "published" &&
                                !result.warning &&
                                state.prune.messages === result.messagesState &&
                                state.lastCompaction === result.generation
                            ) {
                                try {
                                    attachCompressionDuration(
                                        state.prune.messages,
                                        context.messageID,
                                        context.id,
                                        Date.now() - started,
                                    )
                                    await saveSessionState(state, logger)
                                } catch (error) {
                                    try {
                                        logger.warn(
                                            "Rewrite committed; duration/save follow-up failed",
                                            { error: String(error) },
                                        )
                                    } catch {}
                                }
                            }
                            const content = await completeRewrite(
                                shared,
                                run,
                                result,
                                (input as unknown as RewriteInput).topic,
                            )
                            state.lowYield = null
                            return { content }
                        }
                        const { state } = await load(context.sessionID, context.agent)
                        allowed(state)
                        input = inputSchema.parse(input)
                        const started = Date.now()
                        const legacy = define(state)
                        const content = await legacy.execute(input, {
                            sessionID: context.sessionID,
                            messageID: context.messageID,
                            callID: context.id,
                            agent: context.agent,
                            directory: ctx.location.directory,
                            worktree: ctx.location.directory,
                            abort: new AbortController().signal,
                            ask: async () => allowed(state),
                            metadata: ({ title }: { title?: string }) => {
                                void context.progress({ title })
                            },
                        } as Parameters<typeof legacy.execute>[1])
                        attachCompressionDuration(
                            state.prune.messages,
                            context.messageID,
                            context.id,
                            Date.now() - started,
                        )
                        await saveSessionState(state, logger)
                        state.lowYield =
                            config.compress.mode === "range"
                                ? {
                                      assistantID: context.messageID,
                                      threshold:
                                          (input as { minimumReductionPercent?: number })
                                              .minimumReductionPercent ??
                                          DEFAULT_MINIMUM_REDUCTION_PERCENT,
                                  }
                                : null
                        // Both shared compression executors return text; the V1 helper's
                        // public return type also permits unrelated attachment results.
                        return { content: content as string }
                    }),
            }),
        )
    }
    if (config.commands.enabled && hasCommands && hasPrompt)
        await ctx.command.transform((editor) => {
            for (const name of ["dcp", "dcp-compress"])
                editor.add({
                    name,
                    description: name === "dcp" ? "DCP commands" : "Trigger DCP manual compression",
                    execute: async (invocation) => {
                        const prompt = await serial(invocation.sessionID, async () => {
                            const { state } = await load(invocation.sessionID)
                            state.lowYield = null
                            const permission =
                                state.compressPermission ?? config.compress.permission
                            if (
                                name === "dcp-compress" ||
                                invocation.prompt.text.trim().split(/\s+/)[0] === "compress"
                            )
                                allowed(state)
                            const output = { parts: [] }
                            await createCommandExecuteHandler(
                                client,
                                state,
                                logger,
                                config,
                                ctx.location.directory,
                                { global: { compress: permission }, agents: {} },
                            )(
                                {
                                    command: name,
                                    sessionID: invocation.sessionID,
                                    arguments: invocation.prompt.text,
                                },
                                output,
                            )
                            state.compressPermission = permission
                            const pending = state.pendingManualTrigger
                            if (!pending) return
                            allowed(state)
                            state.pendingManualTrigger = null
                            return pending.prompt
                        })
                        if (prompt)
                            await ctx.session.prompt({
                                sessionID: invocation.sessionID,
                                text: prompt,
                                delivery: invocation.delivery,
                            })
                    },
                })
        })
    else if (config.commands.enabled)
        unavailable(
            `command support (${[!hasCommands && "command.transform", !hasPrompt && "session.prompt"].filter(Boolean).join(", ")})`,
        )
    if (hasRpc)
        await ctx.rpc.register(rpc, {
            status: async () => ({ enabled: config.commands.enabled && hasCommands && hasPrompt }),
            snapshot: ({ sessionID }) =>
                serial(sessionID, async () => {
                    const { state, messages } = await load(sessionID)
                    syncCompressionBlocks(state, logger, messages)
                    return {
                        manualMode: !!state.manualMode,
                        canCompress:
                            state.compressPermission === "allow" &&
                            (!state.isSubAgent || config.experimental.allowSubAgents),
                        ...(state.compressPermission === "ask"
                            ? {
                                  blockedReason:
                                      "Permission 'ask' is not integrated by this V2 adapter.",
                              }
                            : {}),
                        context: await analyzeContextTokens(state, messages),
                        stats: await buildStatsReport(state, logger),
                    }
                }),
            manual: ({ sessionID, enabled }) =>
                serial(sessionID, async () => {
                    const { state } = await load(sessionID)
                    state.manualMode = enabled ? "active" : false
                    await saveSessionState(state, logger)
                    return {}
                }),
        })
    else unavailable("rpc.register; DCP TUI controls are unavailable")
    logger.info("DCP V2 initialized")
    return () => {
        sessions.clear()
        limits.clear()
    }
}
