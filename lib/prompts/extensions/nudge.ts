import type { SessionState } from "../../state"
import { formatBlockRef } from "../../message-ids"

export function buildCompressedBlockGuidance(state: SessionState): string {
    const refs = Array.from(state.prune.messages.activeBlockIds)
        .filter((id) => Number.isInteger(id) && id > 0)
        .sort((a, b) => a - b)
        .map((id) => formatBlockRef(id, state.idFormat))
    const blockCount = refs.length
    const blockList = blockCount > 0 ? refs.join(", ") : "none"

    return [
        "Compressed block context:",
        `- Active compressed blocks in this session: ${blockCount} (${blockList})`,
        `- For ordinary range compression that includes a listed block, include each required placeholder exactly once using \`${state.idFormat === "compact" ? "@b1@" : "(bN)"}\`.`,
        "- If the actual tool schema offers explicit rewrite, review visible active-summary prose for obsolete detail: use rewrite: true with both boundaries naming the same eligible active block, a shorter current-state summary and no placeholders; do not wrap/reinsert the old summary when replacing it.",
    ].join("\n")
}

export function renderMessagePriorityGuidance(priorityLabel: string, refs: string[]): string {
    const refList = refs.length > 0 ? refs.join(", ") : "none"

    return [
        "Message priority context:",
        "- Higher-priority older messages consume more context and should be compressed right away if it is safe to do so.",
        `- ${priorityLabel}-priority message IDs before this point: ${refList}`,
    ].join("\n")
}

export function appendGuidanceToDcpTag(nudgeText: string, guidance: string): string {
    if (!guidance.trim()) {
        return nudgeText
    }

    const closeTag = "</dcp-system-reminder>"
    const closeTagIndex = nudgeText.lastIndexOf(closeTag)

    if (closeTagIndex === -1) {
        return nudgeText
    }

    const beforeClose = nudgeText.slice(0, closeTagIndex).trimEnd()
    const afterClose = nudgeText.slice(closeTagIndex)
    return `${beforeClose}\n\n${guidance}\n${afterClose}`
}
