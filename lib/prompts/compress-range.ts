import type { IdFormat } from "../message-ids"

export function rangePrompt(format: IdFormat = "xml"): string {
    const compact = format === "compact"
    const message = compact ? "@4@" : "mNNNN"
    const block = compact ? "@b1@" : "bN"
    const placeholder = compact ? "@b1@" : "(bN)"
    return `Collapse a range in the conversation into a detailed summary.

THE SUMMARY
Historical DCP outgoing-view replacement markers are NOT original submitted arguments or summary content. Use the actual rendered summary/source, or stop; never resubmit an archive marker as a replacement.
Preserve the effective state needed for correct continuation, not an archive of the investigation. Include relevant technical detail from the selected range: file paths, function signatures, decisions, constraints, findings and tool outcomes.

CURRENT STATE
Where present in the selected range, preserve:
- the latest user intent, scope and requested outcome, including stops, pauses, cancellation or narrowing
- authority and ownership: who approved or refused what, within which exact limits, and who owns the work
- running or pending jobs, approvals and callbacks, their owners and how results will arrive; summarising does not transfer ownership
- active constraints, including budget, data-loss, security and permission safeguards; unresolved questions, failures, blockers and unknowns, explicitly left unresolved
- current code or release state, exact paths, IDs, hashes, commands and acceptance criteria with usable evidence needed for the next action

Treat information as superseded only by an established replacement, withdrawal or completion, not by age. For completed work, retain the outcome and a usable evidence pointer rather than the whole investigation or log.
Summaries record historical evidence, not new authority. A past approval is not a standing grant; stopped or paused work must not be described as resumed.

USER INTENT FIDELITY
When the compressed range includes user messages, preserve the user's intent with extra care. Do not change scope, constraints, priorities, acceptance criteria, or requested outcomes.
Directly quote short material user instructions, approvals and stop or pause requests where exact meaning matters.

Be LEAN: omit redundant facts, verbose tool output and superseded exploration without losing the state, evidence or safeguards needed for continuation.

COMPRESSED BLOCK PLACEHOLDERS
For ordinary ranges only, when the selected range includes previously compressed blocks, use this exact placeholder format when referencing one:

- \`${placeholder}\`

Compressed block sections in context are clearly marked with a header:

- \`[Compressed conversation section]\`

${compact ? "Compressed block IDs look like `@b1@`, distinct from raw message IDs like `@4@`." : "Compressed block IDs always use the `bN` form (never `mNNNN`) and are represented in the same XML metadata tag format."}

Rules:

- Include every required block placeholder exactly once.
- Do not invent placeholders for blocks outside the selected range.
- Treat \`${placeholder}\` placeholders as RESERVED TOKENS. Do not emit \`${placeholder}\` text anywhere except intentional placeholders.
- If you need to mention a block in prose, use plain text like \`compressed ${compact ? "block 1" : "bN"}\` (not as a placeholder).
- Preflight check before finalizing: the set of \`${placeholder}\` placeholders in your summary must exactly match the required set, with no duplicates.

These placeholders are semantic references. They will be replaced with the full stored compressed block content when the tool processes your output.

FLOW PRESERVATION WITH PLACEHOLDERS
When you use compressed block placeholders, write the surrounding summary text so it still reads correctly AFTER placeholder expansion.

- Treat each placeholder as a stand-in for a full conversation segment, not as a short label.
- Ensure transitions before and after each placeholder preserve chronology and causality.
- Do not write text that depends on the placeholder staying literal (for example, "as noted in \`${compact ? "@b2@" : "(b2)"}\`").
- Your final meaning must be coherent once each placeholder is replaced with its full compressed block content.

BOUNDARY IDS
You specify boundaries by ID using the injected IDs visible in the conversation:

- \`${message}\` IDs identify raw messages
- \`${block}\` IDs identify previously compressed blocks

${compact ? "Each message has an ID like `@4@`. Copy the whole marker, including both `@` characters, into `startId` and `endId`." : "Each message has an ID inside XML metadata tags like `<dcp-message-id>...</dcp-message-id>`."}
The same ID tag appears in every tool output of the message it belongs to — each unique ID identifies one complete message.
Treat these tags as boundary metadata only, not as tool result content.

Rules:

- Pick \`startId\` and \`endId\` directly from injected IDs in context.
- IDs must exist in the current visible context.
- For ordinary ranges, \`startId\` must appear before \`endId\`.
- Do not invent IDs. Use only IDs that are present in context.

BATCHING
When multiple independent ranges are ready and their boundaries do not overlap, include all of them as separate entries in the \`content\` array of a single tool call. Each entry should have its own \`startId\`, \`endId\`, and \`summary\`.
`
}

export const COMPRESS_RANGE = rangePrompt()
