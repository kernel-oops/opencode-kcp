/**
 * State persistence module for DCP plugin.
 * Persists pruned tool IDs across sessions so they survive OpenCode restarts.
 * Storage location: ~/.local/share/opencode/storage/plugin/dcp/{sessionId}.json
 */

import * as fs from "fs/promises"
import { existsSync } from "fs"
import { homedir } from "os"
import { join, resolve } from "path"
import { randomUUID } from "crypto"
import type { CompressionBlock, PrunedMessageEntry, SessionState, SessionStats } from "./types"
import type { Logger } from "../logger"
import { serializePruneMessagesState } from "./utils"

/** Prune state as stored on disk */
export interface PersistedPruneMessagesState {
    byMessageId: Record<string, PrunedMessageEntry>
    blocksById: Record<string, CompressionBlock>
    activeBlockIds: number[]
    activeByAnchorMessageId: Record<string, number>
    nextBlockId: number
    nextRunId: number
}

export interface PersistedPrune {
    tools?: Record<string, number>
    messages?: PersistedPruneMessagesState
}

export interface PersistedNudges {
    contextLimitAnchors: string[]
    turnNudgeAnchors?: string[]
    iterationNudgeAnchors?: string[]
}

export interface PersistedSessionState {
    sessionName?: string
    manualMode?: boolean
    prune: PersistedPrune
    nudges: PersistedNudges
    stats: SessionStats
    lastUpdated: string
}

const STORAGE_DIR = join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
    "storage",
    "plugin",
    "dcp",
)

async function ensureStorageDir(): Promise<void> {
    if (!existsSync(STORAGE_DIR)) {
        await fs.mkdir(STORAGE_DIR, { recursive: true })
    }
}

function getSessionFilePath(sessionId: string): string {
    return resolve(join(STORAGE_DIR, `${sessionId}.json`))
}

// Different state objects can refer to the same session. Order by file, not object identity.
const writeQueues = new Map<string, Promise<unknown>>()

function queueWrite<T>(filePath: string, write: () => Promise<T>): Promise<T> {
    const pending = (writeQueues.get(filePath) ?? Promise.resolve()).catch(() => {}).then(write)
    writeQueues.set(filePath, pending)
    void pending
        .finally(() => {
            if (writeQueues.get(filePath) === pending) writeQueues.delete(filePath)
        })
        .catch(() => {})
    return pending
}

async function writeFileAtomic(
    filePath: string,
    content: string,
    verify?: () => void,
): Promise<void> {
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
    // Only remove a file we created; an exclusive-open failure does not confer ownership.
    const handle = await fs.open(tempPath, "wx", 0o600)
    try {
        try {
            await handle.writeFile(content, "utf-8")
            await handle.sync()
        } finally {
            await handle.close()
        }
        verify?.()
        await fs.rename(tempPath, filePath)
    } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => {})
        throw error
    }
}

function captureSessionState(
    sessionState: SessionState,
    sessionName?: string,
): PersistedSessionState {
    return {
        sessionName,
        manualMode: !!sessionState.manualMode,
        prune: {
            tools: Object.fromEntries(sessionState.prune.tools),
            messages: serializePruneMessagesState(sessionState.prune.messages),
        },
        nudges: {
            contextLimitAnchors: Array.from(sessionState.nudges.contextLimitAnchors),
            turnNudgeAnchors: Array.from(sessionState.nudges.turnNudgeAnchors),
            iterationNudgeAnchors: Array.from(sessionState.nudges.iterationNudgeAnchors),
        },
        stats: sessionState.stats,
        lastUpdated: new Date().toISOString(),
    }
}

export type SessionCommitOutcome =
    | { committed: true; status: "published"; warning?: unknown }
    | { committed: true; status: "superseded" | "publication-failed"; error: unknown }

/** Rename is the commit point. Callers must not retry a committed outcome. */
export function commitSessionState(
    staged: SessionState,
    logger: Logger,
    transaction: { verify(): void; publish(): void },
): Promise<SessionCommitOutcome> {
    if (!staged.sessionId) throw new Error("Strict commit requires an initialised session")
    const id = staged.sessionId
    const messages = staged.prune.messages
    // Both JSON and proof are immutable before the first queue wait.
    const content = JSON.stringify(captureSessionState(staged), null, 2)
    const persisted = JSON.parse(content) as PersistedSessionState
    const snapshots = new Map(
        Object.entries(persisted.prune.messages!.blocksById).map(([key, block]) => [
            Number(key),
            JSON.stringify(block),
        ]),
    )
    const verifyCaptured = () => {
        const current = captureSessionState(staged)
        current.lastUpdated = persisted.lastUpdated
        if (
            staged.sessionId !== id ||
            staged.prune.messages !== messages ||
            JSON.stringify(current, null, 2) !== content
        )
            throw new Error("Strict staged snapshot changed before publication")
        transaction.verify()
    }
    return queueWrite(getSessionFilePath(id), async (): Promise<SessionCommitOutcome> => {
        verifyCaptured()
        await ensureStorageDir()
        await writeFileAtomic(getSessionFilePath(id), content, verifyCaptured)
        // All exceptions beyond this point describe an already committed file.
        try {
            verifyCaptured()
        } catch (error) {
            return { committed: true, status: "superseded", error }
        }
        try {
            messages.savedBlockSnapshots = snapshots
            transaction.publish()
        } catch (error) {
            messages.savedBlockSnapshots = undefined
            return { committed: true, status: "publication-failed", error }
        }
        try {
            logger.info("Committed session state to disk", { sessionId: id })
        } catch (warning) {
            return { committed: true, status: "published", warning }
        }
        return { committed: true, status: "published" }
    })
}

async function writeSerializedSessionState(
    sessionId: string,
    content: string,
    totalTokensSaved: number,
    logger: Logger,
): Promise<void> {
    await ensureStorageDir()
    await writeFileAtomic(getSessionFilePath(sessionId), content)

    logger.info("Saved session state to disk", {
        sessionId,
        totalTokensSaved,
    })
}

function writePersistedSessionState(
    sessionId: string,
    state: PersistedSessionState,
    logger: Logger,
    written?: () => void,
): Promise<void> {
    // Serialise before any asynchronous wait: nested state and stats remain mutable.
    const content = JSON.stringify(state, null, 2)
    const totalTokensSaved = state.stats.totalPruneTokens
    return queueWrite(getSessionFilePath(sessionId), async () => {
        await writeSerializedSessionState(sessionId, content, totalTokensSaved, logger)
        written?.()
    })
}

export async function saveSessionState(
    sessionState: SessionState,
    logger: Logger,
    sessionName?: string,
): Promise<void> {
    try {
        if (!sessionState.sessionId) {
            return
        }

        const sessionId = sessionState.sessionId
        const messages = sessionState.prune.messages
        const checkpoint = sessionState.lastCompaction

        const state = captureSessionState(sessionState, sessionName)

        // Capture bytes before queueing. Live blocks may change while the rename waits.
        const snapshots = new Map(
            Object.entries(state.prune.messages!.blocksById).map(([id, block]) => [
                Number(id),
                JSON.stringify(block),
            ]),
        )
        await writePersistedSessionState(sessionId, state, logger, () => {
            if (
                sessionState.sessionId === sessionId &&
                sessionState.prune.messages === messages &&
                sessionState.lastCompaction === checkpoint
            )
                messages.savedBlockSnapshots = snapshots
        })
    } catch (error: any) {
        logger.error("Failed to save session state", {
            sessionId: sessionState.sessionId,
            error: error?.message,
        })
    }
}

export async function loadSessionState(
    sessionId: string,
    logger: Logger,
): Promise<PersistedSessionState | null> {
    try {
        const filePath = getSessionFilePath(sessionId)

        if (!existsSync(filePath)) {
            return null
        }

        const content = await fs.readFile(filePath, "utf-8")
        const state = JSON.parse(content) as PersistedSessionState

        const hasPruneTools = state?.prune?.tools && typeof state.prune.tools === "object"
        const hasPruneMessages = state?.prune?.messages && typeof state.prune.messages === "object"
        const hasNudgeFormat = state?.nudges && typeof state.nudges === "object"
        if (
            !state ||
            !state.prune ||
            !hasPruneTools ||
            !hasPruneMessages ||
            !state.stats ||
            !hasNudgeFormat
        ) {
            logger.warn("Invalid session state file, ignoring", {
                sessionId: sessionId,
            })
            return null
        }

        const rawContextLimitAnchors = Array.isArray(state.nudges.contextLimitAnchors)
            ? state.nudges.contextLimitAnchors
            : []
        const validAnchors = rawContextLimitAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedAnchors = [...new Set(validAnchors)]
        if (validAnchors.length !== rawContextLimitAnchors.length) {
            logger.warn("Filtered out malformed contextLimitAnchors entries", {
                sessionId: sessionId,
                original: rawContextLimitAnchors.length,
                valid: validAnchors.length,
            })
        }
        state.nudges.contextLimitAnchors = dedupedAnchors

        const rawTurnNudgeAnchors = Array.isArray(state.nudges.turnNudgeAnchors)
            ? state.nudges.turnNudgeAnchors
            : []
        const validSoftAnchors = rawTurnNudgeAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedSoftAnchors = [...new Set(validSoftAnchors)]
        if (validSoftAnchors.length !== rawTurnNudgeAnchors.length) {
            logger.warn("Filtered out malformed turnNudgeAnchors entries", {
                sessionId: sessionId,
                original: rawTurnNudgeAnchors.length,
                valid: validSoftAnchors.length,
            })
        }
        state.nudges.turnNudgeAnchors = dedupedSoftAnchors

        const rawIterationNudgeAnchors = Array.isArray(state.nudges.iterationNudgeAnchors)
            ? state.nudges.iterationNudgeAnchors
            : []
        const validIterationAnchors = rawIterationNudgeAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedIterationAnchors = [...new Set(validIterationAnchors)]
        if (validIterationAnchors.length !== rawIterationNudgeAnchors.length) {
            logger.warn("Filtered out malformed iterationNudgeAnchors entries", {
                sessionId: sessionId,
                original: rawIterationNudgeAnchors.length,
                valid: validIterationAnchors.length,
            })
        }
        state.nudges.iterationNudgeAnchors = dedupedIterationAnchors

        logger.info("Loaded session state from disk", {
            sessionId: sessionId,
        })

        return state
    } catch (error: any) {
        logger.warn("Failed to load session state", {
            sessionId: sessionId,
            error: error?.message,
        })
        return null
    }
}

function emptyPersistedState(manualMode: boolean): PersistedSessionState {
    return {
        manualMode,
        prune: {
            tools: {},
            messages: {
                byMessageId: {},
                blocksById: {},
                activeBlockIds: [],
                activeByAnchorMessageId: {},
                nextBlockId: 1,
                nextRunId: 1,
            },
        },
        nudges: {
            contextLimitAnchors: [],
            turnNudgeAnchors: [],
            iterationNudgeAnchors: [],
        },
        stats: {
            pruneTokenCounter: 0,
            totalPruneTokens: 0,
        },
        lastUpdated: new Date().toISOString(),
    }
}

export async function loadManualModeSetting(
    sessionId: string,
    logger: Logger,
): Promise<boolean | undefined> {
    const state = await loadSessionState(sessionId, logger)
    return typeof state?.manualMode === "boolean" ? state.manualMode : undefined
}

export async function saveManualModeSetting(
    sessionId: string,
    manualMode: boolean,
    logger: Logger,
): Promise<void> {
    await queueWrite(getSessionFilePath(sessionId), async () => {
        const existing = await loadSessionState(sessionId, logger)
        const state = existing ?? emptyPersistedState(manualMode)
        state.manualMode = manualMode
        state.lastUpdated = new Date().toISOString()
        await writeSerializedSessionState(
            sessionId,
            JSON.stringify(state, null, 2),
            state.stats.totalPruneTokens,
            logger,
        )
    })
}

export interface AggregatedStats {
    totalTokens: number
    totalTools: number
    totalMessages: number
    sessionCount: number
}

export async function loadAllSessionStats(logger: Logger): Promise<AggregatedStats> {
    const result: AggregatedStats = {
        totalTokens: 0,
        totalTools: 0,
        totalMessages: 0,
        sessionCount: 0,
    }

    try {
        if (!existsSync(STORAGE_DIR)) {
            return result
        }

        const files = await fs.readdir(STORAGE_DIR)
        const jsonFiles = files.filter((f) => f.endsWith(".json"))

        for (const file of jsonFiles) {
            try {
                const filePath = join(STORAGE_DIR, file)
                const content = await fs.readFile(filePath, "utf-8")
                const state = JSON.parse(content) as PersistedSessionState

                if (state?.stats?.totalPruneTokens && state?.prune) {
                    result.totalTokens += state.stats.totalPruneTokens
                    result.totalTools += state.prune.tools
                        ? Object.keys(state.prune.tools).length
                        : 0
                    result.totalMessages += state.prune.messages?.byMessageId
                        ? Object.keys(state.prune.messages.byMessageId).length
                        : 0
                    result.sessionCount++
                }
            } catch {
                // Skip invalid files
            }
        }

        logger.debug("Loaded all-time stats", result)
    } catch (error: any) {
        logger.warn("Failed to load all-time stats", { error: error?.message })
    }

    return result
}
