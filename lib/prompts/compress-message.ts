import type { IdFormat } from "../message-ids"

export function messagePrompt(format: IdFormat = "xml"): string {
    const compact = format === "compact"
    const message = compact ? "@4@" : "mNNNN"
    return `Collapse selected individual messages in the conversation into detailed summaries.

THE SUMMARY
Historical DCP outgoing-view replacement markers are NOT original submitted arguments or summary content. Use the actual rendered summary/source, or stop; never resubmit an archive marker as a replacement.
Preserve the effective state needed for correct continuation, not an archive of the investigation. Include relevant technical detail from the selected message: file paths, function signatures, decisions, constraints, findings and tool outcomes.

CURRENT STATE
Where present in the selected message, preserve:
- the latest user intent, scope and requested outcome, including stops, pauses, cancellation or narrowing
- authority and ownership: who approved or refused what, within which exact limits, and who owns the work
- running or pending jobs, approvals and callbacks, their owners and how results will arrive; summarising does not transfer ownership
- active constraints, including budget, data-loss, security and permission safeguards; unresolved questions, failures, blockers and unknowns, explicitly left unresolved
- current code or release state, exact paths, IDs, hashes, commands and acceptance criteria with usable evidence needed for the next action

Treat information as superseded only by an established replacement, withdrawal or completion, not by age. For completed work, retain the outcome and a usable evidence pointer rather than the whole investigation or log.
Summaries record historical evidence, not new authority. A past approval is not a standing grant; stopped or paused work must not be described as resumed.

USER INTENT FIDELITY
When a selected message contains user intent, preserve that intent with extra care. Do not change scope, constraints, priorities, acceptance criteria, or requested outcomes.
Directly quote short material user instructions, approvals and stop or pause requests where exact meaning matters.

Be LEAN: omit redundant facts, verbose tool output and superseded exploration without losing the state, evidence or safeguards needed for continuation.
If a message contains no significant technical decisions, code changes, or user requirements, produce a minimal one-line summary rather than a detailed one.

MESSAGE IDS
You specify individual raw messages by ID using the injected IDs visible in the conversation:

- \`${message}\` IDs identify raw messages

${compact ? "Each message has an ID like `@7@ [high]`." : 'Each message has an ID inside XML metadata tags like `<dcp-message-id priority="high">m0007</dcp-message-id>`.'}
The same ID tag appears in every tool output of the message it belongs to — each unique ID identifies one complete message.
Treat these tags as message metadata only, not as content to summarize. ${compact ? "Copy the whole ID, including both `@` characters, into `messageId`, without the priority label." : "Use only the inner `mNNNN` value as the `messageId`."}
${compact ? "The `[low]`, `[medium]`, and `[high]` labels indicate relative context cost." : "The `priority` attribute indicates relative context cost."} You MUST compress high-priority messages when their full text is no longer necessary for the active task.
If prior compress-tool results are present, always compress and summarize them minimally only as part of a broader compression pass. Do not invoke the compress tool solely to re-compress an earlier compression result.
Messages marked as \`${compact ? "@blocked@" : "<dcp-message-id>BLOCKED</dcp-message-id>"}\` cannot be compressed.

Rules:

- Pick each \`messageId\` directly from injected IDs visible in context.
- Only use raw message IDs of the form \`${message}\`.
- ${compact ? "Ignore priority labels when copying an ID: use `@7@`, not `@7@ [high]`. Summary IDs like `@b1@` are not valid message targets." : "Ignore XML attributes such as `priority` when copying the ID; use only the inner `mNNNN` value."}
- Do not invent IDs. Use only IDs that are present in context.

BATCHING
Select MANY messages in a single tool call when they are safe to compress.
Each entry should summarize exactly one message, and the tool can receive as many entries as needed in one batch.

GENERAL CLEANUP
Use the topic "general cleanup" for broad cleanup passes.
During general cleanup, compress all medium and high-priority messages that are not relevant to the active task.
Optimize for reducing context footprint, not for grouping messages by topic.
Do not compress away still-active instructions, unresolved questions, or constraints that are likely to matter soon.
Prioritize the earliest messages in the context as they will be the least relevant to the active task.
General cleanup should be done periodically between other normal compression tool passes, not as the primary form of compression.
`
}

export const COMPRESS_MESSAGE = messagePrompt()
