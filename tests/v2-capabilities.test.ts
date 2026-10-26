import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { formatMessageRef } from "../lib/message-ids"

type AgentGetOutput = Awaited<ReturnType<Plugin.Context["agent"]["get"]>>
type SessionContextOutput = Awaited<ReturnType<Plugin.Context["session"]["context"]>>
type SessionInfo = Awaited<ReturnType<Plugin.Context["session"]["get"]>>

// Setup reads configuration at module evaluation. Never consult the user's HOME.
const root = resolve(".impl-private/capability-fixtures")
mkdirSync(root, { recursive: true })
const home = mkdtempSync(join(root, "home-"))
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "OPENCODE_CONFIG_DIR"])
    process.env[key] = home
const { setup } = await import("../lib/v2/index")
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const model = { providerID: "fixture", id: "fixture" } as SessionContext["model"]
let next = 0

function fixture(mode: "range" | "message" = "range", permission = "allow", limits = {}) {
    const directory = mkdtempSync(join(root, "project-"))
    mkdirSync(join(directory, ".opencode"))
    writeFileSync(
        join(directory, ".opencode/dcp.json"),
        JSON.stringify({
            autoUpdate: false,
            pruneNotification: "off",
            compress: {
                mode,
                permission,
                protectUserMessages: false,
                protectedTools: [],
                ...limits,
            },
        }),
    )
    const session: SessionInfo = {
        id: `fixture_${++next}`,
        projectID: "fixture",
        agent: "build",
        model,
        location: { directory },
        cost: 0,
        tokens,
        time: { created: 1, updated: 1 },
    }
    const agent: AgentGetOutput = {
        location: { directory },
        data: {
            id: "build",
            name: "build",
            mode: "primary",
            hidden: false,
            request: { settings: {}, headers: {}, body: {} },
            permissions: [],
        },
    }
    const entries: SessionContextOutput = [
        { id: "msg_user", type: "user", time: { created: 1 }, text: "Investigate the fixture" },
        {
            id: "msg_assistant",
            type: "assistant",
            time: { created: 2, completed: 3 },
            agent: "build",
            model,
            content: [{ type: "text", text: "Detailed investigation. ".repeat(150) }],
        },
    ]
    const hooks = new Map<string, (event: SessionContext) => Promise<unknown>>()
    const tools: any[] = []
    const commands: any[] = []
    let modelTransform: any
    let rpcHandlers: any
    const ctx = {
        location: { directory },
        session: {
            get: async () => session,
            context: async () => entries,
            hook: async (kind: string, handler: any) => {
                hooks.set(kind, handler)
            },
            prompt: async () => {
                throw new Error("fixture must not prompt a model")
            },
        },
        agent: { get: async () => agent },
        tool: {
            transform: async (callback: any) => callback({ add: (tool: any) => tools.push(tool) }),
        },
        command: {
            transform: async (callback: any) =>
                callback({ add: (command: any) => commands.push(command) }),
        },
        model: {
            transform: async (callback: any) => {
                modelTransform = callback
            },
        },
        rpc: {
            register: async (_definition: any, handlers: any) => {
                rpcHandlers = handlers
            },
        },
    }
    function event(): SessionContext {
        return {
            sessionID: session.id as SessionContext["sessionID"],
            agent: "build" as SessionContext["agent"],
            model,
            system: [],
            options: {},
            tools: {},
            messages: [
                {
                    id: entries[0]!.id,
                    role: "user",
                    content: [{ type: "text", text: "Investigate the fixture" }],
                },
                {
                    id: entries[1]!.id,
                    role: "assistant",
                    content: [{ type: "text", text: "Detailed investigation. ".repeat(150) }],
                },
            ],
        }
    }
    return {
        ctx,
        session,
        agent,
        entries,
        hooks,
        tools,
        commands,
        event,
        start: () => setup(ctx as unknown as Plugin.Context),
        models: (list: unknown[]) => modelTransform({ list: () => list }),
        rpc: () => rpcHandlers,
        execute: (input: unknown) =>
            tools[0].execute(input, {
                sessionID: session.id,
                agent: "build",
                messageID: "msg_compress",
                id: "call_compress",
                progress: async () => {},
            }),
    }
}

async function warnings(run: (messages: string[]) => Promise<void>) {
    const previous = console.warn
    const messages: string[] = []
    console.warn = (message) => messages.push(String(message))
    try {
        await run(messages)
    } finally {
        console.warn = previous
    }
}

test("missing baseline methods leave no partial registrations", async () => {
    for (const [domain, method] of [
        ["session", "get"],
        ["session", "context"],
        ["session", "hook"],
        ["agent", "get"],
        ["tool", "transform"],
    ])
        await warnings(async (messages) => {
            const f = fixture()
            ;(f.ctx as any)[domain!][method!] = {}
            await f.start()
            assert.equal(f.tools.length, 0)
            assert.equal(f.hooks.size, 0)
            assert.equal(f.commands.length, 0)
            assert.equal(f.rpc(), undefined)
            assert.equal(messages.length, 1)
            assert.ok(messages[0]!.includes(`${domain}.${method}`))
        })
})

test("ordinary range and message compression work without optional methods", async () => {
    for (const mode of ["range", "message"] as const)
        await warnings(async (messages) => {
            const f = fixture(mode)
            for (const domain of ["rpc", "command", "model"])
                (f.ctx as any)[domain] = { register: true, transform: {} }
            ;(f.ctx.session as any).prompt = undefined
            const dispose = await f.start()
            assert.equal(f.hooks.size, 2)
            assert.equal(f.tools.length, 1)
            const event = f.event()
            await f.hooks.get("context")!(event)
            const content =
                mode === "range"
                    ? [
                          {
                              startId: formatMessageRef(1, "compact"),
                              endId: formatMessageRef(2, "compact"),
                              summary: "Fixture investigated.",
                          },
                      ]
                    : [
                          {
                              messageId: formatMessageRef(2, "compact"),
                              topic: "Fixture",
                              summary: "Fixture investigated.",
                          },
                      ]
            const input = { topic: "Fixture", content }
            const result = await f.execute(input)
            assert.match(result.content, /Compressed/)
            // As on the public host, the completed call becomes native history
            // before the next request. Without this evidence block sync correctly
            // treats the compression origin as missing, rather than trusting it.
            f.entries.push({
                id: "msg_compress",
                type: "assistant",
                time: { created: 4, completed: 5 },
                agent: "build",
                model,
                content: [
                    {
                        type: "tool",
                        id: "call_compress",
                        name: "compress",
                        time: { created: 4, ran: 4, completed: 5 },
                        state: {
                            status: "completed",
                            input,
                            content: [{ type: "text", text: result.content }],
                        },
                    },
                ],
            })
            const compacted = f.event()
            compacted.messages.push(
                {
                    id: "msg_compress",
                    role: "assistant",
                    content: [{ type: "tool-call", id: "call_compress", name: "compress", input }],
                },
                {
                    role: "tool",
                    content: [
                        {
                            type: "tool-result",
                            id: "call_compress",
                            name: "compress",
                            result: { type: "text", value: result.content },
                        },
                    ],
                },
            )
            await f.hooks.get("compaction")!(compacted)
            assert.match(JSON.stringify(compacted.messages), /Fixture investigated/)
            assert.doesNotMatch(JSON.stringify(compacted.messages), /Detailed investigation/)
            assert.equal(messages.length, 3, "setup diagnostics do not recur in hooks")
            dispose?.()
        })
})

test("real registration failures propagate, not unsupported diagnostics", async () => {
    for (const domain of ["rpc", "command", "model"] as const)
        await warnings(async (messages) => {
            const f = fixture()
            const failure = new Error(`fixture ${domain} I/O failure`)
            ;(f.ctx[domain] as any)[domain === "rpc" ? "register" : "transform"] = async () => {
                throw failure
            }
            await assert.rejects(f.start, (error) => error === failure)
            assert.deepEqual(messages, [])
        })
})

test("a disabled adapter tolerates an absent RPC API without registering core features", async () => {
    const f = fixture()
    writeFileSync(join(f.ctx.location.directory, ".opencode/dcp.json"), '{"enabled":false}')
    ;(f.ctx as any).rpc = undefined
    await f.start()
    assert.equal(f.tools.length, 0)
    assert.equal(f.hooks.size, 0)
})

test("invalid metadata warns once, and unknown context does not invent a budget", async () =>
    warnings(async (messages) => {
        const f = fixture("range", "allow", {
            maxContextLimit: "1%",
            minContextLimit: 0,
            summaryBuffer: false,
        })
        assert.equal(f.entries[1]!.type, "assistant")
        if (f.entries[1]!.type === "assistant")
            f.entries[1]!.tokens = { ...tokens, input: 1000000, output: 1 }
        await f.start()
        for (let i = 0; i < 2; i++)
            f.models([
                { providerID: "fixture", id: "fixture", limit: { context: NaN } },
                { providerID: "fixture", id: "fixture", limit: { context: -1 } },
                { providerID: "fixture", id: "fixture", limit: { context: 0 } },
                { providerID: "fixture", id: "fixture", limit: { context: Infinity } },
                { providerID: "fixture", id: "fixture", limit: { context: "1000" } },
                { providerID: "fixture", id: "fixture", limit: { input: 900, output: 100 } },
                { id: "fixture", limit: { context: 1000 } },
                null,
            ])
        assert.equal(messages.length, 1)
        const unknown = f.event()
        await f.hooks.get("context")!(unknown)
        f.models([
            {
                providerID: "fixture",
                id: "fixture",
                limit: { context: 1000, input: 900, output: 100 },
            },
        ])
        const known = f.event()
        await f.hooks.get("context")!(known)
        assert.ok(
            JSON.stringify(known.messages).length > JSON.stringify(unknown.messages).length,
            "percentage maximum nudge requires real metadata even with very high recorded usage",
        )
        const absolute = fixture("range", "allow", {
            maxContextLimit: 10,
            minContextLimit: 0,
            summaryBuffer: false,
        })
        if (absolute.entries[1]!.type === "assistant")
            absolute.entries[1]!.tokens = { ...tokens, input: 1000000, output: 1 }
        ;(absolute.ctx as any).model = undefined
        await absolute.start()
        const configured = absolute.event()
        await absolute.hooks.get("context")!(configured)
        assert.deepEqual(
            configured.messages,
            known.messages,
            "absolute thresholds work without model metadata",
        )
    }))

test("deny and ask stay fail-closed, including command entrypoints", async () => {
    for (const effect of ["deny", "ask"] as const) {
        const f = fixture()
        f.agent.data.permissions = [{ action: "compress", resource: "*", effect }]
        await f.start()
        await assert.rejects(() => f.execute({}), /denied|not integrated/)
        for (const command of f.commands)
            await assert.rejects(
                () =>
                    command.execute({
                        sessionID: f.session.id,
                        prompt: { text: "compress" },
                        delivery: "immediate",
                    }),
                /denied|not integrated/,
            )
        assert.equal((await f.rpc().snapshot({ sessionID: f.session.id })).canCompress, false)
    }
})

test("invalid identities and permission data reject before compression", async () => {
    for (const corrupt of [
        (f: ReturnType<typeof fixture>) => {
            f.entries[1]!.id = ""
        },
        (f: ReturnType<typeof fixture>) => {
            f.entries[1]!.id = f.entries[0]!.id
        },
        (f: ReturnType<typeof fixture>) => {
            ;(f.ctx.session as any).context = async () => ({ data: f.entries })
        },
        (f: ReturnType<typeof fixture>) => {
            ;(f.agent.data as any).permissions = {}
        },
        (f: ReturnType<typeof fixture>) => {
            ;(f.agent.data as any).permissions = [
                { action: "compress", resource: "*", effect: "unknown" },
            ]
        },
    ]) {
        const f = fixture()
        await f.start()
        corrupt(f)
        await assert.rejects(() => f.execute({}), /invalid V2/)
    }
})

test("normal server entry imports without the optional TUI runtime", async () => {
    const server = await import("../index")
    assert.equal(typeof server.default.setup, "function")
})
