import assert from "node:assert/strict"
import test, { after } from "node:test"
import fs from "node:fs/promises"
import { join, resolve } from "node:path"
import { syncBuiltinESMExports } from "node:module"
const root = await fs.mkdtemp(resolve(".impl-private/c2-"))
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "TMPDIR", "OPENCODE_CONFIG_DIR"]) {
    process.env[key] = join(root, key)
    await fs.mkdir(process.env[key]!, { recursive: true })
}
after(() => fs.rm(root, { recursive: true, force: true }))
const { createSessionState, saveSessionState, loadSessionState, exclusive, saveManualModeSetting } =
    await import("../lib/state")
const { loadPruneMessagesState, serializePruneMessagesState, resetOnCompaction } =
    await import("../lib/state/utils")
const { applyCompressionState, wrapCompressedSummary } = await import("../lib/compress/state")
const { rewriteBlocks, completeRewrite } = await import("../lib/compress/rewrite")
const { prune } = await import("../lib/messages/prune")
const { tokenCounter } = await import("../lib/token-counter")
const { Logger } = await import("../lib/logger")
const { summaryHash } = await import("../lib/compress/summary")
const { mergeSubagentResult } = await import("../lib/subagents/subagent-results")
let counted: string[] = []
const exactCount = tokenCounter.count.bind(tokenCounter)
tokenCounter.count = async (text) => {
    counted.push(text)
    return text.length
}
let next = 0
function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>((done) => (resolve = done))
    return { resolve, promise }
}
async function fixture(child = false, count = 1) {
    const state = createSessionState("compact"),
        logger = new Logger(false)
    state.sessionId = `rewrite-${++next}`
    state.compressPermission = "allow"
    const raw: any[] = [
        {
            info: {
                id: "user",
                sessionID: state.sessionId,
                role: "user",
                time: { created: 1 },
                agent: "build",
                model: { providerID: "fixture", modelID: "fixture" },
            },
            parts: [{ type: "text", text: "Protected original user" }],
        },
    ]
    const config: any = {
        compress: {
            mode: "range",
            protectUserMessages: false,
            protectTags: false,
            protectedTools: [],
        },
        experimental: { allowSubAgents: true },
        protectedFilePatterns: [],
        manualMode: { enabled: false },
    }
    const payload = mergeSubagentResult(
        "RAW RECEIPT",
        "A </task_result> literal 🐈\n<!-- dcp-subagent-result:v1 1 2 3 -->",
    )
    for (let index = 1; index <= count; index++) {
        const id = `source-${index}`,
            call = `tool-${index}`
        raw.push({
            info: {
                id,
                sessionID: state.sessionId,
                role: "assistant",
                time: { created: 2 + index },
            },
            parts: [
                {
                    type: "tool",
                    tool: child ? "task" : "read",
                    callID: call,
                    state: {
                        status: "completed",
                        input: {},
                        output: "RAW RECEIPT",
                        metadata: child ? { sessionId: "child" } : {},
                    },
                },
            ],
        })
        const stored = wrapCompressedSummary(
            index,
            "Old narrative. ".repeat(150) + (child ? payload : ""),
            "compact",
        )
        applyCompressionState(
            state,
            {
                topic: "Old",
                batchTopic: "Old",
                startId: `@${index}@`,
                endId: `@${index}@`,
                mode: "range",
                runId: index,
                compressMessageId: `origin-${index}`,
                compressCallId: `compress-${index}`,
                summaryTokens: 999,
                ...(child
                    ? {
                          protectedChildEvidence: {
                              version: 1,
                              complete: true,
                              entries: [
                                  {
                                      capturedBlockId: index,
                                      sourceMessageId: id,
                                      callId: call,
                                      childSessionId: "child",
                                      payload,
                                      payloadHash: summaryHash(payload),
                                  },
                              ],
                          },
                      }
                    : {}),
            },
            {
                messageIds: [id],
                toolIds: [call],
                messageTokenById: new Map([[id, 10]]),
                requiredBlockIds: [],
                startReference: { kind: "message", rawIndex: index },
                endReference: { kind: "message", rawIndex: index },
            },
            id,
            index,
            stored,
            [],
        )
        raw.push({
            info: {
                id: `origin-${index}`,
                sessionID: state.sessionId,
                role: "assistant",
                time: { created: 5 + index },
            },
            parts: [
                {
                    type: "tool",
                    tool: "compress",
                    callID: `compress-${index}`,
                    state: { status: "completed", input: {}, output: "Compressed" },
                },
            ],
        })
    }
    state.prune.messages.nextBlockId = count + 1
    state.prune.messages.nextRunId = count + 1
    await saveSessionState(state, logger)
    const stored = await loadSessionState(state.sessionId!, logger)
    state.prune.messages = await loadPruneMessagesState(stored!.prune.messages)
    assert.equal(state.prune.messages.savedBlockSnapshots!.size, count)
    assert.equal(state.prune.messages.visibleBlockIds.size, 0)
    state.prune.messages.visibleBlockIds = prune(state, logger, config, structuredClone(raw))
    assert.equal(state.prune.messages.visibleBlockIds.size, count)
    let childReads = 0
    const ctx: any = {
        state,
        logger,
        config,
        nativeInputProof: true,
        supportsRewrite: true,
        prompts: {},
        client: {
            session: {
                messages: async ({ path }: any) => {
                    if (path.id !== state.sessionId) {
                        childReads++
                        throw new Error("Latest child B/read failure must not be requested")
                    }
                    return { data: raw }
                },
            },
        },
    }
    const tool = {
        sessionID: state.sessionId!,
        messageID: "new-origin",
        ask: async () => {},
        metadata: () => {},
    }
    const input: any = {
        topic: "Rewrite",
        content: Array.from({ length: count }, (_, i) => ({
            startId: `@b${i + 1}@`,
            endId: `@b${i + 1}@`,
            summary: "Short",
            rewrite: true,
        })),
    }
    const file = join(
        process.env.XDG_DATA_HOME!,
        "opencode/storage/plugin/dcp",
        `${state.sessionId}.json`,
    )
    return { state, raw, ctx, tool, input, file, childReads: () => childReads, payload }
}
function snapshot(value: Awaited<ReturnType<typeof fixture>>) {
    const state = value.state
    return JSON.stringify({
        prune: serializePruneMessagesState(state.prune.messages),
        proof: [...state.prune.messages.savedBlockSnapshots!],
        visible: [...state.prune.messages.visibleBlockIds],
        refs: [...state.messageIds.byRawId],
        stats: state.stats,
        pending: state.pendingManualTrigger,
        manual: state.manualMode,
        cache: [...state.subAgentResultCache],
    })
}
async function unchanged(value: Awaited<ReturnType<typeof fixture>>, run: () => Promise<unknown>) {
    const before = snapshot(value),
        bytes = await fs.readFile(value.file, "utf8"),
        prune = value.state.prune.messages,
        stats = value.state.stats
    await assert.rejects(run)
    assert.equal(snapshot(value), before)
    assert.equal(value.state.prune.messages, prune)
    assert.equal(value.state.stats, stats)
    assert.equal(await fs.readFile(value.file, "utf8"), bytes)
}
test("strict shrink recounts actual strings, preserves lineage, raw counters and no new visibility", async () => {
    const value = await fixture()
    value.state.stats.pruneTokenCounter = 9
    const stats = structuredClone(value.state.stats)
    counted = []
    const result = await rewriteBlocks(value.ctx, value.tool, value.input, "new-call")
    assert.equal(result.status, "published")
    const old = value.state.prune.messages.blocksById.get(1)!,
        successor = value.state.prune.messages.blocksById.get(2)!
    assert.deepEqual(counted, [old.summary, successor.summary])
    assert.equal(result.entries[0].previousSummaryTokens, old.summary.length)
    assert.equal(successor.summaryTokens, successor.summary.length)
    assert.equal(old.active, false)
    assert.ok(old.summary.includes("Old narrative"))
    assert.ok(!successor.summary.includes("Old narrative"))
    assert.deepEqual(successor.consumedBlockIds, [1])
    assert.deepEqual(successor.includedBlockIds, [1])
    assert.deepEqual(old.parentBlockIds, [2])
    for (const field of [
        "startId",
        "endId",
        "anchorMessageId",
        "effectiveMessageIds",
        "effectiveToolIds",
    ] as const)
        assert.deepEqual(successor[field], old[field])
    assert.deepEqual(successor.directMessageIds, [])
    assert.deepEqual(successor.directToolIds, [])
    assert.equal(successor.compressedTokens, 0)
    assert.deepEqual(value.state.stats, stats)
    assert.equal(value.state.prune.messages.visibleBlockIds.size, 0)
    assert.equal(value.state.prune.messages.savedBlockSnapshots!.get(2), JSON.stringify(successor))
    assert.equal(
        "visibleBlockIds" in JSON.parse(await fs.readFile(value.file, "utf8")).prune.messages,
        false,
    )
})

for (const counter of ["nextBlockId", "nextRunId"] as const)
    for (const value of [
        0,
        -1,
        1.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        Number.MAX_SAFE_INTEGER,
        "2",
        null,
    ])
        test(`strict allocation rejects ${counter}=${String(value)} before counts or publication`, async () => {
            const f = await fixture()
            ;(f.state.prune.messages as any)[counter] = value
            let notifications = 0
            f.ctx.config.pruneNotification = "detailed"
            f.ctx.client.tui = {
                showToast: async () => {
                    notifications++
                },
            }
            f.state.manualMode = "compress-pending"
            f.state.pendingManualTrigger = { sessionId: f.state.sessionId!, prompt: "pending" }
            const old = f.state.prune.messages.blocksById.get(1),
                proof = f.state.prune.messages.savedBlockSnapshots
            counted = []
            await unchanged(f, () => rewriteBlocks(f.ctx, f.tool, f.input, "invalid-allocation"))
            assert.deepEqual(counted, [])
            assert.ok(Object.is((f.state.prune.messages as any)[counter], value))
            assert.equal(notifications, 0)
            assert.equal(f.state.prune.messages.blocksById.get(1), old)
            assert.equal(f.state.prune.messages.savedBlockSnapshots, proof)
        })

for (const kind of [
    "target",
    "unselected",
    "inactive",
    "run-reuse",
    "inactive-run",
    "batch-overflow",
    "dangling-index",
] as const)
    test(`strict allocation protects all stored/indexed identities: ${kind}`, async () => {
        const f = await fixture(
            false,
            kind === "target" || kind === "run-reuse" || kind === "dangling-index" ? 1 : 2,
        )
        if (kind === "target") f.state.prune.messages.nextBlockId = 1
        if (kind === "unselected" || kind === "inactive") {
            f.input.content.pop()
            f.state.prune.messages.nextBlockId = 2
            if (kind === "inactive") {
                f.state.prune.messages.blocksById.get(2)!.active = false
                f.state.prune.messages.activeBlockIds.delete(2)
                f.state.prune.messages.activeByAnchorMessageId.delete("source-2")
                f.state.prune.messages.byMessageId.get("source-2")!.activeBlockIds = []
            }
        }
        if (kind === "run-reuse") f.state.prune.messages.nextRunId = 1
        if (kind === "inactive-run") {
            f.input.content.pop()
            f.state.prune.messages.blocksById.get(2)!.runId = 99
            f.state.prune.messages.blocksById.get(2)!.active = false
            f.state.prune.messages.activeBlockIds.delete(2)
            f.state.prune.messages.activeByAnchorMessageId.delete("source-2")
            f.state.prune.messages.byMessageId.get("source-2")!.activeBlockIds = []
        }
        if (kind === "batch-overflow")
            f.state.prune.messages.nextBlockId = Number.MAX_SAFE_INTEGER - 1
        if (kind === "dangling-index")
            f.state.prune.messages.byMessageId.get("source-1")!.allBlockIds.push(99)
        const originals = new Map(f.state.prune.messages.blocksById)
        counted = []
        await unchanged(f, () => rewriteBlocks(f.ctx, f.tool, f.input, "invalid-allocation"))
        assert.deepEqual(counted, [])
        for (const [id, record] of originals)
            assert.equal(f.state.prune.messages.blocksById.get(id), record)
    })

test("strict occupancy is revalidated after counts even when serialised numeric keys conceal insertion", async (t) => {
    const f = await fixture(),
        entered = deferred(),
        release = deferred(),
        originalCount = tokenCounter.count
    const old = f.state.prune.messages.blocksById.get(1)!,
        before = await fs.readFile(f.file, "utf8")
    tokenCounter.count = async (text) => {
        entered.resolve()
        await release.promise
        return text.length
    }
    t.after(() => (tokenCounter.count = originalCount))
    const pending = rewriteBlocks(f.ctx, f.tool, f.input, "inserted")
    await entered.promise
    // Object.fromEntries serialises both keys as "1"; counter values have not moved.
    ;(f.state.prune.messages.blocksById as Map<any, any>).set("1", old)
    release.resolve()
    await assert.rejects(pending, /allocation/)
    assert.equal(f.state.prune.messages.blocksById.get(1), old)
    assert.equal(f.state.prune.messages.nextBlockId, 2)
    assert.equal(await fs.readFile(f.file, "utf8"), before)
})

test("strict occupancy is revalidated immediately before rename without repairing external insertion", async (t) => {
    const f = await fixture(),
        before = await fs.readFile(f.file, "utf8"),
        open = fs.open
    const old = f.state.prune.messages.blocksById.get(1)!,
        proof = f.state.prune.messages.savedBlockSnapshots
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args),
            sync = handle.sync.bind(handle)
        handle.sync = async () => {
            await sync()
            ;(f.state.prune.messages.blocksById as Map<any, any>).set("1", old)
        }
        return handle
    })
    syncBuiltinESMExports()
    t.after(() => {
        t.mock.restoreAll()
        syncBuiltinESMExports()
    })
    await assert.rejects(rewriteBlocks(f.ctx, f.tool, f.input, "inserted"), /allocation/)
    assert.equal(f.state.prune.messages.blocksById.get(1), old)
    assert.equal(f.state.prune.messages.savedBlockSnapshots, proof)
    assert.equal(await fs.readFile(f.file, "utf8"), before)
    assert.deepEqual(
        (await fs.readdir(join(f.file, ".."))).filter((name) => name.endsWith(".tmp")),
        [],
    )
})
test("complete prior A and raw receipt survive opaquely with latest child inaccessible and current protections disabled", async () => {
    const value = await fixture(true)
    value.state.subAgentResultCache.set("tool-1", "Latest B")
    const result = await rewriteBlocks(value.ctx, value.tool, value.input, "new-call")
    assert.equal(result.status, "published")
    assert.equal(value.childReads(), 0)
    const successor = value.state.prune.messages.blocksById.get(2)!
    assert.ok(successor.summary.includes(value.payload))
    assert.ok(successor.summary.includes("RAW RECEIPT"))
    assert.ok(!successor.summary.includes("Latest B"))
    assert.equal(successor.protectedChildEvidence!.entries[0].capturedBlockId, 1)
})

test("successful commit publishes detached manual refresh without re-enabling a stale live setting", async () => {
    const value = await fixture()
    value.state.manualMode = "active"
    assert.equal(
        (await rewriteBlocks(value.ctx, value.tool, value.input, "new-call")).status,
        "published",
    )
    assert.equal(value.state.manualMode, false)
    assert.equal(
        (await loadSessionState(value.state.sessionId!, value.ctx.logger))!.manualMode,
        false,
    )
})

test("session identity is checked again after permission waits", async () => {
    const value = await fixture(),
        before = await fs.readFile(value.file, "utf8")
    value.tool.ask = async () => {
        value.state.sessionId = "another-session"
    }
    await assert.rejects(
        rewriteBlocks(value.ctx, value.tool, value.input, "new-call"),
        /session changed during authorisation/,
    )
    assert.equal(value.state.prune.messages.blocksById.size, 1)
    assert.equal(value.state.prune.messages.nextBlockId, 2)
    assert.equal(await fs.readFile(value.file, "utf8"), before)
})

test("post-commit notifications separate summary metrics and cannot undo a committed rewrite", async () => {
    const value = await fixture()
    value.ctx.config.pruneNotification = "detailed"
    value.ctx.config.pruneNotificationType = "toast"
    const notices: string[] = []
    value.ctx.client.tui = { showToast: async ({ body }: any) => notices.push(body.message) }
    const result = await rewriteBlocks(value.ctx, value.tool, value.input, "new-call")
    assert.equal(notices.length, 0)
    assert.match(await completeRewrite(value.ctx, value.tool, result, "Rewrite"), /Rewrote/)
    assert.equal(notices.length, 1)
    assert.match(notices[0], /old summary tokens/)
    assert.match(notices[0], /net DCP summary-token reduction; 0 new raw messages pruned/)
    value.ctx.client.tui.showToast = async () => {
        throw new Error("notification unavailable")
    }
    assert.match(await completeRewrite(value.ctx, value.tool, result, "Rewrite"), /Rewrote/)
    assert.equal(value.state.prune.messages.blocksById.get(2)!.active, true)
})
for (const [name, mutate] of [
    ["growth", (v: any) => (v.input.content[0].summary = "long ".repeat(2000))],
    ["nonvisible", (v: any) => v.state.prune.messages.visibleBlockIds.clear()],
    ["unsupported context", (v: any) => delete v.ctx.nativeInputProof],
    ["missing adapter opt-in", (v: any) => delete v.ctx.supportsRewrite],
    ["unsupported message mode", (v: any) => (v.ctx.config.compress.mode = "message")],
    ["unsupported false", (v: any) => (v.input.content[0].rewrite = false)],
    ["raw reference", (v: any) => (v.input.content[0].startId = "@1@")],
    ["different endpoints", (v: any) => (v.input.content[0].endId = "@b9@")],
    ["placeholder", (v: any) => (v.input.content[0].summary = "Rewrite (b1)")],
    ["compact placeholder", (v: any) => (v.input.content[0].summary = "Rewrite @b1@")],
    ["missing original", (v: any) => v.raw.splice(1, 1)],
    ["missing origin", (v: any) => v.raw.pop()],
    [
        "stale historical index",
        (v: any) => v.state.prune.messages.byMessageId.get("source-1").allBlockIds.push(99),
    ],
    ["duplicate original", (v: any) => v.raw.push(v.raw[1])],
    [
        "invalid child proof",
        (v: any) =>
            (v.state.prune.messages.blocksById.get(1).protectedChildEvidence.complete = false),
    ],
] as const)
    test(`${name} rejects without shared preparation or disk changes`, async () => {
        const value = await fixture(name === "invalid child proof")
        mutate(value)
        counted = []
        await unchanged(value, () => rewriteBlocks(value.ctx, value.tool, value.input, "new-call"))
        if (name !== "growth") assert.equal(counted.length, 0)
    })
test("one growing member rejects the batch and selected/unselected actual coverage overlap rejects", async () => {
    const value = await fixture(false, 2)
    value.input.content[1].summary = "growth ".repeat(2000)
    await unchanged(value, () => rewriteBlocks(value.ctx, value.tool, value.input, "new-call"))
    const overlap = await fixture(false, 2)
    overlap.input.content.pop()
    overlap.state.prune.messages.blocksById.get(2)!.effectiveMessageIds.push("source-1")
    await unchanged(overlap, () =>
        rewriteBlocks(overlap.ctx, overlap.tool, overlap.input, "new-call"),
    )
})

test("all members must shrink; equality, duplicates and the full protected floor reject", async () => {
    const success = await fixture(false, 2)
    assert.equal(
        (await rewriteBlocks(success.ctx, success.tool, success.input, "new-call")).status,
        "published",
    )
    assert.deepEqual([...success.state.prune.messages.activeBlockIds], [3, 4])
    const equal = await fixture()
    equal.state.prune.messages.blocksById.get(1)!.summary = wrapCompressedSummary(
        1,
        "Short",
        "compact",
    )
    await saveSessionState(equal.state, equal.ctx.logger)
    await unchanged(equal, () => rewriteBlocks(equal.ctx, equal.tool, equal.input, "new-call"))
    const duplicate = await fixture()
    duplicate.input.content.push({ ...duplicate.input.content[0] })
    await unchanged(duplicate, () =>
        rewriteBlocks(duplicate.ctx, duplicate.tool, duplicate.input, "new-call"),
    )
    const floor = await fixture()
    floor.ctx.config.compress.protectedTools = ["read"]
    floor.raw[1].parts[0].state.output = "Non-droppable raw protection ".repeat(500)
    await unchanged(floor, () => rewriteBlocks(floor.ctx, floor.tool, floor.input, "new-call"))
})

test("legacy, cache-only and incomplete child evidence cannot be rescued by an apparently complete raw receipt", async () => {
    for (const metadata of [
        undefined,
        { version: 1, complete: false, entries: [] },
        { version: 99, complete: true, entries: [] },
    ]) {
        const value = await fixture(true)
        value.state.prune.messages.blocksById.get(1)!.protectedChildEvidence = metadata as any
        value.state.subAgentResultCache.set("tool-1", value.payload)
        value.raw[1].parts[0].state.output = value.payload
        await saveSessionState(value.state, value.ctx.logger)
        await unchanged(value, () => rewriteBlocks(value.ctx, value.tool, value.input, "new-call"))
        assert.equal(value.childReads(), 0)
    }
})
test("count failure and in-place target change during awaited counting never publish", async (t) => {
    const value = await fixture()
    const original = tokenCounter.count
    t.after(() => (tokenCounter.count = original))
    tokenCounter.count = async () => {
        throw new Error("synthetic count failure")
    }
    await unchanged(value, () => rewriteBlocks(value.ctx, value.tool, value.input, "new-call"))
    const held = deferred(),
        entered = deferred()
    tokenCounter.count = async (text) => {
        entered.resolve()
        await held.promise
        return text.length
    }
    const pending = rewriteBlocks(value.ctx, value.tool, value.input, "new-call")
    await entered.promise
    value.state.prune.messages.blocksById.get(1)!.summary += "outside mutation"
    held.resolve()
    await assert.rejects(pending, /changed/)
    assert.equal(value.state.prune.messages.blocksById.size, 1)
})

test("production DCP tokenizer confirms a real strict shrink rather than saved count or character estimates", async (t) => {
    const value = await fixture(),
        previous = tokenCounter.count
    t.after(() => (tokenCounter.count = previous))
    tokenCounter.count = exactCount
    const old = value.state.prune.messages.blocksById.get(1)!.summary
    const result = await rewriteBlocks(value.ctx, value.tool, value.input, "new-call")
    const successor = value.state.prune.messages.blocksById.get(2)!
    assert.equal(result.status, "published")
    assert.equal(result.entries[0].previousSummaryTokens, await exactCount(old))
    assert.equal(successor.summaryTokens, await exactCount(successor.summary))
    assert.ok(successor.summaryTokens < result.entries[0].previousSummaryTokens)
})

test("raw protections span all nested effective originals and retain trailing bytes", async () => {
    const value = await fixture(false, 2)
    const user = "Exact user text <protect>tagged bytes</protect>  \n\t"
    const tool = "Raw tool output 🐈  \n\t"
    value.raw[0].parts[0].text = user
    value.raw[1].parts[0].state.output = tool
    const old = wrapCompressedSummary(3, "Nested old narrative ".repeat(300), "compact")
    applyCompressionState(
        value.state,
        {
            topic: "Nested",
            batchTopic: "Nested",
            startId: "@1@",
            endId: "@2@",
            mode: "range",
            runId: 3,
            compressMessageId: "origin-3",
            compressCallId: "compress-3",
            summaryTokens: old.length,
        },
        {
            messageIds: ["user"],
            toolIds: [],
            messageTokenById: new Map([["user", 1]]),
            requiredBlockIds: [],
            startReference: { kind: "message", rawIndex: 0 },
            endReference: { kind: "message", rawIndex: 4 },
        },
        "source-2",
        3,
        old,
        [1, 2],
    )
    value.raw.push({
        info: {
            id: "origin-3",
            sessionID: value.state.sessionId,
            role: "assistant",
            time: { created: 20 },
        },
        parts: [
            {
                type: "tool",
                tool: "compress",
                callID: "compress-3",
                state: { status: "completed", input: {}, output: "Compressed" },
            },
        ],
    })
    value.state.prune.messages.nextBlockId = 4
    value.state.prune.messages.nextRunId = 4
    await saveSessionState(value.state, value.ctx.logger)
    value.state.prune.messages = await loadPruneMessagesState(
        (await loadSessionState(value.state.sessionId!, value.ctx.logger))!.prune.messages,
    )
    value.state.prune.messages.visibleBlockIds = prune(
        value.state,
        value.ctx.logger,
        value.ctx.config,
        structuredClone(value.raw),
    )
    value.ctx.config.compress.protectUserMessages = true
    value.ctx.config.compress.protectTags = true
    value.ctx.config.compress.protectedTools = ["read"]
    value.input.content = [{ startId: "@b3@", endId: "@b3@", summary: "Short", rewrite: true }]
    const native = structuredClone(value.raw)
    assert.equal(
        (await rewriteBlocks(value.ctx, value.tool, value.input, "new-call")).status,
        "published",
    )
    const summary = value.state.prune.messages.blocksById.get(4)!.summary
    assert.ok(summary.includes(user))
    assert.ok(summary.includes("tagged bytes"))
    assert.ok(summary.includes(tool))
    assert.ok(summary.includes("RAW RECEIPT"))
    assert.deepEqual(value.raw, native)
})
for (const operation of ["open", "writeFile", "sync", "close", "rename"] as const)
    test(`strict ${operation} failure preserves old file/state/proof and cleans owned temporary files`, async (t) => {
        const value = await fixture()
        const originalOpen = fs.open
        if (operation === "rename")
            t.mock.method(fs, "rename", async () => {
                throw new Error("synthetic rename")
            })
        else
            t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
                if (operation === "open") throw new Error("synthetic open")
                const handle = await originalOpen(...args)
                const originalClose = handle.close.bind(handle)
                if (operation === "close")
                    handle.close = async () => {
                        await originalClose()
                        throw new Error("synthetic close")
                    }
                else
                    (handle as any)[operation] = async () => {
                        throw new Error(`synthetic ${operation}`)
                    }
                return handle
            })
        syncBuiltinESMExports()
        t.after(() => {
            t.mock.restoreAll()
            syncBuiltinESMExports()
        })
        value.state.manualMode = "compress-pending"
        value.state.pendingManualTrigger = { sessionId: value.state.sessionId!, prompt: "pending" }
        await unchanged(value, () => rewriteBlocks(value.ctx, value.tool, value.input, "new-call"))
        assert.deepEqual(
            (await fs.readdir(join(value.file, ".."))).filter((file) => file.endsWith(".tmp")),
            [],
        )
    })
test("forced successful-rename supersession is committed, suppresses stale publication/proof and does not retry", async (t) => {
    const value = await fixture(),
        original = fs.rename
    let renames = 0
    t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        renames++
        await original(...args)
        resetOnCompaction(value.state)
    })
    syncBuiltinESMExports()
    t.after(() => {
        t.mock.restoreAll()
        syncBuiltinESMExports()
    })
    const result = await rewriteBlocks(value.ctx, value.tool, value.input, "new-call")
    assert.equal(result.committed, true)
    assert.equal(result.status, "superseded")
    assert.equal(renames, 1)
    assert.equal(value.state.prune.messages.blocksById.size, 0)
    assert.equal(value.state.prune.messages.savedBlockSnapshots, undefined)
    assert.ok(JSON.parse(await fs.readFile(value.file, "utf8")).prune.messages.blocksById["2"])
})
test("queued supported reset waits for rewrite; pending mode is consumed only on commit", async (t) => {
    const value = await fixture(),
        entered = deferred(),
        release = deferred(),
        original = fs.rename
    t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        entered.resolve()
        await release.promise
        return original(...args)
    })
    syncBuiltinESMExports()
    t.after(() => {
        t.mock.restoreAll()
        syncBuiltinESMExports()
    })
    value.state.manualMode = "compress-pending"
    value.state.pendingManualTrigger = { sessionId: value.state.sessionId!, prompt: "pending" }
    const pending = rewriteBlocks(value.ctx, value.tool, value.input, "new-call")
    await entered.promise
    assert.equal(value.state.prune.messages.blocksById.size, 1)
    assert.equal(value.state.manualMode, "compress-pending")
    let reset = false
    const queued = exclusive(value.state, async () => {
        reset = true
        assert.equal(value.state.manualMode, false)
        resetOnCompaction(value.state)
    })
    assert.equal(reset, false)
    release.resolve()
    assert.equal((await pending).status, "published")
    await queued
    assert.equal(value.state.prune.messages.visibleBlockIds.size, 0)
})
