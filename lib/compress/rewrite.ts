import {
    exclusive,
    refreshManualMode,
    commitSessionState,
    type CompressionBlock,
    type PruneMessagesState,
    type SessionState,
} from "../state"
import { findLastCompactionTimestamp, serializePruneMessagesState } from "../state/utils"
import { parseBoundaryId } from "../message-ids"
import { countTokens } from "../token-utils"
import { isToolProtected } from "../protected-patterns"
import { authoriseCompression, notifyCompression } from "./pipeline"
import { buildSearchContext, fetchSessionMessages } from "./search"
import { appendProtectedUserMessages, appendProtectedPromptInfo } from "./protected-content"
import {
    childAssociationsMatch,
    childCaptureLineageMatches,
    validChildEvidence,
} from "./protected-child-evidence"
import { validateSummaryContent } from "./summary"
import { parseBlockPlaceholders } from "./range-utils"
import { applyCompressionState, wrapCompressedSummary } from "./state"
import type { ToolContext } from "./types"

/** Internal only until the supported V2 range adapter explicitly opts in. */
export interface RewriteInput {
    topic: string
    content: Array<{ startId: string; endId: string; summary: string; rewrite: true }>
}
type RunContext = Parameters<typeof authoriseCompression>[1] & { messageID: string }
function fail(reason: string): never {
    throw new Error(`DCP rewrite rejected: ${reason}`)
}
const unique = (values: string[]) =>
    values.length > 0 &&
    values.every((id) => typeof id === "string" && id.length > 0) &&
    new Set(values).size === values.length

/** Strict C never repairs counters or borrows ordinary allocation's fallback. */
function planRewriteAllocation(messages: PruneMessagesState, count: number) {
    const positiveSafe = (value: unknown): value is number =>
        typeof value === "number" && Number.isSafeInteger(value) && value > 0
    if (
        !(messages.blocksById instanceof Map) ||
        !(messages.byMessageId instanceof Map) ||
        !(messages.activeBlockIds instanceof Set) ||
        !(messages.visibleBlockIds instanceof Set) ||
        !(messages.activeByAnchorMessageId instanceof Map) ||
        (messages.savedBlockSnapshots !== undefined &&
            !(messages.savedBlockSnapshots instanceof Map)) ||
        !positiveSafe(messages.nextBlockId) ||
        !positiveSafe(messages.nextRunId) ||
        !positiveSafe(count)
    )
        fail("invalid strict allocation containers or counters")
    let lastBlockId = 0,
        lastRunId = 0
    for (const [id, block] of messages.blocksById) {
        if (!positiveSafe(id) || !block || block.blockId !== id || !positiveSafe(block.runId))
            fail("invalid stored block/run allocation identity")
        lastBlockId = Math.max(lastBlockId, id)
        lastRunId = Math.max(lastRunId, block.runId)
    }
    const reference = (id: unknown) => {
        if (!positiveSafe(id) || !messages.blocksById.has(id))
            fail("invalid allocation index reference")
    }
    for (const block of messages.blocksById.values()) {
        for (const ids of [block.includedBlockIds, block.consumedBlockIds, block.parentBlockIds]) {
            if (!Array.isArray(ids)) fail("invalid allocation lineage index")
            for (const id of ids) reference(id)
        }
        if (block.deactivatedByBlockId !== undefined) reference(block.deactivatedByBlockId)
    }
    for (const entry of messages.byMessageId.values()) {
        if (!Array.isArray(entry.allBlockIds) || !Array.isArray(entry.activeBlockIds))
            fail("invalid allocation message index")
        for (const id of [...entry.allBlockIds, ...entry.activeBlockIds]) reference(id)
    }
    for (const ids of [
        messages.activeBlockIds,
        messages.visibleBlockIds,
        messages.activeByAnchorMessageId.values(),
        messages.savedBlockSnapshots?.keys() ?? [],
    ])
        for (const id of ids) reference(id)
    const nextBlockId = messages.nextBlockId + count,
        nextRunId = messages.nextRunId + 1
    if (
        messages.nextBlockId <= lastBlockId ||
        messages.nextRunId <= lastRunId ||
        !positiveSafe(nextBlockId) ||
        !positiveSafe(nextRunId)
    )
        fail("strict allocation must be fresh, monotonic and safely advance the entire batch")
    return {
        blockIds: Array.from({ length: count }, (_, index) => messages.nextBlockId + index),
        runId: messages.nextRunId,
        nextBlockId,
        nextRunId,
    }
}

function fingerprint(state: SessionState): string {
    return JSON.stringify({
        session: state.sessionId,
        generation: state.lastCompaction,
        prune: serializePruneMessagesState(state.prune.messages),
        tools: [...state.prune.tools],
        visible: [...state.prune.messages.visibleBlockIds],
        proof: [...(state.prune.messages.savedBlockSnapshots ?? [])],
        stats: state.stats,
        permission: state.compressPermission,
        subagent: state.isSubAgent,
        manual: state.manualMode,
        pending: state.pendingManualTrigger,
        cache: [...state.subAgentResultCache],
        refs: [...state.messageIds.byRawId],
        reverseRefs: [...state.messageIds.byRef],
        nextRef: state.messageIds.nextRef,
    })
}

/** Detached, no preparation/reset/cache hydration. The adapter must retain its session serial queue. */
export async function rewriteBlocks(
    ctx: ToolContext,
    toolCtx: RunContext,
    input: RewriteInput,
    callId: string,
) {
    if (
        !ctx.nativeInputProof ||
        !ctx.supportsRewrite ||
        ctx.config.compress.mode !== "range" ||
        !ctx.state.sessionId ||
        ctx.state.sessionId !== toolCtx.sessionID
    )
        fail("an existing supported initialised session is required")
    if (
        !input ||
        typeof input.topic !== "string" ||
        !input.topic.trim() ||
        !Array.isArray(input.content) ||
        !input.content.length ||
        typeof callId !== "string" ||
        !callId.trim() ||
        typeof toolCtx.messageID !== "string" ||
        !toolCtx.messageID.trim()
    )
        fail("invalid rewrite batch")
    for (const entry of input.content) {
        if (
            entry?.rewrite !== true ||
            typeof entry.startId !== "string" ||
            typeof entry.endId !== "string" ||
            typeof entry.summary !== "string" ||
            !entry.summary.trim()
        )
            fail("explicit homogeneous true entries required")
        validateSummaryContent(entry.summary, "rewrite")
        if (
            parseBlockPlaceholders(entry.summary, "xml").length ||
            parseBlockPlaceholders(entry.summary, "compact").length
        )
            fail("replacement placeholders are forbidden")
    }
    input = { topic: input.topic, content: input.content.map((entry) => ({ ...entry })) }
    // Manual refresh changes only this detached scalar. No permission wait holds the live lock.
    const enforcement = { ...ctx.state }
    await authoriseCompression({ ...ctx, state: enforcement }, toolCtx, `Rewrite: ${input.topic}`)
    return exclusive(ctx.state, async () => {
        const live = ctx.state,
            prune = live.prune.messages,
            stats = live.stats
        if (live.sessionId !== toolCtx.sessionID) fail("session changed during authorisation")
        const allocation = planRewriteAllocation(prune, input.content.length)
        const expected = fingerprint(live)
        const verify = () => {
            if (
                live.prune.messages !== prune ||
                live.stats !== stats ||
                fingerprint(live) !== expected
            )
                fail("session generation or records changed")
            const current = planRewriteAllocation(live.prune.messages, input.content.length)
            if (
                current.runId !== allocation.runId ||
                current.nextRunId !== allocation.nextRunId ||
                current.nextBlockId !== allocation.nextBlockId
            )
                fail("strict allocation changed")
        }
        const raw = await fetchSessionMessages(ctx.client, toolCtx.sessionID)
        verify()
        if (
            raw.some((message) => message.info.sessionID !== toolCtx.sessionID) ||
            findLastCompactionTimestamp(raw) > live.lastCompaction
        )
            fail("native generation changed")
        const manualView = { ...live }
        await refreshManualMode(
            manualView,
            toolCtx.sessionID,
            ctx.logger,
            ctx.config.manualMode.enabled,
        )
        verify()
        if (manualView.manualMode && manualView.manualMode !== "compress-pending")
            fail("manual mode blocks compression")
        if (
            (ctx.rewritePolicy ?? live).compressPermission !== "allow" ||
            ((ctx.rewritePolicy ?? live).isSubAgent && !ctx.config.experimental.allowSubAgents)
        )
            fail("compression policy does not allow rewrite")
        const context = buildSearchContext(live, raw)
        const originals = new Map<string, typeof raw>()
        for (const message of raw)
            originals.set(message.info.id, [...(originals.get(message.info.id) ?? []), message])
        const nativeCalls = new Map<string, number>()
        for (const message of raw)
            for (const part of message.parts)
                if (part.type === "tool")
                    nativeCalls.set(part.callID, (nativeCalls.get(part.callID) ?? 0) + 1)
        const messageOwners = new Map<string, number[]>(),
            toolOwners = new Map<string, number[]>()
        for (const id of prune.activeBlockIds)
            if (!prune.blocksById.get(id)?.active) fail("unknown active block")
        for (const [anchor, id] of prune.activeByAnchorMessageId)
            if (
                !prune.activeBlockIds.has(id) ||
                prune.blocksById.get(id)?.anchorMessageId !== anchor
            )
                fail("unexpected anchor index")
        for (const block of prune.blocksById.values()) {
            if (block.active !== prune.activeBlockIds.has(block.blockId))
                fail("active record/index mismatch")
            if (!block.active) continue
            if (
                !unique(block.effectiveMessageIds) ||
                new Set(block.effectiveToolIds).size !== block.effectiveToolIds.length ||
                prune.activeByAnchorMessageId.get(block.anchorMessageId) !== block.blockId
            )
                fail("active coverage/anchor mismatch")
            for (const [ids, owners] of [
                [block.effectiveMessageIds, messageOwners],
                [block.effectiveToolIds, toolOwners],
            ] as const)
                for (const id of ids) owners.set(id, [...(owners.get(id) ?? []), block.blockId])
        }
        for (const [id, entry] of prune.byMessageId) {
            const owners = messageOwners.get(id) ?? []
            if (
                entry.activeBlockIds.length !== owners.length ||
                new Set(entry.activeBlockIds).size !== entry.activeBlockIds.length ||
                entry.activeBlockIds.some((block) => !owners.includes(block))
            )
                fail("message index mismatch")
        }
        const targets: CompressionBlock[] = [],
            seen = new Set<number>()
        for (const entry of input.content) {
            const start = parseBoundaryId(entry.startId, live.idFormat),
                end = parseBoundaryId(entry.endId, live.idFormat)
            if (
                start?.kind !== "compressed-block" ||
                end?.kind !== "compressed-block" ||
                start.blockId !== end.blockId ||
                !Number.isSafeInteger(start.blockId) ||
                start.blockId! < 1
            )
                fail("one same positive block reference is required")
            const block = prune.blocksById.get(start.blockId!)
            if (
                !block ||
                !block.active ||
                block.deactivatedByUser ||
                !prune.visibleBlockIds.has(block.blockId) ||
                !block.summary.trim() ||
                seen.has(block.blockId)
            )
                fail("target is not uniquely active and visible")
            seen.add(block.blockId)
            if (prune.savedBlockSnapshots?.get(block.blockId) !== JSON.stringify(block))
                fail("target lacks exact written proof")
            if (
                !block.effectiveMessageIds.includes(block.anchorMessageId) ||
                !block.startId.trim() ||
                !block.endId.trim() ||
                originals.get(block.compressMessageId)?.length !== 1 ||
                !block.compressCallId
            )
                fail("missing anchor or origin")
            if (nativeCalls.get(block.compressCallId) !== 1)
                fail("compression origin is not unique")
            const origin = originals.get(block.compressMessageId)![0]
            if (
                origin.parts.filter(
                    (part) =>
                        part.type === "tool" &&
                        part.tool === "compress" &&
                        part.callID === block.compressCallId &&
                        part.state.status === "completed",
                ).length !== 1
            )
                fail("ambiguous or incomplete compression origin")
            const calls: string[] = []
            for (const id of block.effectiveMessageIds) {
                const source = originals.get(id)
                const indexed = prune.byMessageId.get(id)
                if (
                    source?.length !== 1 ||
                    !indexed?.activeBlockIds.includes(block.blockId) ||
                    !indexed.allBlockIds.includes(block.blockId) ||
                    new Set(indexed.allBlockIds).size !== indexed.allBlockIds.length ||
                    indexed.allBlockIds.some(
                        (idOfBlock) =>
                            !prune.blocksById.get(idOfBlock)?.effectiveMessageIds.includes(id),
                    ) ||
                    messageOwners.get(id)?.length !== 1
                )
                    fail("missing, overlapping or inconsistent original")
                for (const part of source[0].parts)
                    if (part.type === "tool") calls.push(part.callID)
            }
            if (
                new Set(calls).size !== calls.length ||
                calls.length !== block.effectiveToolIds.length ||
                calls.some(
                    (id) =>
                        !id ||
                        nativeCalls.get(id) !== 1 ||
                        !block.effectiveToolIds.includes(id) ||
                        toolOwners.get(id)?.length !== 1,
                )
            )
                fail("tool coverage mismatch or overlap")
            const evidence = block.protectedChildEvidence
            if (
                evidence !== undefined &&
                (!validChildEvidence(evidence, block) ||
                    !evidence.complete ||
                    !childCaptureLineageMatches(block, prune.blocksById))
            )
                fail("invalid protected child evidence")
            if (
                !childAssociationsMatch(
                    evidence ?? { version: 1, complete: true, entries: [] },
                    block.effectiveMessageIds,
                    context,
                )
            )
                fail("missing current originals or child evidence")
            targets.push(block)
        }
        const planned = allocation.blockIds
        const prepared = []
        for (const [index, block] of targets.entries()) {
            const selection = {
                messageIds: raw
                    .filter((message) => block.effectiveMessageIds.includes(message.info.id))
                    .map((message) => message.info.id),
            }
            let summary = appendProtectedUserMessages(
                input.content[index].summary,
                selection,
                context,
                live,
                ctx.config.compress.protectUserMessages,
                true,
            )
            summary = appendProtectedPromptInfo(
                summary,
                selection,
                context,
                live,
                ctx.config.compress.protectTags,
                true,
            )
            const outputs: string[] = []
            for (const id of selection.messageIds)
                for (const part of context.rawMessagesById.get(id)!.parts) {
                    if (part.type !== "tool") continue
                    const child = part.tool === "task" || part.tool === "subagent"
                    if (
                        !child &&
                        !isToolProtected(
                            part.tool,
                            part.state.input,
                            ctx.config.compress.protectedTools,
                            ctx.config.protectedFilePatterns,
                            "metadata" in part.state ? part.state.metadata : undefined,
                        )
                    )
                        continue
                    if (part.state.status === "completed" && part.state.output)
                        outputs.push(
                            `\n### Tool: ${part.tool}\n${typeof part.state.output === "string" ? part.state.output : JSON.stringify(part.state.output)}`,
                        )
                }
            if (outputs.length)
                summary +=
                    "\n\nThe following protected tools were used in this conversation as well:" +
                    outputs.join("")
            for (const entry of block.protectedChildEvidence?.entries ?? [])
                summary += `\n\nPreviously protected child output:\n${entry.payload}`
            // Keep wrapping's outer trim from eating protected trailing whitespace.
            if (summary !== input.content[index].summary)
                summary += "\n\nEnd of protected attachments."
            const stored = wrapCompressedSummary(planned[index], summary, live.idFormat)
            const previousSummaryTokens = await countTokens(block.summary)
            verify()
            const summaryTokens = await countTokens(stored)
            verify()
            if (
                !Number.isSafeInteger(previousSummaryTokens) ||
                previousSummaryTokens <= 0 ||
                !Number.isSafeInteger(summaryTokens) ||
                summaryTokens < 0 ||
                summaryTokens >= previousSummaryTokens
            )
                fail("every fully protected summary must strictly shrink")
            prepared.push({ stored, previousSummaryTokens, summaryTokens })
        }
        verify()
        const affected = new Set(targets.flatMap((block) => block.effectiveMessageIds))
        const staged: SessionState = {
            ...live,
            stats: { ...live.stats },
            prune: {
                ...live.prune,
                messages: {
                    ...prune,
                    blocksById: new Map(prune.blocksById),
                    byMessageId: new Map(
                        [...prune.byMessageId].map(([id, entry]) => [
                            id,
                            affected.has(id)
                                ? {
                                      ...entry,
                                      activeBlockIds: [...entry.activeBlockIds],
                                      allBlockIds: [...entry.allBlockIds],
                                  }
                                : entry,
                        ]),
                    ),
                    activeBlockIds: new Set(prune.activeBlockIds),
                    activeByAnchorMessageId: new Map(prune.activeByAnchorMessageId),
                    visibleBlockIds: new Set(prune.visibleBlockIds),
                    savedBlockSnapshots: new Map(prune.savedBlockSnapshots),
                },
            },
        }
        const runId = allocation.runId
        staged.prune.messages.nextBlockId = allocation.nextBlockId
        staged.prune.messages.nextRunId = allocation.nextRunId
        for (const [index, predecessor] of targets.entries()) {
            staged.prune.messages.blocksById.set(predecessor.blockId, {
                ...predecessor,
                parentBlockIds: [...predecessor.parentBlockIds],
            })
            const blockId = planned[index]!
            applyCompressionState(
                staged,
                {
                    topic: input.topic,
                    batchTopic: input.topic,
                    startId: predecessor.startId,
                    endId: predecessor.endId,
                    mode: "range",
                    runId,
                    compressMessageId: toolCtx.messageID,
                    compressCallId: callId,
                    summaryTokens: prepared[index].summaryTokens,
                    originalSummary: input.content[index].summary,
                    protectedChildEvidence: predecessor.protectedChildEvidence,
                },
                {
                    messageIds: [],
                    toolIds: [],
                    messageTokenById: new Map(),
                    requiredBlockIds: [],
                    startReference: { kind: "compressed-block", rawIndex: -1 },
                    endReference: { kind: "compressed-block", rawIndex: -1 },
                },
                predecessor.anchorMessageId,
                blockId,
                prepared[index].stored,
                [predecessor.blockId],
            )
            staged.prune.messages.visibleBlockIds.delete(predecessor.blockId)
        }
        if (manualView.manualMode === "compress-pending") {
            staged.manualMode = false
            staged.pendingManualTrigger = null
        } else staged.manualMode = manualView.manualMode
        // Replacing a summary never accounts for raw pruning, including pre-existing counters.
        staged.stats = { ...stats }
        const outcome = await commitSessionState(staged, ctx.logger, {
            verify,
            publish: () => {
                live.prune.messages = staged.prune.messages
                live.stats = staged.stats
                live.manualMode = staged.manualMode
                live.pendingManualTrigger = staged.pendingManualTrigger
            },
        })
        if (outcome.status !== "published") {
            prune.savedBlockSnapshots = undefined
            if (live.sessionId === toolCtx.sessionID)
                live.prune.messages.savedBlockSnapshots = undefined
        }
        return {
            ...outcome,
            rawMessages: raw,
            messagesState: staged.prune.messages,
            generation: staged.lastCompaction,
            runId,
            entries: prepared.map((entry, index) => ({
                ...entry,
                blockId: planned[index],
                replacedBlockId: targets[index].blockId,
            })),
        }
    })
}

export async function completeRewrite(
    ctx: ToolContext,
    toolCtx: RunContext,
    result: Awaited<ReturnType<typeof rewriteBlocks>>,
    topic: string,
): Promise<string> {
    if (result.status !== "published") {
        return result.status === "superseded"
            ? "Rewrite committed (superseded); stale publication was suppressed. Do not retry automatically."
            : "Rewrite committed to disk, but publication failed; runtime state/proof may be incomplete. Do not retry automatically."
    }
    if (
        result.warning ||
        ctx.state.prune.messages !== result.messagesState ||
        ctx.state.lastCompaction !== result.generation
    )
        return "Rewrite committed; follow-up skipped after a warning or superseding generation. Do not retry automatically."
    try {
        await notifyCompression(
            ctx,
            toolCtx,
            result.rawMessages,
            result.entries.map((entry) => ({
                ...entry,
                runId: result.runId,
                summary: entry.stored,
            })),
            topic,
        )
    } catch (error) {
        try {
            ctx.logger.warn("Rewrite committed; notification failed", { error: String(error) })
        } catch {}
    }
    const oldTokens = result.entries.reduce(
        (total, entry) => total + entry.previousSummaryTokens,
        0,
    )
    const newTokens = result.entries.reduce((total, entry) => total + entry.summaryTokens, 0)
    return `Rewrote ${result.entries.length} summaries: ${oldTokens} old summary tokens removed, ${newTokens} new summary tokens added, ${oldTokens - newTokens} net DCP summary-token reduction; 0 new raw messages pruned.`
}
