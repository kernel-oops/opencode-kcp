import assert from "node:assert/strict"
import type { IdFormat } from "../../lib/message-ids"

// Independent snapshot of the established ordered content pass. No frame-aware
// production helper is used to calculate expected segment contents or lengths.
export function stripContentOnce(text: string, format: IdFormat = "xml"): string {
    if (format === "compact") {
        text = text.replace(
            /@(?:[1-9]\d*|b[1-9]\d*|blocked)@(?:[ \t]+\[(?:low|medium|high)\])?/gi,
            "",
        )
    }
    return text
        .replace(/(?<=\n)<dcp-message-id[^>]*>m\d+<\/dcp-message-id>\s*$/, "")
        .replace(/(?<=\n)m\d+<\/parameter>\s*$/, "")
        .replace(/<dcp[^<>]*>[\s\S]*?<\/dcp[^<>]*>/gi, "")
        .replace(/<\/?dcp[^<>]*>/gi, "")
}

export function renderExpectedFrame(prefix: string, body: string, suffix: string): string {
    return `${prefix}${body}${suffix}\n<!-- dcp-subagent-result:v1 ${prefix.length} ${body.length} ${suffix.length} -->`
}

export function expectedFrameParts(output: string) {
    const trailer = /\n<!-- dcp-subagent-result:v1 (\d+) (\d+) (\d+) -->$/.exec(output)
    assert.ok(trailer && trailer.index + trailer[0].length === output.length)
    const [prefixLength, bodyLength, suffixLength] = trailer.slice(1).map(Number)
    assert.ok([prefixLength, bodyLength, suffixLength].every(Number.isSafeInteger))
    assert.equal(prefixLength + bodyLength + suffixLength, trailer.index)
    const prefix = output.slice(0, prefixLength)
    const body = output.slice(prefixLength, prefixLength + bodyLength)
    const suffix = output.slice(prefixLength + bodyLength, trailer.index)
    const open = /<(task_result|subagent)\b[^>]*>\s*$/i.exec(prefix)
    const close = /^\s*<\/(task_result|subagent)>/i.exec(suffix)
    assert.ok(open && close)
    assert.equal(open[1].toLowerCase(), close[1].toLowerCase())
    return { prefix, body, suffix }
}

export function cleanExpectedFrame(output: string, format: IdFormat, replacement?: string): string {
    const { prefix, body, suffix } = expectedFrameParts(output)
    return renderExpectedFrame(
        stripContentOnce(prefix, format),
        stripContentOnce(replacement === undefined ? body : replacement, format),
        stripContentOnce(suffix, format),
    )
}

export function expectedFrameWithRawBody(output: string, body: string): string {
    const frame = expectedFrameParts(output)
    return renderExpectedFrame(frame.prefix, body, frame.suffix)
}
