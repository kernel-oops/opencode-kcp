import type { WithParts } from "../state"

const SUB_AGENT_RESULT_BLOCK_REGEX = /(<(task_result|subagent)\b[^>]*>\s*)([\s\S]*?)(\s*<\/\2>)/i

// Offsets are UTF-16 string lengths, not inferred XML boundaries. The anchored
// trailer is outside the verbatim final, which may itself contain any of these tags.
const RESULT_FRAME_PREFIX = "\n<!-- dcp-subagent-result:v1 "
const RESULT_FRAME_REGEX = /\n<!-- dcp-subagent-result:v1 (\d+) (\d+) (\d+) -->$/

function frameResult(prefix: string, body: string, suffix: string): string {
    return `${prefix}${body}${suffix}${RESULT_FRAME_PREFIX}${prefix.length} ${body.length} ${suffix.length} -->`
}

function readResultFrame(output: string): { prefix: string; body: string; suffix: string } | null {
    const frame = RESULT_FRAME_REGEX.exec(output)
    if (frame && frame.index + frame[0].length === output.length) {
        const [start, length, suffixLength] = frame.slice(1).map(Number)
        if (
            [start, length, suffixLength].every(Number.isSafeInteger) &&
            start + length + suffixLength === frame.index
        ) {
            const prefix = output.slice(0, start)
            const suffix = output.slice(start + length, frame.index)
            const open = /<(task_result|subagent)\b[^>]*>\s*$/i.exec(prefix)
            const close = /^\s*<\/(task_result|subagent)>/i.exec(suffix)
            if (open && close && open[1].toLowerCase() === close[1].toLowerCase()) {
                return { prefix, body: output.slice(start, start + length), suffix }
            }
        }
    }
    return null
}

export function transformSubagentResultOutput(
    output: string,
    transform: (text: string) => string,
): string {
    const frame = readResultFrame(output)
    if (!frame) return transform(output)
    // Only the validated outer frame is structural. Nested frame-like child
    // prose stays content, and cleanup cannot match across segment boundaries.
    return frameResult(transform(frame.prefix), transform(frame.body), transform(frame.suffix))
}

export function getSubAgentId(part: any): string | null {
    const sessionId = part?.state?.metadata?.sessionId ?? part?.state?.metadata?.sessionID
    if (typeof sessionId !== "string") {
        return null
    }

    const value = sessionId.trim()
    return value.length > 0 ? value : null
}

export function buildSubagentResultText(messages: WithParts[]): string {
    const assistantMessages = messages.filter((message) => message.info.role === "assistant")
    if (assistantMessages.length === 0) {
        return ""
    }

    const lastAssistant = assistantMessages[assistantMessages.length - 1]
    const lastText = getLastTextPart(lastAssistant)

    if (assistantMessages.length < 2) {
        return lastText
    }

    const secondToLastAssistant = assistantMessages[assistantMessages.length - 2]
    if (!assistantMessageHasCompressTool(secondToLastAssistant)) {
        return lastText
    }

    const secondToLastText = getLastTextPart(secondToLastAssistant)
    return [secondToLastText, lastText].filter((text) => text.length > 0).join("\n\n")
}

export function mergeSubagentResult(
    output: string,
    subAgentResultText: string,
    transformResult?: (text: string) => string,
): string {
    if (!subAgentResultText.trim() || typeof output !== "string") {
        return output
    }
    // Check usability before caller cleanup: a real final consisting only of
    // synthetic IDs must replace the old body with empty text, not leave it stale.
    if (transformResult) subAgentResultText = transformResult(subAgentResultText)

    const frame = readResultFrame(output)
    if (frame) {
        return frameResult(frame.prefix, subAgentResultText, frame.suffix)
    }

    // A malformed frame or ambiguous legacy tags must not cause unknown text to
    // be removed. Keep that receipt intact and append an identified result instead.
    const legacy = SUB_AGENT_RESULT_BLOCK_REGEX.exec(output)
    const tags = [...output.matchAll(/<(\/?)(task_result|subagent)\b[^>]*>/gi)]
    const paired = tags.every((tag, index) =>
        index % 2 === 0
            ? tag[1] === "" &&
              tags[index + 1]?.[1] === "/" &&
              tag[2].toLowerCase() === tags[index + 1][2].toLowerCase()
            : true,
    )
    if (!output.includes(RESULT_FRAME_PREFIX) && legacy && paired) {
        const prefix = output.slice(0, legacy.index) + legacy[1]
        const suffix = legacy[4] + output.slice(legacy.index + legacy[0].length)
        // Raw calls keep the plain legacy format for unambiguous bodies. Ordinary
        // transformed calls need framing even for simple finals: later cleanup
        // must not match a synthetic pair across the receipt/body boundary.
        if (
            !transformResult &&
            !/<\/?(?:task_result|subagent)\b/i.test(subAgentResultText) &&
            !subAgentResultText.includes(RESULT_FRAME_PREFIX)
        ) {
            return `${prefix}${subAgentResultText}${suffix}`
        }
        return frameResult(prefix, subAgentResultText, suffix)
    }

    return frameResult(`${output}\n\n<task_result>\n`, subAgentResultText, "\n</task_result>")
}

function getLastTextPart(message: WithParts): string {
    const parts = Array.isArray(message.parts) ? message.parts : []
    for (let index = parts.length - 1; index >= 0; index--) {
        const part = parts[index]
        if (part.type !== "text" || typeof part.text !== "string") {
            continue
        }

        const text = part.text.trim()
        if (!text) {
            continue
        }

        return text
    }

    return ""
}

function assistantMessageHasCompressTool(message: WithParts): boolean {
    const parts = Array.isArray(message.parts) ? message.parts : []
    return parts.some(
        (part) =>
            part.type === "tool" && part.tool === "compress" && part.state?.status === "completed",
    )
}
