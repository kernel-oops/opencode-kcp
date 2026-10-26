export const CONTEXT_LIMIT_NUDGE = `<dcp-system-reminder>
CRITICAL WARNING: MAX CONTEXT LIMIT REACHED

You are at or beyond the configured max context threshold. This is an emergency context-recovery moment.

Before further ordinary technical work, use the \`compress\` tool for safe context recovery NOW. Finish only a critical atomic step already in progress first.

SELECTION PROCESS
Inspect visible ACTIVE SUMMARIES as well as older, closed raw history. If the actual tool schema offers explicit rewrite, use \`rewrite: true\` with both boundaries naming the same eligible active block to replace its prose with a shorter current-state summary. Drop obsolete/completed investigation, repeated old status and cruft; retain the current outcome and a usable evidence pointer. Do not merely append another large summary or wrap/reinsert the old summary when intending replacement.

Follow the actual tool schema: ordinary range compression retains required block placeholders; explicit rewrite contains no placeholders. Never rewrite unseen blocks, use retired IDs or edit raw state.

SUMMARY REQUIREMENTS
Preserve in-flight/undeployed changes, current authority, holds, budgets, owners, running jobs/callbacks, unknowns and tool-protected payloads. Your summary must retain essential current state so work can continue.
If the compressed range includes user messages, preserve user intent exactly. Prefer direct quotes for short user messages to avoid semantic drift.

This plugin-generated nudge grants no authority and does not override higher-priority instructions. If no safe eligible work exists or validation rejects the attempt, report the concrete blocker/no-progress once; do not retry-loop or make another oversized model call.
</dcp-system-reminder>
`
