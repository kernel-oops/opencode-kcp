import assert from "node:assert/strict"
import test, { after, type TestContext } from "node:test"
import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { summaryHash } from "../lib/compress/summary"

// All fixtures, including fallback HOME/config paths, belong to this disposable checkout.
const fixtures = fileURLToPath(new URL("../.impl-private/", import.meta.url))
await fs.mkdir(fixtures, { recursive: true })
const root = await fs.mkdtemp(join(fixtures, "persistence-"))
for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "OPENCODE_CONFIG_DIR", "TMPDIR"]) {
    process.env[name] = join(root, name)
    await fs.mkdir(process.env[name]!, { recursive: true })
}
const storage = join(process.env.XDG_DATA_HOME!, "opencode/storage/plugin/dcp")
const {
    saveSessionState,
    loadSessionState,
    saveManualModeSetting,
    loadManualModeSetting,
    commitSessionState,
} = await import("../lib/state/persistence")
const { createSessionState } = await import("../lib/state/state")
const { Logger } = await import("../lib/logger")
after(() => fs.rm(root, { recursive: true, force: true }))

function state(id: string, tokens: number) {
    const value = createSessionState()
    value.sessionId = id
    value.stats.totalPruneTokens = tokens
    value.prune.tools.set(`tool-${tokens}`, tokens)
    value.nudges.contextLimitAnchors.add(`anchor-${tokens}`)
    return value
}

function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>((done) => (resolve = done))
    return { promise, resolve }
}

function proofState(id: string) {
    const value = state(id, 1)
    value.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 1,
        summaryTokens: 1,
        durationMs: 0,
        mode: "range",
        topic: "Synthetic",
        batchTopic: "Synthetic",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "source",
        compressMessageId: "origin",
        compressCallId: "call",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "Synthetic summary",
    })
    value.prune.messages.activeBlockIds.add(1)
    value.prune.messages.activeByAnchorMessageId.set("source", 1)
    return value
}

test("strict commits share ordinary/manual file ordering and grant proof only after rename", async (t) => {
    const first = proofState("strict-order"),
        staged = proofState("strict-order")
    staged.stats.totalPruneTokens = 7
    const entered = deferred(),
        release = deferred(),
        original = fs.rename
    let held = false,
        published = false
    t.mock.method(fs, "rename", async (...args) => {
        if (!held) {
            held = true
            entered.resolve()
            await release.promise
        }
        return original(...args)
    })
    syncBuiltinESMExports()
    t.after(() => {
        t.mock.restoreAll()
        syncBuiltinESMExports()
    })
    const ordinary = saveSessionState(first, new Logger(false))
    await entered.promise
    const strict = commitSessionState(staged, new Logger(false), {
        verify() {},
        publish() {
            assert.equal(
                staged.prune.messages.savedBlockSnapshots!.get(1),
                JSON.stringify(staged.prune.messages.blocksById.get(1)),
            )
            published = true
        },
    })
    const manual = saveManualModeSetting("strict-order", true, new Logger(false))
    assert.equal(staged.prune.messages.savedBlockSnapshots, undefined)
    assert.equal(published, false)
    // A different normalised file is independent of this blocked file queue.
    const independent = proofState("strict-independent")
    assert.equal(
        (await commitSessionState(independent, new Logger(false), { verify() {}, publish() {} }))
            .status,
        "published",
    )
    release.resolve()
    await ordinary
    assert.equal((await strict).status, "published")
    await manual
    const saved = await loadSessionState("strict-order", new Logger(false))
    assert.equal(saved!.stats.totalPruneTokens, 7)
    assert.equal(saved!.manualMode, true)
    assert.equal(published, true)
})

test("strict staged bytes cannot change while awaiting queue admission", async (t) => {
    const first = proofState("strict-capture"),
        staged = proofState("strict-capture")
    const entered = deferred(),
        release = deferred(),
        original = fs.rename
    let held = false
    t.mock.method(fs, "rename", async (...args) => {
        if (!held) {
            held = true
            entered.resolve()
            await release.promise
        }
        return original(...args)
    })
    syncBuiltinESMExports()
    t.after(() => {
        t.mock.restoreAll()
        syncBuiltinESMExports()
    })
    const ordinary = saveSessionState(first, new Logger(false))
    await entered.promise
    let published = false
    const pending = commitSessionState(staged, new Logger(false), {
        verify() {},
        publish() {
            published = true
        },
    })
    staged.prune.messages.blocksById.get(1)!.summary = "Mutated after capture"
    const rejection = assert.rejects(pending, /snapshot changed/)
    release.resolve()
    await ordinary
    await rejection
    assert.equal(published, false)
    assert.equal(staged.prune.messages.savedBlockSnapshots, undefined)
    assert.equal(
        (await loadSessionState("strict-capture", new Logger(false)))!.prune.messages!.blocksById[
            "1"
        ].summary,
        "Synthetic summary",
    )
    assert.equal(
        (await commitSessionState(staged, new Logger(false), { verify() {}, publish() {} })).status,
        "published",
    )
})

test("strict pre-rename verification failure preserves the prior complete file", async (t) => {
    const staged = proofState("strict-preverify")
    await saveSessionState(staged, new Logger(false))
    const before = await fs.readFile(join(storage, "strict-preverify.json"), "utf8")
    const proof = staged.prune.messages.savedBlockSnapshots
    let valid = true,
        published = false
    const open = fs.open
    t.mock.method(fs, "open", async (...args) => {
        const handle = await open(...args),
            sync = handle.sync.bind(handle)
        handle.sync = async () => {
            await sync()
            valid = false
        }
        return handle
    })
    syncBuiltinESMExports()
    t.after(() => {
        t.mock.restoreAll()
        syncBuiltinESMExports()
    })
    await assert.rejects(
        commitSessionState(staged, new Logger(false), {
            verify() {
                if (!valid) throw new Error("generation changed")
            },
            publish() {
                published = true
            },
        }),
        /generation changed/,
    )
    assert.equal(await fs.readFile(join(storage, "strict-preverify.json"), "utf8"), before)
    assert.equal(staged.prune.messages.savedBlockSnapshots, proof)
    assert.equal(published, false)
})

test("post-rename publication/logging errors remain honest committed outcomes", async () => {
    const staged = proofState("strict-publication")
    const result = await commitSessionState(staged, new Logger(false), {
        verify() {},
        publish() {
            throw new Error("publication failed")
        },
    })
    assert.equal(result.committed, true)
    assert.equal(result.status, "publication-failed")
    assert.equal(staged.prune.messages.savedBlockSnapshots, undefined)
    assert.ok(await loadSessionState(staged.sessionId!, new Logger(false)))
    const logger = new Logger(false)
    logger.info = () => {
        throw new Error("logging failed")
    }
    let published = false
    const logged = await commitSessionState(staged, logger, {
        verify() {},
        publish() {
            published = true
        },
    })
    assert.equal(logged.status, "published")
    assert.equal(published, true)
    assert.ok("warning" in logged)
    assert.ok(staged.prune.messages.savedBlockSnapshots!.has(1))
})

test("saved block proof appears after rename only, captures immutable bytes, and is not persisted", async (t) => {
    const value = proofState("proof-snapshot")
    const entered = deferred(),
        release = deferred()
    const original = fs.rename
    t.mock.method(fs, "rename", async (...args) => {
        entered.resolve()
        await release.promise
        return original(...args)
    })
    syncBuiltinESMExports()
    t.after(() => {
        t.mock.restoreAll()
        syncBuiltinESMExports()
    })
    const pending = saveSessionState(value, logger(t).value)
    await entered.promise
    assert.equal(value.prune.messages.savedBlockSnapshots, undefined)
    value.prune.messages.blocksById.get(1)!.summary = "Changed while rename waits"
    release.resolve()
    await pending
    assert.equal(
        JSON.parse(value.prune.messages.savedBlockSnapshots!.get(1)!).summary,
        "Synthetic summary",
    )
    const stored = await loadSessionState("proof-snapshot", new Logger(false))
    assert.equal(stored!.prune.messages!.blocksById["1"]!.summary, "Synthetic summary")
    assert.equal("savedBlockSnapshots" in stored!.prune.messages!, false)
})

test("failed save does not grant proof and retains the ordinary error log contract", async (t) => {
    const value = proofState("proof-failure")
    const block = value.prune.messages.blocksById.get(1)!
    block.effectiveMessageIds = ["synthetic-parent"]
    block.effectiveToolIds = ["synthetic-call"]
    block.protectedChildEvidence = {
        version: 1,
        complete: true,
        entries: [
            {
                capturedBlockId: 1,
                sourceMessageId: "synthetic-parent",
                callId: "synthetic-call",
                childSessionId: "synthetic-child",
                payload: block.summary,
                payloadHash: summaryHash(block.summary),
            },
        ],
    }
    const log = logger(t)
    const original = fs.rename
    let fail = true
    t.mock.method(fs, "rename", async (...args) => {
        if (fail) throw new Error("synthetic rename failure")
        return original(...args)
    })
    syncBuiltinESMExports()
    t.after(() => {
        t.mock.restoreAll()
        syncBuiltinESMExports()
    })
    await saveSessionState(value, log.value)
    assert.equal(value.prune.messages.savedBlockSnapshots, undefined)
    assert.equal(log.errors.mock.calls[0]!.arguments[0], "Failed to save session state")
    fail = false
    await saveSessionState(value, log.value)
    assert.ok(value.prune.messages.savedBlockSnapshots!.has(1))
    assert.equal(value.prune.messages.savedBlockSnapshots!.get(1), JSON.stringify(block))
    const saved = await loadSessionState("proof-failure", log.value)
    assert.deepEqual(
        saved!.prune.messages!.blocksById["1"].protectedChildEvidence,
        block.protectedChildEvidence,
    )
})

for (const scenario of ["checkpoint", "replacement", "A-B-A"] as const)
    test(`${scenario} cannot receive queued stale proof`, async (t) => {
        const value = proofState(`proof-stale-${scenario}`)
        const old = value.prune.messages
        const entered = deferred(),
            release = deferred()
        const original = fs.rename
        t.mock.method(fs, "rename", async (...args) => {
            entered.resolve()
            await release.promise
            return original(...args)
        })
        syncBuiltinESMExports()
        t.after(() => {
            t.mock.restoreAll()
            syncBuiltinESMExports()
        })
        const pending = saveSessionState(value, logger(t).value)
        await entered.promise
        if (scenario === "checkpoint") {
            const { resetOnCompaction } = await import("../lib/state/utils")
            resetOnCompaction(value)
        } else {
            value.prune.messages = proofState("new-generation").prune.messages
            if (scenario === "A-B-A") {
                value.sessionId = "B"
                value.sessionId = `proof-stale-${scenario}`
            }
        }
        release.resolve()
        await pending
        assert.equal(old.savedBlockSnapshots, undefined)
        assert.equal(value.prune.messages.savedBlockSnapshots, undefined)
    })

test("validated loaded records receive exact proof; repaired malformed records do not", async () => {
    const value = proofState("proof-load")
    value.prune.messages.blocksById.get(1)!.originalSummaryHash = "a".repeat(64)
    await saveSessionState(value, new Logger(false))
    const persisted = (await loadSessionState(value.sessionId!, new Logger(false)))!.prune.messages!
    const { loadPruneMessagesState } = await import("../lib/state/utils")
    const loaded = await loadPruneMessagesState(persisted)
    assert.ok(loaded.savedBlockSnapshots!.has(1))
    assert.equal(loaded.blocksById.get(1)!.originalSummaryHash, "a".repeat(64))
    persisted.blocksById["1"]!.runId = -1
    const repaired = await loadPruneMessagesState(persisted)
    assert.equal(repaired.savedBlockSnapshots!.has(1), false)
})

function logger(t: TestContext) {
    const value = new Logger(false)
    const errors = t.mock.method(value, "error", () => {})
    const warnings = t.mock.method(value, "warn", () => {})
    const infos = t.mock.method(value, "info", () => {})
    return { value, errors, warnings, infos }
}

function mockOpen(t: TestContext, implementation: typeof fs.open) {
    t.mock.method(fs, "open", implementation)
    syncBuiltinESMExports()
    t.after(() => {
        t.mock.restoreAll()
        syncBuiltinESMExports()
    })
}

test("same-session objects queue in call order and capture immutable snapshots before waiting", async (t) => {
    const log = logger(t)
    const entered = deferred()
    const release = deferred()
    const original = fs.open
    let opens = 0
    mockOpen(t, async (...args) => {
        opens++
        if (opens === 1) {
            entered.resolve()
            await release.promise
        }
        assert.equal(args[1], "wx")
        assert.equal(args[2], 0o600)
        return original(...args)
    })
    const first = state("ordered", 1)
    const pendingFirst = saveSessionState(first, log.value)
    await entered.promise
    const second = state("ordered", 2)
    const pendingSecond = saveSessionState(second, log.value, "snapshot")
    first.stats.totalPruneTokens = 100
    second.stats.totalPruneTokens = 200
    second.prune.tools.clear()
    second.nudges.contextLimitAnchors.clear()
    second.sessionId = "changed-after-save"
    await Promise.resolve()
    assert.equal(opens, 1)
    release.resolve()
    await Promise.all([pendingFirst, pendingSecond])
    const saved = await loadSessionState("ordered", log.value)
    assert.equal(saved?.stats.totalPruneTokens, 2)
    assert.deepEqual(saved?.prune.tools, { "tool-2": 2 })
    assert.deepEqual(saved?.nudges.contextLimitAnchors, ["anchor-2"])
    assert.equal(saved?.sessionName, "snapshot")
    assert.deepEqual(
        log.infos.mock.calls
            .filter((call) => call.arguments[0] === "Saved session state to disk")
            .map((call) => call.arguments[1]?.totalTokensSaved),
        [1, 2],
    )
    assert.equal(log.errors.mock.callCount(), 0)
})

test("a blocked session does not block another session", async (t) => {
    const log = logger(t)
    const entered = deferred()
    const release = deferred()
    const original = fs.open
    mockOpen(t, async (...args) => {
        if (String(args[0]).includes("blocked.json.")) {
            entered.resolve()
            await release.promise
        }
        return original(...args)
    })
    const blocked = saveSessionState(state("blocked", 1), log.value)
    await entered.promise
    try {
        await saveSessionState(state("independent", 2), log.value)
        assert.equal((await loadSessionState("independent", log.value))?.stats.totalPruneTokens, 2)
    } finally {
        release.resolve()
        await blocked
    }
})

test("readers see old complete JSON until the flushed temporary file is renamed", async (t) => {
    const log = logger(t)
    await saveSessionState(state("readers", 1), log.value)
    const entered = deferred()
    const release = deferred()
    const original = fs.open
    mockOpen(t, async (...args) => {
        const handle = await original(...args)
        const sync = handle.sync.bind(handle)
        t.mock.method(handle, "sync", async () => {
            entered.resolve()
            await release.promise
            await sync()
        })
        return handle
    })
    const pending = saveSessionState(state("readers", 2), log.value)
    await entered.promise
    try {
        for (let n = 0; n < 20; n++) {
            assert.equal((await loadSessionState("readers", log.value))?.stats.totalPruneTokens, 1)
        }
    } finally {
        release.resolve()
        await pending
    }
    assert.equal((await loadSessionState("readers", log.value))?.stats.totalPruneTokens, 2)
    assert.equal((await fs.stat(join(storage, "readers.json"))).mode & 0o777, 0o600)
    assert.deepEqual(
        (await fs.readdir(storage)).filter((file) => file.endsWith(".tmp")),
        [],
    )
})

for (const failure of ["writeFile", "sync", "close", "rename"] as const) {
    test(`${failure} failure preserves old bytes, cleans temporary files and allows the next queued save`, async (t) => {
        const log = logger(t)
        const id = `failure-${failure}`
        await saveSessionState(state(id, 1), log.value)
        const previous = await fs.readFile(join(storage, `${id}.json`), "utf8")
        const entered = deferred()
        const release = deferred()
        const original = fs.open
        let fail = true
        let attempts = 0
        mockOpen(t, async (...args) => {
            if (++attempts > 1) {
                assert.equal(await fs.readFile(join(storage, `${id}.json`), "utf8"), previous)
            }
            const handle = await original(...args)
            if (fail && failure !== "rename") {
                fail = false
                const close = handle.close.bind(handle)
                t.mock.method(handle, failure, async () => {
                    entered.resolve()
                    await release.promise
                    // Simulate a close error after closing so the fixture does not leak a descriptor.
                    if (failure === "close") await close()
                    throw new Error(`synthetic ${failure} failure`)
                })
            }
            return handle
        })
        if (failure === "rename") {
            const rename = fs.rename
            t.mock.method(fs, "rename", async (...args) => {
                if (fail) {
                    fail = false
                    entered.resolve()
                    await release.promise
                    throw new Error("synthetic rename failure")
                }
                return rename(...args)
            })
            syncBuiltinESMExports()
        }
        const pending = saveSessionState(state(id, 2), log.value)
        await entered.promise
        assert.equal(await fs.readFile(join(storage, `${id}.json`), "utf8"), previous)
        const next = saveSessionState(state(id, 3), log.value)
        release.resolve()
        await pending // saveSessionState deliberately logs rather than rejecting.
        await next
        assert.equal((await loadSessionState(id, log.value))?.stats.totalPruneTokens, 3)
        assert.equal(log.errors.mock.callCount(), 1)
        assert.equal(log.errors.mock.calls[0].arguments[0], "Failed to save session state")
        assert.deepEqual(
            (await fs.readdir(storage)).filter((file) => file.endsWith(".tmp")),
            [],
        )
    })
}

test("manual-mode read/modify/write shares the queue without losing a preceding snapshot", async (t) => {
    const log = logger(t)
    const entered = deferred()
    const release = deferred()
    const original = fs.open
    let first = true
    mockOpen(t, async (...args) => {
        if (first) {
            first = false
            entered.resolve()
            await release.promise
        }
        return original(...args)
    })
    const saving = saveSessionState(state("manual", 42), log.value)
    await entered.promise
    const manual = saveManualModeSetting("manual", true, log.value)
    release.resolve()
    await Promise.all([saving, manual])
    assert.equal(await loadManualModeSetting("manual", log.value), true)
    assert.equal((await loadSessionState("manual", log.value))?.stats.totalPruneTokens, 42)
    await saveManualModeSetting("manual-new", false, log.value)
    assert.equal(await loadManualModeSetting("manual-new", log.value), false)
})

test("exclusive-open failure does not remove a file the save does not own", async (t) => {
    const log = logger(t)
    let collision = ""
    mockOpen(t, async (path) => {
        collision = String(path)
        await fs.writeFile(collision, "not owned by this save")
        throw Object.assign(new Error("synthetic collision"), { code: "EEXIST" })
    })
    await saveSessionState(state("collision", 1), log.value)
    assert.equal(await fs.readFile(collision, "utf8"), "not owned by this save")
    assert.equal(log.errors.mock.callCount(), 1)
    await fs.rm(collision)
})

test("missing session saves and missing, malformed or invalid loads retain their contract", async (t) => {
    const log = logger(t)
    await saveSessionState(createSessionState(), log.value)
    assert.equal(log.infos.mock.callCount(), 0)
    assert.equal(await loadSessionState("missing", log.value), null)
    await fs.writeFile(join(storage, "malformed.json"), "{")
    await fs.writeFile(join(storage, "invalid.json"), "{}")
    assert.equal(await loadSessionState("malformed", log.value), null)
    assert.equal(await loadSessionState("invalid", log.value), null)
    assert.deepEqual(
        log.warnings.mock.calls.map((call) => call.arguments[0]),
        ["Failed to load session state", "Invalid session state file, ignoring"],
    )
})

test("manual save failures still reject and do not poison the queue", async (t) => {
    const log = logger(t)
    const original = fs.open
    let fail = true
    mockOpen(t, async (...args) => {
        if (fail) {
            fail = false
            throw new Error("synthetic open failure")
        }
        return original(...args)
    })
    await assert.rejects(saveManualModeSetting("manual-error", true, log.value), /synthetic open/)
    await saveManualModeSetting("manual-error", false, log.value)
    assert.equal(await loadManualModeSetting("manual-error", log.value), false)
    assert.equal(log.errors.mock.callCount(), 0)
})
