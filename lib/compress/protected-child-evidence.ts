import type { CompressionBlock, ProtectedChildEvidence, WithParts } from "../state"
import type { SearchContext } from "./types"
import { summaryHash } from "./summary"

type Entry = ProtectedChildEvidence["entries"][number]
export type ChildEvidenceCollector = Array<Omit<Entry, "capturedBlockId">>

const nonempty = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0

function samePayloadAssociation(left: Entry, right: Entry): boolean {
    return (
        left.sourceMessageId === right.sourceMessageId &&
        left.callId === right.callId &&
        left.childSessionId === right.childSessionId &&
        left.payloadHash === right.payloadHash &&
        left.payload === right.payload
    )
}

/** Validate persisted bytes/coverage only. Current source association is checked separately. */
export function validChildEvidence(
    value: unknown,
    block: Pick<CompressionBlock, "summary" | "effectiveMessageIds" | "effectiveToolIds">,
): value is ProtectedChildEvidence {
    if (!value || typeof value !== "object") return false
    const evidence = value as ProtectedChildEvidence
    return (
        evidence.version === 1 &&
        typeof evidence.complete === "boolean" &&
        Array.isArray(evidence.entries) &&
        typeof block.summary === "string" &&
        Array.isArray(block.effectiveMessageIds) &&
        Array.isArray(block.effectiveToolIds) &&
        evidence.entries.every(
            (entry) =>
                entry &&
                Number.isSafeInteger(entry.capturedBlockId) &&
                entry.capturedBlockId > 0 &&
                nonempty(entry.sourceMessageId) &&
                nonempty(entry.callId) &&
                nonempty(entry.childSessionId) &&
                nonempty(entry.payload) &&
                entry.payloadHash === summaryHash(entry.payload) &&
                block.effectiveMessageIds.includes(entry.sourceMessageId) &&
                block.effectiveToolIds.includes(entry.callId) &&
                block.summary.includes(entry.payload),
        )
    )
}

/** Only the existing fresh-fetch path calls this; cache hits never attest association. */
export function observeProtectedChild(
    collector: ChildEvidenceCollector | undefined,
    sourceMessageId: string,
    part: any,
    childSessionId: string,
    messages: WithParts[],
    selected: string,
    payload: string,
): void {
    if (!collector || !selected.trim() || !payload.includes(selected)) return
    const metadata = part.state?.metadata
    if (
        !nonempty(sourceMessageId) ||
        !nonempty(part.callID) ||
        !nonempty(childSessionId) ||
        (metadata?.sessionId !== undefined && metadata.sessionId !== childSessionId) ||
        (metadata?.sessionID !== undefined && metadata.sessionID !== childSessionId) ||
        messages.length === 0 ||
        messages.some(
            (message) => !nonempty(message.info.id) || message.info.sessionID !== childSessionId,
        ) ||
        new Set(messages.map((message) => message.info.id)).size !== messages.length
    )
        return
    collector.push({
        sourceMessageId,
        callId: part.callID,
        childSessionId,
        payload,
        payloadHash: summaryHash(payload),
    })
}

/** No fetch, cache access, prose inference or legacy upgrade. All byte checks precede apply. */
export function assembleChildEvidence(
    blockId: number,
    summary: string,
    messageIds: string[],
    toolIds: string[],
    consumedRecords: Array<CompressionBlock | undefined>,
    context: SearchContext,
    collector: ChildEvidenceCollector,
    blocks?: ReadonlyMap<number, CompressionBlock>,
): ProtectedChildEvidence {
    const consumed = consumedRecords.filter(
        (block): block is CompressionBlock => block !== undefined,
    )
    const ids = new Set(messageIds)
    for (const block of consumed) for (const id of block.effectiveMessageIds) ids.add(id)
    const entries: Entry[] = []
    const lineage = blocks ?? new Map(consumed.map((block) => [block.blockId, block]))
    let complete = ids.size > 0 && consumed.length === consumedRecords.length
    for (const block of consumed) {
        if (block.effectiveMessageIds.length === 0) complete = false
        if (block.protectedChildEvidence !== undefined) {
            if (validChildEvidence(block.protectedChildEvidence, block)) {
                entries.push(...block.protectedChildEvidence.entries.map((entry) => ({ ...entry })))
                if (!block.protectedChildEvidence.complete) complete = false
                if (!childCaptureLineageMatches(block, lineage)) complete = false
                if (
                    !childAssociationsMatch(
                        block.protectedChildEvidence,
                        block.effectiveMessageIds,
                        context,
                    )
                )
                    complete = false
            } else complete = false
        }
        // Even fresh evidence cannot wash an unknown consumed child expansion clean.
        if (
            !block.protectedChildEvidence &&
            !childAssociationsMatch(
                { version: 1, complete: true, entries: [] },
                block.effectiveMessageIds,
                context,
            )
        )
            complete = false
    }
    entries.push(...collector.map((entry) => ({ ...entry, capturedBlockId: blockId })))
    const unique = entries.filter(
        (entry, index) =>
            entries.findIndex((other) => samePayloadAssociation(other, entry)) === index,
    )
    const effectiveTools = [
        ...new Set([...toolIds, ...consumed.flatMap((block) => block.effectiveToolIds)]),
    ]
    const evidence: ProtectedChildEvidence = { version: 1, complete, entries: unique }
    const valid = validChildEvidence(evidence, {
        summary,
        effectiveMessageIds: [...ids],
        effectiveToolIds: effectiveTools,
    })
    return {
        ...evidence,
        complete: complete && valid && childAssociationsMatch(evidence, [...ids], context),
    }
}

/** Completeness needs every current original and unambiguous parent/call/child coverage. */
export function childAssociationsMatch(
    evidence: ProtectedChildEvidence,
    messageIds: string[],
    context: SearchContext,
): boolean {
    const children = new Map<string, { messageId: string; childId: unknown }>()
    const calls = new Set<string>()
    for (const id of messageIds) {
        const originals = context.rawMessages.filter((message) => message.info.id === id)
        if (originals.length !== 1) return false
        for (const part of originals[0].parts) {
            if (part.type !== "tool") continue
            if (!nonempty(part.callID) || calls.has(part.callID)) return false
            calls.add(part.callID)
            if (!isChild(part)) continue
            if (part.state.status !== "completed") return false
            const metadata = part.state.metadata
            const childId = metadata?.sessionId ?? metadata?.sessionID
            if (
                !nonempty(childId) ||
                (metadata?.sessionId !== undefined && metadata.sessionId !== childId) ||
                (metadata?.sessionID !== undefined && metadata.sessionID !== childId)
            )
                return false
            children.set(part.callID, { messageId: id, childId })
        }
    }
    return (
        [...children].every(([callId, source]) =>
            evidence.entries.some(
                (entry) =>
                    entry.callId === callId &&
                    entry.sourceMessageId === source.messageId &&
                    entry.childSessionId === source.childId,
            ),
        ) &&
        evidence.entries.every((entry) => {
            const source = children.get(entry.callId)
            return (
                source?.messageId === entry.sourceMessageId &&
                source.childId === entry.childSessionId
            )
        })
    )
}

/** Capture IDs must identify this block or an actual consumed ancestor, never an unrelated record. */
export function childCaptureLineageMatches(
    block: CompressionBlock,
    blocks: ReadonlyMap<number, CompressionBlock>,
): boolean {
    const ancestors = new Set<number>()
    const pending = [block.blockId]
    while (pending.length) {
        const id = pending.pop()!
        if (ancestors.has(id)) continue
        ancestors.add(id)
        const record = blocks.get(id)
        if (!record) return false
        pending.push(...record.consumedBlockIds)
    }
    return (block.protectedChildEvidence?.entries ?? []).every((entry) => {
        if (!ancestors.has(entry.capturedBlockId)) return false
        const origin = blocks.get(entry.capturedBlockId)
        return (
            origin &&
            validChildEvidence(origin.protectedChildEvidence, origin) &&
            origin.protectedChildEvidence.entries.some(
                (captured) =>
                    captured.capturedBlockId === entry.capturedBlockId &&
                    samePayloadAssociation(captured, entry),
            )
        )
    })
}

function isChild(
    part: WithParts["parts"][number],
): part is Extract<WithParts["parts"][number], { type: "tool" }> {
    return part.type === "tool" && (part.tool === "task" || part.tool === "subagent")
}
