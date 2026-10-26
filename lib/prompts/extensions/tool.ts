// These format schemas are kept separate from the editable compress prompts
// so they cannot be modified via custom prompt overrides. The schemas must
// match the tool's input validation and are not safe to change independently.

import type { IdFormat } from "../../message-ids"

export function rangeFormat(format: IdFormat = "xml", supportsRewrite = false): string {
    const ids = format === "compact" ? "@4@ or @b1@ (include both @ characters)" : "mNNNN or bN"
    return `
THE FORMAT OF COMPRESS
Archive markers in historical outgoing arguments are not summary content or the original submission. Use the actual rendered summary/source, or stop.

\`\`\`
{
  topic: string,           // Short label (3-5 words) - e.g., "Auth System Exploration"
  content: [               // One or more ranges to compress
    {
      startId: string,     // Boundary ID at range start: ${ids}
      endId: string,       // Boundary ID at range end: ${ids}
      summary: string${supportsRewrite ? "," : ""}      // Complete technical summary replacing all content in range${supportsRewrite ? "\n      rewrite?: boolean   // Optional, no default is inserted" : ""}
    }
  ]
}
\`\`\`${
        supportsRewrite
            ? `

EXPLICIT SUMMARY REWRITE — V2 RANGE ONLY
Absent or false means ordinary range compression, including ordinary boundary ordering and old-summary placeholder reinsertion. These ordinary-only instructions do not apply to a true rewrite.
Use rewrite: true on EVERY entry for an explicit rewrite batch; never mix true with absent/false. Each entry's startId and endId must be the SAME active block ID rendered in the latest successful primary DCP view, not raw messages, inactive blocks or archives.
Replacement prose must contain no compressed-block placeholders. Every fully protected, wrapped successor must be strictly smaller under exact DCP tokenisation than its actual predecessor; equality or any growing member rejects the whole batch. Known protected raw output and every attested prior child payload remain verbatim. Missing originals, overlap or incomplete/legacy/cache-only child evidence rejects; current settings or newer child output cannot replace that evidence. Complete evidence concerns protected bytes, not historical or terminal finality.
Lineage is retained, not a permanent archive. Native compaction retires blocks. Do not retry automatically after rejection or a committed/superseded outcome.
`
            : ""
    }`
}

export function messageFormat(format: IdFormat = "xml"): string {
    const ids =
        format === "compact"
            ? "@4@ (include both @ characters; omit priority labels)"
            : "mNNNN (ignore metadata attributes like priority)"
    return `
THE FORMAT OF COMPRESS
Archive markers in historical outgoing arguments are not summary content or the original submission. Use the actual rendered summary/source, or stop.

\`\`\`
{
  topic: string,           // Short label (3-5 words) for the overall batch
  content: [               // One or more messages to compress independently
    {
      messageId: string,   // Raw message ID only: ${ids}
      topic: string,       // Short label (3-5 words) for this one message summary
      summary: string      // Complete technical summary replacing that one message
    }
  ]
}
\`\`\``
}

export const RANGE_FORMAT_EXTENSION = rangeFormat()
export const MESSAGE_FORMAT_EXTENSION = messageFormat()
