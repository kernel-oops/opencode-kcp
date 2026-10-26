import { tool } from "../tool"
import type { SessionState } from "../state"

export const DEFAULT_MINIMUM_REDUCTION_PERCENT = 10
export function minimumReductionPercentSchema(supported = false) {
    return tool.schema
        .number()
        .finite()
        .min(0)
        .max(100)
        .optional()
        .describe(
            supported
                ? "Optional, default 10. Observe next completed prompt usage after ordinary range compression; advise at or below this percentage reduction. 0 includes flat usage and growth."
                : "Optional finite percentage 0..100, default 10. Accepted here; observation and rewrite advice require supported V2 range mode.",
        )
}
export function validateMinimumReductionPercent(value: unknown): void {
    if (value === undefined) return
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)
        throw new Error(
            "minimumReductionPercent must be a finite number from 0 to 100 when provided",
        )
}
export function isLowYield(before: number, after: number, threshold: number): boolean {
    return (before - after) * 100 <= before * threshold
}
// Public Promise session.context returns native SessionMessageInfo: numeric time.completed,
// not time.streamed (provider-body completion) or the legacy SDK's role/info shape.
interface Entry {
    id: string
    type: string
    agent?: string
    model?: { providerID?: string; id?: string; variant?: string }
    tokens?: { input: number; cache: { read: number; write: number } }
    error?: unknown
    time?: { created?: number; completed?: unknown }
}
function inputTokens(entry: Entry | undefined): number | undefined {
    if (entry?.type !== "assistant" || entry.error !== undefined || !entry.tokens) return
    const values = [entry.tokens.input, entry.tokens.cache?.read, entry.tokens.cache?.write]
    if (!values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0))
        return
    const total = values.reduce((sum, value) => sum + value, 0)
    return Number.isFinite(total) && total > 0 ? total : undefined
}
function sameContext(left: Entry, right: Entry): boolean {
    return (
        typeof left.agent === "string" &&
        !!left.agent &&
        left.agent === right.agent &&
        typeof left.model?.providerID === "string" &&
        !!left.model.providerID &&
        typeof left.model.id === "string" &&
        !!left.model.id &&
        left.model.providerID === right.model?.providerID &&
        left.model.id === right.model.id &&
        (left.model.variant === undefined || typeof left.model.variant === "string") &&
        left.model.variant === right.model.variant
    )
}
/** Native history only: never use the legacy projection's manufactured empty usage. */
export function takeLowYieldAdvisory(
    state: SessionState,
    entries: readonly Entry[],
): string | undefined {
    const pending = state.lowYield
    if (!pending) return
    const index = entries.findIndex((entry) => entry.id === pending.assistantID)
    const baseline = entries[index]
    const successor = index < 0 ? undefined : entries[index + 1]
    if (baseline?.type === "assistant" && !successor) return
    if (
        baseline &&
        successor?.type === "assistant" &&
        sameContext(baseline, successor) &&
        successor.error === undefined &&
        successor.time?.completed === undefined
    )
        return
    state.lowYield = null
    if (
        !baseline ||
        !successor ||
        !sameContext(baseline, successor) ||
        typeof baseline.time?.completed !== "number" ||
        !Number.isFinite(baseline.time.completed) ||
        typeof successor.time?.completed !== "number" ||
        !Number.isFinite(successor.time.completed)
    )
        return
    const before = inputTokens(baseline),
        after = inputTokens(successor)
    if (
        before === undefined ||
        after === undefined ||
        !isLowYield(before, after, pending.threshold)
    )
        return
    return formatLowYieldAdvisory(before, after, pending.threshold)
}
export function formatLowYieldAdvisory(before: number, after: number, threshold: number): string {
    const change =
        after > before
            ? `grew by ${after - before} tokens`
            : after === before
              ? "did not shrink"
              : `shrank by only ${(((before - after) * 100) / before).toFixed(1)}%`
    return `Observed next-prompt input usage (non-cached input plus cache reads/writes) ${change} (${before} → ${after}; threshold ${threshold}%). This is not an isolated causal saving from compression. In supported V2 range mode, consider an explicit rewrite only of eligible visible blocks with proven source, preserving protected content and strictly shrinking the stored summary. Do not resubmit archive markers or ignore failed rewrites.`
}
