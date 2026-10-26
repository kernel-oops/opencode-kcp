import type { CompressionTimingState } from "../compress/timing"
import type { IdFormat } from "../message-ids"
import { Message, Part } from "@opencode-ai/sdk/v2"

export interface WithParts {
    info: Message
    parts: Part[]
}

export type ToolStatus = "pending" | "running" | "completed" | "error"

export interface ToolParameterEntry {
    tool: string
    parameters: any
    metadata?: Record<string, unknown>
    status?: ToolStatus
    error?: string
    turn: number
    tokenCount?: number
}

export interface SessionStats {
    pruneTokenCounter: number
    totalPruneTokens: number
}

export interface PrunedMessageEntry {
    tokenCount: number
    allBlockIds: number[]
    activeBlockIds: number[]
}

export type CompressionMode = "range" | "message"

/** Protected bytes observed at creation; not historical finality or terminal success. */
export interface ProtectedChildEvidence {
    version: 1
    complete: boolean
    entries: Array<{
        capturedBlockId: number
        sourceMessageId: string
        callId: string
        childSessionId: string
        payload: string
        payloadHash: string
    }>
}

export interface CompressionBlock {
    protectedChildEvidence?: ProtectedChildEvidence
    blockId: number
    runId: number
    active: boolean
    deactivatedByUser: boolean
    compressedTokens: number
    summaryTokens: number
    durationMs: number
    mode?: CompressionMode
    topic: string
    batchTopic?: string
    startId: string
    endId: string
    anchorMessageId: string
    compressMessageId: string
    compressCallId?: string
    includedBlockIds: number[]
    consumedBlockIds: number[]
    parentBlockIds: number[]
    directMessageIds: string[]
    directToolIds: string[]
    effectiveMessageIds: string[]
    effectiveToolIds: string[]
    createdAt: number
    deactivatedAt?: number
    deactivatedByBlockId?: number
    summary: string
    /** SHA-256 of the submitted summary before expansion/protected attachments. */
    originalSummaryHash?: string
}

export interface PruneMessagesState {
    /** Last successful primary DCP view only; never a final provider-delivery claim. */
    visibleBlockIds: Set<number>
    /** Runtime-only exact saved block snapshots; never serialised. */
    savedBlockSnapshots?: Map<number, string>
    byMessageId: Map<string, PrunedMessageEntry>
    blocksById: Map<number, CompressionBlock>
    activeBlockIds: Set<number>
    activeByAnchorMessageId: Map<string, number>
    nextBlockId: number
    nextRunId: number
}

export interface Prune {
    tools: Map<string, number>
    messages: PruneMessagesState
}

export interface PendingManualTrigger {
    sessionId: string
    prompt: string
}

export interface MessageIdState {
    byRawId: Map<string, string>
    byRef: Map<string, string>
    nextRef: number
}

export interface Nudges {
    contextLimitAnchors: Set<string>
    turnNudgeAnchors: Set<string>
    iterationNudgeAnchors: Set<string>
}

export interface SessionState {
    idFormat: IdFormat
    sessionId: string | null
    isSubAgent: boolean
    manualMode: false | "active" | "compress-pending"
    compressPermission: "ask" | "allow" | "deny" | undefined
    pendingManualTrigger: PendingManualTrigger | null
    /** Transient observation; deliberately not persisted. */
    lowYield: { assistantID: string; threshold: number } | null
    prune: Prune
    nudges: Nudges
    stats: SessionStats
    compressionTiming: CompressionTimingState
    toolParameters: Map<string, ToolParameterEntry>
    subAgentResultCache: Map<string, string>
    toolIdList: string[]
    messageIds: MessageIdState
    lastCompaction: number
    currentTurn: number
    modelContextLimit: number | undefined
    systemPromptTokens: number | undefined
}
