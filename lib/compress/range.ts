import { tool } from "../tool"
import { minimumReductionPercentSchema } from "./low-yield"
import type { ToolContext } from "./types"
import { countTokens } from "../token-utils"
import { rangeFormat } from "../prompts/extensions/tool"
import { formatMessageRef, formatBlockRef, type IdFormat } from "../message-ids"
import {
    authoriseCompression,
    finalizeSession,
    prepareSession,
    type NotificationEntry,
} from "./pipeline"
import { exclusive } from "../state"
import {
    appendProtectedPromptInfo,
    appendProtectedTools,
    appendProtectedUserMessages,
} from "./protected-content"
import {
    appendMissingBlockSummaries,
    injectBlockPlaceholders,
    parseBlockPlaceholders,
    resolveRanges,
    validateArgs,
    validateNonOverlapping,
    classifyRewrite,
    validateSummaryPlaceholders,
} from "./range-utils"
import {
    COMPRESSED_BLOCK_HEADER,
    allocateBlockId,
    allocateRunId,
    assertPlannedBlockIds,
    peekBlockIds,
    applyCompressionState,
    wrapCompressedSummary,
} from "./state"
import type { CompressRangeToolArgs } from "./types"
import { assembleChildEvidence, type ChildEvidenceCollector } from "./protected-child-evidence"
import { rewriteBlocks, completeRewrite, type RewriteInput } from "./rewrite"

function buildSchema(format: IdFormat, supportsRewrite = false) {
    return {
        minimumReductionPercent: minimumReductionPercentSchema(supportsRewrite),
        topic: tool.schema
            .string()
            .describe("Short label (3-5 words) for display - e.g., 'Auth System Exploration'"),
        content: tool.schema
            .array(
                tool.schema
                    .object({
                        startId: tool.schema
                            .string()
                            .describe(
                                `Message or block ID marking the beginning of range (e.g. ${formatMessageRef(1, format)}, ${formatBlockRef(2, format)})`,
                            ),
                        endId: tool.schema
                            .string()
                            .describe(
                                `Message or block ID marking the end of range (e.g. ${formatMessageRef(12, format)}, ${formatBlockRef(5, format)})`,
                            ),
                        summary: tool.schema
                            .string()
                            .describe("Complete technical summary replacing all content in range"),
                        ...(supportsRewrite ? { rewrite: tool.schema.boolean().optional() } : {}),
                    })
                    .strict(),
            )
            .describe(
                "One or more ranges to compress, each with start/end boundaries and a summary",
            ),
    }
}

export function createCompressRangeTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()
    const runtimePrompts = ctx.prompts.getRuntimePrompts()

    return tool({
        description:
            runtimePrompts.compressRange +
            rangeFormat(ctx.state.idFormat, ctx.supportsRewrite === true),
        args: buildSchema(ctx.state.idFormat, ctx.supportsRewrite === true),
        async execute(args, toolCtx) {
            const input = args as CompressRangeToolArgs
            const rewrite = classifyRewrite(input, ctx.supportsRewrite === true)
            validateArgs(input)
            const callId =
                typeof (toolCtx as unknown as { callID?: unknown }).callID === "string"
                    ? (toolCtx as unknown as { callID: string }).callID
                    : undefined

            if (rewrite)
                return completeRewrite(
                    ctx,
                    toolCtx,
                    await rewriteBlocks(ctx, toolCtx, input as RewriteInput, callId ?? ""),
                    input.topic,
                )

            await authoriseCompression(ctx, toolCtx, `Compress Range: ${input.topic}`)

            return exclusive(ctx.state, async () => {
                const { rawMessages, searchContext } = await prepareSession(ctx, toolCtx)
                // Compression applies only to the state prepared here (see assertPlannedBlockIds).
                const prune = ctx.state.prune.messages
                const resolvedPlans = await resolveRanges(input, searchContext, ctx.state)
                validateNonOverlapping(resolvedPlans)

                const notifications: NotificationEntry[] = []
                const preparedPlans: Array<{
                    entry: (typeof resolvedPlans)[number]["entry"]
                    selection: (typeof resolvedPlans)[number]["selection"]
                    anchorMessageId: string
                    finalSummary: string
                    consumedBlockIds: number[]
                    evidence: ChildEvidenceCollector
                }> = []
                let totalCompressedMessages = 0

                for (const plan of resolvedPlans) {
                    const evidence: ChildEvidenceCollector = []
                    const parsedPlaceholders = parseBlockPlaceholders(
                        plan.entry.summary,
                        ctx.state.idFormat,
                    )
                    const missingBlockIds = validateSummaryPlaceholders(
                        parsedPlaceholders,
                        plan.selection.requiredBlockIds,
                        plan.selection.startReference,
                        plan.selection.endReference,
                        searchContext.summaryByBlockId,
                    )

                    const injected = injectBlockPlaceholders(
                        plan.entry.summary,
                        parsedPlaceholders,
                        searchContext.summaryByBlockId,
                        plan.selection.startReference,
                        plan.selection.endReference,
                    )

                    const summaryWithUsers = appendProtectedUserMessages(
                        injected.expandedSummary,
                        plan.selection,
                        searchContext,
                        ctx.state,
                        ctx.config.compress.protectUserMessages,
                    )

                    const summaryWithPromptInfo = appendProtectedPromptInfo(
                        summaryWithUsers,
                        plan.selection,
                        searchContext,
                        ctx.state,
                        ctx.config.compress.protectTags,
                    )

                    const summaryWithTools = await appendProtectedTools(
                        ctx.client,
                        ctx.state,
                        ctx.config.experimental.allowSubAgents,
                        summaryWithPromptInfo,
                        plan.selection,
                        searchContext,
                        ctx.config.compress.protectedTools,
                        ctx.config.protectedFilePatterns,
                        ctx.nativeInputProof ? evidence : undefined,
                    )

                    const completedSummary = appendMissingBlockSummaries(
                        summaryWithTools,
                        missingBlockIds,
                        searchContext.summaryByBlockId,
                        injected.consumedBlockIds,
                        ctx.state.idFormat,
                    )

                    preparedPlans.push({
                        entry: plan.entry,
                        selection: plan.selection,
                        anchorMessageId: plan.anchorMessageId,
                        finalSummary: completedSummary.expandedSummary,
                        consumedBlockIds: completedSummary.consumedBlockIds,
                        evidence,
                    })
                }

                // Count every final stored summary before applying anything, so a counting
                // failure leaves no partial compression, counters or notifications behind.
                const plannedBlockIds = peekBlockIds(ctx.state, preparedPlans.length)
                const counted: Array<{
                    storedSummary: string
                    summaryTokens: number
                    protectedChildEvidence?: ReturnType<typeof assembleChildEvidence>
                }> = []
                for (const [index, preparedPlan] of preparedPlans.entries()) {
                    const storedSummary = wrapCompressedSummary(
                        plannedBlockIds[index],
                        preparedPlan.finalSummary,
                        ctx.state.idFormat,
                    )
                    const protectedChildEvidence = ctx.nativeInputProof
                        ? assembleChildEvidence(
                              plannedBlockIds[index],
                              storedSummary,
                              preparedPlan.selection.messageIds,
                              preparedPlan.selection.toolIds,
                              preparedPlan.consumedBlockIds.map((id) => prune.blocksById.get(id)),
                              searchContext,
                              preparedPlan.evidence,
                              prune.blocksById,
                          )
                        : undefined
                    counted.push({
                        storedSummary,
                        summaryTokens: await countTokens(storedSummary),
                        protectedChildEvidence,
                    })
                }
                assertPlannedBlockIds(ctx.state, prune, plannedBlockIds)

                const runId = allocateRunId(ctx.state)

                for (const [index, preparedPlan] of preparedPlans.entries()) {
                    const blockId = allocateBlockId(ctx.state)
                    const { storedSummary, summaryTokens, protectedChildEvidence } = counted[index]

                    const applied = applyCompressionState(
                        ctx.state,
                        {
                            topic: input.topic,
                            batchTopic: input.topic,
                            startId: preparedPlan.entry.startId,
                            endId: preparedPlan.entry.endId,
                            mode: "range",
                            runId,
                            compressMessageId: toolCtx.messageID,
                            compressCallId: callId,
                            summaryTokens,
                            ...(ctx.nativeInputProof
                                ? { originalSummary: preparedPlan.entry.summary }
                                : {}),
                            ...(ctx.nativeInputProof
                                ? {
                                      protectedChildEvidence,
                                  }
                                : {}),
                        },
                        preparedPlan.selection,
                        preparedPlan.anchorMessageId,
                        blockId,
                        storedSummary,
                        preparedPlan.consumedBlockIds,
                    )

                    totalCompressedMessages += applied.messageIds.length

                    notifications.push({
                        blockId,
                        runId,
                        summary: preparedPlan.finalSummary,
                        summaryTokens,
                    })
                }

                await finalizeSession(ctx, toolCtx, rawMessages, notifications, input.topic)

                return `Compressed ${totalCompressedMessages} messages into ${COMPRESSED_BLOCK_HEADER}.`
            })
        },
    })
}
