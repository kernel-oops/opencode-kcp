import type { SessionState, WithParts, CompressionBlock } from "../state"
import type { Logger } from "../logger"
import { proveWrittenRewriteBatch } from "../compress/rewrite-proof"

function sortBlocksByCreation(
    a: { createdAt: number; blockId: number },
    b: { createdAt: number; blockId: number },
): number {
    const createdAtDiff = a.createdAt - b.createdAt
    if (createdAtDiff !== 0) {
        return createdAtDiff
    }
    return a.blockId - b.blockId
}

export const syncCompressionBlocks = (
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
    // Three-argument callers supply the full current native session. A model-view
    // caller must pass null: absence from that view cannot establish uniqueness.
    nativeMessages: WithParts[] | null = messages,
): void => {
    const messagesState = state.prune.messages
    if (!messagesState?.blocksById?.size) {
        return
    }

    const messageIds = new Set(messages.map((msg) => msg.info.id))
    // Rebuilding the same consumed lineage is not a new deactivation. Preserve its
    // timestamp so a read-only sync does not invalidate exact saved-block proof.
    const previousDeactivations = new Map(
        [...messagesState.blocksById].map(([id, block]) => [
            id,
            {
                active: block.active,
                by: block.deactivatedByBlockId,
                at: block.deactivatedAt,
            },
        ]),
    )
    const previousActiveBlockIds = new Set<number>(
        Array.from(messagesState.blocksById.values())
            .filter((block) => block.active)
            .map((block) => block.blockId),
    )
    // C may replace a legacy block without backfilling its uncertain argument hash.
    // Preserve only an already-written, unchanged explicit rewrite's predecessor timestamp.
    const writtenRewritePredecessors = new Set<number>()
    const nativeById = new Map<string, WithParts[]>(),
        nativeCalls = new Map<string, number>()
    let completeNativeTools = nativeMessages !== null
    // Use every current native tool part, not the outgoing view or compress-only parts.
    for (const message of nativeMessages ?? []) {
        nativeById.set(message.info.id, [...(nativeById.get(message.info.id) ?? []), message])
        if (!Array.isArray(message.parts)) {
            completeNativeTools = false
            continue
        }
        for (const part of message.parts)
            if (part.type === "tool") {
                if (typeof part.callID !== "string" || !part.callID) completeNativeTools = false
                else nativeCalls.set(part.callID, (nativeCalls.get(part.callID) ?? 0) + 1)
            }
    }
    const batches = new Map<string, CompressionBlock[]>()
    for (const block of messagesState.blocksById.values()) {
        const key = JSON.stringify([block.compressMessageId, block.compressCallId])
        batches.set(key, [...(batches.get(key) ?? []), block])
    }
    if (completeNativeTools)
        for (const batch of batches.values()) {
            if (
                !batch.some((block) =>
                    block.consumedBlockIds.some(
                        (id) => messagesState.blocksById.get(id)?.originalSummaryHash === undefined,
                    ),
                )
            )
                continue
            const origin = batch[0]!,
                owners = nativeById.get(origin.compressMessageId)
            if (
                owners?.length !== 1 ||
                !origin.compressCallId ||
                nativeCalls.get(origin.compressCallId) !== 1
            )
                continue
            const call = owners[0]!.parts.find(
                (part) => part.type === "tool" && part.callID === origin.compressCallId,
            )
            if (
                call?.type !== "tool" ||
                call.tool !== "compress" ||
                call.state.status !== "completed"
            )
                continue
            const proof = proveWrittenRewriteBatch(
                call.state.input,
                batch,
                messagesState,
                state.idFormat,
            )
            if (proof)
                for (const { predecessor } of proof)
                    if (predecessor.originalSummaryHash === undefined)
                        writtenRewritePredecessors.add(predecessor.blockId)
        }

    messagesState.activeBlockIds.clear()
    messagesState.activeByAnchorMessageId.clear()

    const now = Date.now()
    const missingOriginBlockIds: number[] = []
    const orderedBlocks = Array.from(messagesState.blocksById.values()).sort(sortBlocksByCreation)

    for (const block of orderedBlocks) {
        const hasOriginMessage =
            typeof block.compressMessageId === "string" &&
            block.compressMessageId.length > 0 &&
            messageIds.has(block.compressMessageId)

        if (!hasOriginMessage) {
            block.active = false
            block.deactivatedAt = now
            block.deactivatedByBlockId = undefined
            missingOriginBlockIds.push(block.blockId)
            continue
        }

        if (block.deactivatedByUser) {
            block.active = false
            if (block.deactivatedAt === undefined) {
                block.deactivatedAt = now
            }
            block.deactivatedByBlockId = undefined
            continue
        }

        for (const consumedBlockId of block.consumedBlockIds) {
            if (!messagesState.activeBlockIds.has(consumedBlockId)) {
                continue
            }

            const consumedBlock = messagesState.blocksById.get(consumedBlockId)
            if (consumedBlock) {
                consumedBlock.active = false
                consumedBlock.deactivatedAt = now
                consumedBlock.deactivatedByBlockId = block.blockId

                const mappedBlockId = messagesState.activeByAnchorMessageId.get(
                    consumedBlock.anchorMessageId,
                )
                if (mappedBlockId === consumedBlock.blockId) {
                    messagesState.activeByAnchorMessageId.delete(consumedBlock.anchorMessageId)
                }
            }

            messagesState.activeBlockIds.delete(consumedBlockId)
        }

        block.active = true
        block.deactivatedAt = undefined
        block.deactivatedByBlockId = undefined
        messagesState.activeBlockIds.add(block.blockId)
        if (messageIds.has(block.anchorMessageId)) {
            messagesState.activeByAnchorMessageId.set(block.anchorMessageId, block.blockId)
        }
    }

    for (const block of messagesState.blocksById.values()) {
        const previous = previousDeactivations.get(block.blockId)
        if (
            !block.active &&
            (block.originalSummaryHash !== undefined ||
                writtenRewritePredecessors.has(block.blockId)) &&
            messagesState.savedBlockSnapshots?.has(block.blockId) &&
            !block.deactivatedByUser &&
            previous?.active === false &&
            block.deactivatedByBlockId !== undefined &&
            previous.by === block.deactivatedByBlockId
        )
            block.deactivatedAt = previous.at
    }

    for (const entry of messagesState.byMessageId.values()) {
        const allBlockIds = Array.isArray(entry.allBlockIds)
            ? [...new Set(entry.allBlockIds.filter((id) => Number.isInteger(id) && id > 0))]
            : []

        entry.allBlockIds = allBlockIds
        entry.activeBlockIds = allBlockIds.filter((id) => messagesState.activeBlockIds.has(id))
    }

    const nextActiveBlockIds = messagesState.activeBlockIds
    let deactivatedCount = 0
    let reactivatedCount = 0

    for (const blockId of previousActiveBlockIds) {
        if (!nextActiveBlockIds.has(blockId)) {
            deactivatedCount++
        }
    }
    for (const blockId of nextActiveBlockIds) {
        if (!previousActiveBlockIds.has(blockId)) {
            reactivatedCount++
        }
    }

    if (missingOriginBlockIds.length > 0 || deactivatedCount > 0 || reactivatedCount > 0) {
        logger.info("Synced compress block state", {
            missingOriginCount: missingOriginBlockIds.length,
            deactivatedCount,
            reactivatedCount,
        })
    }
}
