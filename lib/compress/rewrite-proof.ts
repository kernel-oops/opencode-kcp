import type { CompressionBlock, PruneMessagesState } from "../state/types"
import { parseBoundaryId, type IdFormat } from "../message-ids"
import { isDeepStrictEqual } from "node:util"
import { summaryHash, validateSummaryContent } from "./summary"
import { parseBlockPlaceholders } from "./range-utils"

export function isExactlyWrittenBlock(
    messages: PruneMessagesState,
    block: CompressionBlock,
): boolean {
    const snapshot = messages.savedBlockSnapshots?.get(block.blockId)
    if (snapshot === undefined) return false
    try {
        return isDeepStrictEqual(JSON.parse(snapshot), JSON.parse(JSON.stringify(block)))
    } catch {
        return false
    }
}

/** Whole explicit batch only. Native origin uniqueness and rendered lineage remain caller gates. */
export function proveWrittenRewriteBatch(
    input: unknown,
    created: CompressionBlock[],
    messages: PruneMessagesState,
    format: IdFormat,
): Array<{ successor: CompressionBlock; predecessor: CompressionBlock }> | undefined {
    const object = (value: unknown): value is Record<string, unknown> =>
        value !== null && typeof value === "object" && !Array.isArray(value)
    if (
        !object(input) ||
        typeof input.topic !== "string" ||
        !input.topic.trim() ||
        !Array.isArray(input.content) ||
        !input.content.length ||
        input.content.length !== created.length
    )
        return
    const result: Array<{ successor: CompressionBlock; predecessor: CompressionBlock }> = []
    const used = new Set<number>(),
        targets = new Set<number>()
    let runId: number | undefined
    for (const entry of input.content) {
        if (
            !object(entry) ||
            entry.rewrite !== true ||
            typeof entry.startId !== "string" ||
            typeof entry.endId !== "string" ||
            typeof entry.summary !== "string" ||
            !entry.summary.trim() ||
            Object.keys(entry).some(
                (key) => !["rewrite", "startId", "endId", "summary"].includes(key),
            )
        )
            return
        try {
            validateSummaryContent(entry.summary, "rewrite proof")
        } catch {
            return
        }
        if (
            parseBlockPlaceholders(entry.summary, "xml").length ||
            parseBlockPlaceholders(entry.summary, "compact").length
        )
            return
        const start = parseBoundaryId(entry.startId, format),
            end = parseBoundaryId(entry.endId, format)
        if (
            start?.kind !== "compressed-block" ||
            end?.kind !== "compressed-block" ||
            start.blockId !== end.blockId ||
            targets.has(start.blockId!)
        )
            return
        const prior = messages.blocksById.get(start.blockId!)
        if (
            !prior ||
            prior.active ||
            prior.deactivatedByUser ||
            !isExactlyWrittenBlock(messages, prior)
        )
            return
        const submittedHash = summaryHash(entry.summary)
        const matches = created.filter(
            (block) =>
                block.mode === "range" &&
                block.topic === input.topic &&
                block.batchTopic === input.topic &&
                block.originalSummaryHash === submittedHash &&
                isDeepStrictEqual(block.consumedBlockIds, [prior.blockId]) &&
                isDeepStrictEqual(block.includedBlockIds, [prior.blockId]),
        )
        if (matches.length !== 1) return
        const block = matches[0]!
        if (
            used.has(block.blockId) ||
            !Number.isSafeInteger(block.blockId) ||
            block.blockId < 1 ||
            !Number.isSafeInteger(block.runId) ||
            block.runId < 1 ||
            (runId !== undefined && runId !== block.runId) ||
            block.compressMessageId !== created[0]!.compressMessageId ||
            block.compressCallId !== created[0]!.compressCallId ||
            block.deactivatedByUser ||
            !isExactlyWrittenBlock(messages, block) ||
            prior.deactivatedByBlockId !== block.blockId ||
            !prior.parentBlockIds.includes(block.blockId) ||
            block.directMessageIds.length !== 0 ||
            block.directToolIds.length !== 0 ||
            block.startId !== prior.startId ||
            block.endId !== prior.endId ||
            block.anchorMessageId !== prior.anchorMessageId ||
            !isDeepStrictEqual(block.effectiveMessageIds, prior.effectiveMessageIds) ||
            !isDeepStrictEqual(block.effectiveToolIds, prior.effectiveToolIds)
        )
            return
        used.add(block.blockId)
        targets.add(prior.blockId)
        runId = block.runId
        result.push({ successor: block, predecessor: prior })
    }
    return used.size === created.length ? result : undefined
}
