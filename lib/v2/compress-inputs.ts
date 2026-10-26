import type { Message } from "@opencode/ai/schema/messages"
import type { Plugin } from "@opencode/plugin"
import type { CompressionBlock, SessionState } from "../state"
import type { PluginConfig } from "../config"
import { matchesGlob } from "../protected-patterns"
import { isDeepStrictEqual } from "node:util"
import { COMPRESS_INPUT_ARCHIVE_MARKER, summaryHash } from "../compress/summary"
import { isExactlyWrittenBlock, proveWrittenRewriteBatch } from "../compress/rewrite-proof"

type History = Awaited<ReturnType<Plugin.Context["session"]["context"]>>
const object = (value: unknown): value is Record<string, any> =>
    value !== null && typeof value === "object" && !Array.isArray(value)

/** Copy-on-write outgoing view only. Native stored arguments remain the audit source. */
export function elideCommittedCompressSummaries(
    outgoing: Message[],
    entries: History,
    state: SessionState,
    rendered: ReadonlySet<number>,
    config: PluginConfig,
): Message[] {
    if (config.compress.protectedTools.some((pattern) => matchesGlob("compress", pattern)))
        return outgoing
    const messages = state.prune.messages
    if (!messages.savedBlockSnapshots?.size || !rendered.size) return outgoing
    const saved = (block: CompressionBlock) => isExactlyWrittenBlock(messages, block)
    const successors = new Map<number, CompressionBlock[]>()
    for (const block of messages.blocksById.values())
        for (const id of block.consumedBlockIds)
            successors.set(id, [...(successors.get(id) ?? []), block])
    function represented(block: CompressionBlock): boolean {
        const seen = new Set<number>()
        while (true) {
            if (seen.has(block.blockId) || block.deactivatedByUser || !saved(block)) return false
            seen.add(block.blockId)
            if (block.active)
                return messages.activeBlockIds.has(block.blockId) && rendered.has(block.blockId)
            const next = successors.get(block.blockId)
            if (next?.length !== 1 || block.deactivatedByBlockId !== next[0]!.blockId) return false
            block = next[0]!
        }
    }
    const origins = new Map<string, CompressionBlock[]>()
    for (const block of messages.blocksById.values()) {
        const key = JSON.stringify([block.compressMessageId, block.compressCallId])
        origins.set(key, [...(origins.get(key) ?? []), block])
    }
    const byId = new Map<string, History[number][]>()
    const nativeCalls = new Map<string, number>()
    for (const entry of entries) {
        byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry])
        if (entry.type === "assistant")
            for (const part of entry.content)
                if (part.type === "tool")
                    nativeCalls.set(part.id, (nativeCalls.get(part.id) ?? 0) + 1)
    }
    const calls = new Map<string, number>()
    const outgoingIds = new Map<string, number>()
    const results = new Map<string, Array<{ error: boolean; name: string }>>()
    for (const message of outgoing) {
        if (message.id) outgoingIds.set(message.id, (outgoingIds.get(message.id) ?? 0) + 1)
        for (const part of message.content) {
            if (part.type === "tool-call") calls.set(part.id, (calls.get(part.id) ?? 0) + 1)
            if (part.type === "tool-result")
                results.set(part.id, [
                    ...(results.get(part.id) ?? []),
                    {
                        error: !["text", "json", "content"].includes(part.result?.type),
                        name: part.name,
                    },
                ])
        }
    }
    return outgoing.map((message) => {
        if (message.role !== "assistant" || !message.id || outgoingIds.get(message.id) !== 1)
            return message
        const owners = byId.get(message.id)
        const owner = owners?.length === 1 ? owners[0] : undefined
        if (owner?.type !== "assistant") return message
        let changed = false
        const content = message.content.map((part) => {
            if (
                part.type !== "tool-call" ||
                part.name !== "compress" ||
                !part.id ||
                calls.get(part.id) !== 1 ||
                nativeCalls.get(part.id) !== 1
            )
                return part
            const result = results.get(part.id)
            if (result?.length !== 1 || result[0]!.error || result[0]!.name !== "compress")
                return part
            const tools = owner.content.filter(
                (item) => item.type === "tool" && item.id === part.id,
            )
            const tool = tools.length === 1 ? tools[0] : undefined
            if (
                tool?.type !== "tool" ||
                tool.name !== "compress" ||
                tool.state.status !== "completed"
            )
                return part
            const input = part.input
            if (
                !isDeepStrictEqual(input, tool.state.input) ||
                !object(input) ||
                typeof input.topic !== "string" ||
                !Array.isArray(input.content) ||
                !input.content.length
            )
                return part
            const blocks = origins.get(JSON.stringify([message.id, part.id])) ?? []
            const rewrite = input.content.some(
                (entry: any) => object(entry) && entry.rewrite === true,
            )
            const rewriteProof = rewrite
                ? proveWrittenRewriteBatch(input, blocks, messages, state.idFormat)
                : undefined
            if (
                rewrite &&
                (!rewriteProof || rewriteProof.some(({ predecessor }) => !represented(predecessor)))
            )
                return part
            if (
                rewrite &&
                !input.content.every((entry: any) => object(entry) && entry.rewrite === true)
            )
                return part
            const used = new Set<number>()
            let runId: number | undefined
            for (const [index, entry] of input.content.entries()) {
                if (
                    !object(entry) ||
                    typeof entry.summary !== "string" ||
                    !entry.summary.trim() ||
                    (entry.rewrite !== undefined &&
                        entry.rewrite !== false &&
                        entry.rewrite !== true)
                )
                    return part
                const messageMode = typeof entry.messageId === "string"
                if (messageMode && Object.prototype.hasOwnProperty.call(entry, "rewrite"))
                    return part
                if (
                    messageMode
                        ? typeof entry.topic !== "string" ||
                          entry.startId !== undefined ||
                          entry.endId !== undefined
                        : typeof entry.startId !== "string" ||
                          typeof entry.endId !== "string" ||
                          entry.topic !== undefined
                )
                    return part
                const matches = rewrite
                    ? [rewriteProof![index]!.successor]
                    : blocks.filter(
                          (block) =>
                              block.batchTopic === input.topic &&
                              block.mode === (messageMode ? "message" : "range") &&
                              block.topic === (messageMode ? entry.topic : input.topic) &&
                              block.startId === (messageMode ? entry.messageId : entry.startId) &&
                              block.endId === (messageMode ? entry.messageId : entry.endId),
                      )
                if (matches.length !== 1) return part
                const block = matches[0]!
                // Legacy blocks without an exact pre-expansion fingerprint retain arguments.
                if (block.originalSummaryHash !== summaryHash(entry.summary)) return part
                if (
                    used.has(block.blockId) ||
                    !Number.isInteger(block.runId) ||
                    block.runId < 1 ||
                    (runId !== undefined && runId !== block.runId) ||
                    !represented(block)
                )
                    return part
                used.add(block.blockId)
                runId = block.runId
            }
            if (used.size !== blocks.length) return part
            changed = true
            return {
                ...part,
                input: {
                    ...input,
                    content: input.content.map((entry: any) => ({
                        ...entry,
                        summary: COMPRESS_INPUT_ARCHIVE_MARKER,
                    })),
                },
            }
        })
        return changed ? { ...message, content } : message
    })
}
