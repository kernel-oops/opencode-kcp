import assert from "node:assert/strict"
import test from "node:test"
import type { Message } from "@opencode/ai/schema/messages"
import { elideCommittedCompressSummaries } from "../lib/v2/compress-inputs"
import { COMPRESS_INPUT_ARCHIVE_MARKER, summaryHash } from "../lib/compress/summary"
import { wrapCompressedSummary } from "../lib/compress/state"
import { createSessionState, type CompressionBlock } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { project } from "../lib/v2/messages"
import { prune } from "../lib/messages/prune"
import { Logger } from "../lib/logger"
import { syncCompressionBlocks } from "../lib/messages/sync"

type History = Parameters<typeof elideCommittedCompressSummaries>[1]
const prose = "Synthetic implementation decision and acceptance evidence. ".repeat(100)
const config = {
    compress: { protectedTools: [], mode: "range" },
    commands: { protectedTools: ["compress"] },
} as unknown as PluginConfig
function block(id = 1): CompressionBlock {
    return {
        blockId: id,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 10000,
        summaryTokens: 1000,
        durationMs: 1,
        mode: "range",
        topic: "Decision",
        batchTopic: "Decision",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "source",
        compressMessageId: "origin",
        compressCallId: "call",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["source"],
        directToolIds: [],
        effectiveMessageIds: ["source"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: wrapCompressedSummary(id, prose),
        originalSummaryHash: summaryHash(prose),
    }
}
function fixture(mode: "range" | "message" = "range") {
    const input = {
        topic: "Decision",
        content: [
            mode === "range"
                ? { startId: "m0001", endId: "m0001", summary: prose }
                : { messageId: "m0001", topic: "Decision", summary: prose },
        ],
    }
    const outgoing: Message[] = [
        { id: "source", role: "user", content: [{ type: "text", text: "Source" }] },
        {
            id: "origin",
            role: "assistant",
            content: [
                { type: "reasoning", text: "opaque", encrypted: "signature" },
                { type: "tool-call", id: "call", name: "compress", input },
            ],
        },
        {
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    id: "call",
                    name: "compress",
                    result: { type: "text", value: "Compressed successfully" },
                },
            ],
        },
        { id: "latest", role: "user", content: [{ type: "text", text: "Continue" }] },
    ] as Message[]
    const entries = [
        { id: "source", type: "user", text: "Source", time: { created: 1 } },
        {
            id: "origin",
            type: "assistant",
            time: { created: 2 },
            agent: "build",
            model: { id: "fixture", providerID: "synthetic" },
            content: [
                {
                    type: "tool",
                    id: "call",
                    name: "compress",
                    state: {
                        status: "completed",
                        input: structuredClone(input),
                        content: [{ type: "text", text: "Compressed successfully" }],
                    },
                },
            ],
        },
        { id: "latest", type: "user", text: "Continue", time: { created: 3 } },
    ] as History
    const state = createSessionState()
    state.sessionId = "synthetic"
    const origin = block()
    origin.mode = mode
    state.prune.messages.blocksById.set(1, origin)
    state.prune.messages.activeBlockIds.add(1)
    state.prune.messages.activeByAnchorMessageId.set("source", 1)
    state.prune.messages.byMessageId.set("source", {
        tokenCount: 1,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    const saved = () => {
        state.prune.messages.savedBlockSnapshots = new Map(
            [...state.prune.messages.blocksById].map(([id, value]) => [id, JSON.stringify(value)]),
        )
    }
    saved()
    const run = (rendered = new Set([1]), settings = config) =>
        elideCommittedCompressSummaries(outgoing, entries, state, rendered, settings)
    return { input, outgoing, entries, state, origin, saved, run }
}
function summary(messages: Message[]): string {
    const call = messages
        .find((message) => message.id === "origin")!
        .content.find((part) => part.type === "tool-call")!
    return (call as any).input.content[0].summary
}
function freeze(value: any): void {
    if (value && typeof value === "object") {
        Object.freeze(value)
        for (const child of Object.values(value)) freeze(child)
    }
}

for (const mode of ["range", "message"] as const)
    test(`${mode}: actual projected outgoing request shrinks, frozen native GET arguments and IDs remain intact`, () => {
        const f = fixture(mode)
        const before = structuredClone(f.outgoing)
        freeze(f.outgoing)
        freeze(f.entries)
        const session = {
            id: "synthetic",
            agent: "build",
            model: { id: "fixture", providerID: "synthetic" },
        } as Parameters<typeof project>[2]
        const view = project(f.outgoing, f.entries, session)
        const rendered = prune(f.state, new Logger(false), config, view.messages)
        assert.deepEqual([...rendered], [1])
        const requestBeforeElision = view.restore()
        const outgoing = elideCommittedCompressSummaries(
            requestBeforeElision,
            f.entries,
            f.state,
            rendered,
            config,
        )
        assert.equal(summary(outgoing), COMPRESS_INPUT_ARCHIVE_MARKER)
        assert.notEqual(summary(outgoing), prose)
        assert.ok(JSON.stringify(outgoing).length < JSON.stringify(requestBeforeElision).length)
        assert.deepEqual(f.outgoing, before)
        assert.equal((f.entries[1] as any).content[0].state.input.content[0].summary, prose)
        assert.equal(
            (outgoing.find((m) => m.id === "origin")!.content[0] as any).encrypted,
            "signature",
        )
        assert.deepEqual(
            outgoing.find((m) => m.role === "tool"),
            f.outgoing[2],
        )
    })

test("ordinary consumed lineage needs one saved, rendered active successor, not rewrite support", () => {
    const f = fixture()
    f.origin.active = false
    f.origin.deactivatedByBlockId = 2
    f.origin.deactivatedAt = 1
    f.state.prune.messages.activeBlockIds.delete(1)
    const next = block(2)
    next.compressMessageId = "later"
    next.compressCallId = "later-call"
    next.consumedBlockIds = [1]
    f.state.prune.messages.blocksById.set(2, next)
    f.state.prune.messages.activeBlockIds.add(2)
    f.saved()
    syncCompressionBlocks(
        f.state,
        new Logger(false),
        ["origin", "later", "source"].map((id) => ({ info: { id }, parts: [] })) as any,
    )
    assert.equal(f.origin.deactivatedAt, 1)
    assert.equal(summary(f.run(new Set([2]))), COMPRESS_INPUT_ARCHIVE_MARKER)
    assert.equal(summary(f.run(new Set([1]))), prose)
    next.deactivatedByUser = true
    f.saved()
    assert.equal(summary(f.run(new Set([2]))), prose)
})

for (const mode of ["range", "message"] as const)
    test(`${mode}: pre-expansion fingerprint proves protected/expanded summaries without prefix heuristics`, () => {
        const f = fixture(mode)
        f.origin.originalSummaryHash = summaryHash(prose)
        f.origin.summary = wrapCompressedSummary(
            1,
            `${prose}\nProtected tool output and expanded block prose`,
        )
        f.saved()
        assert.equal(summary(f.run()), COMPRESS_INPUT_ARCHIVE_MARKER)
        // Even matching mutations of both outgoing and native arguments cannot alias the origin.
        f.input.content[0]!.summary = "Changed native prose"
        ;(f.entries[1] as any).content[0].state.input.content[0].summary = "Changed native prose"
        assert.equal(summary(f.run()), "Changed native prose")
    })

test("equivocal shared coverage retains arguments", () => {
    const f = fixture()
    f.origin.active = false
    f.origin.deactivatedByBlockId = 2
    for (const id of [2, 3]) {
        const next = block(id)
        next.compressMessageId = `later-${id}`
        next.consumedBlockIds = [1]
        f.state.prune.messages.blocksById.set(id, next)
        f.state.prune.messages.activeBlockIds.add(id)
    }
    f.saved()
    assert.equal(summary(f.run(new Set([2, 3]))), prose)
})

test("exact fingerprints distinguish lone UTF-16 surrogates and changed joins", () => {
    const samples = [
        "\ud800",
        "\ud801",
        "\udc00",
        "\ufffd",
        ["\ud800", "x", "\udc00"].join(""),
        ["\ufffd", "x", "\ufffd"].join(""),
    ]
    assert.equal(new Set(samples.map(summaryHash)).size, samples.length)
    const f = fixture()
    const original = `Synthetic prose ${samples[0]}`
    f.input.content[0]!.summary = original
    ;(f.entries[1] as any).content[0].state.input = structuredClone(f.input)
    f.origin.originalSummaryHash = summaryHash(original)
    f.origin.summary = wrapCompressedSummary(1, original)
    f.saved()
    assert.equal(summary(f.run()), COMPRESS_INPUT_ARCHIVE_MARKER)
    const changed = `Synthetic prose ${samples[1]}`
    f.input.content[0]!.summary = changed
    ;(f.entries[1] as any).content[0].state.input = structuredClone(f.input)
    assert.equal(summary(f.run()), changed)
})

for (const mode of ["range", "message"] as const)
    test(`${mode}: every batch entry needs proof or the whole input is retained`, () => {
        const f = fixture(mode)
        f.input.content.push(
            mode === "range"
                ? { startId: "m0002", endId: "m0002", summary: prose }
                : { messageId: "m0002", topic: "Decision", summary: prose },
        )
        ;(f.entries[1] as any).content[0].state.input = structuredClone(f.input)
        const second = block(2)
        second.mode = mode
        second.startId = "m0002"
        second.endId = "m0002"
        f.state.prune.messages.blocksById.set(2, second)
        f.state.prune.messages.activeBlockIds.add(2)
        f.saved()
        const rendered = new Set([1, 2])
        assert.equal(summary(f.run(rendered)), COMPRESS_INPUT_ARCHIVE_MARKER)
        f.state.prune.messages.savedBlockSnapshots!.delete(2)
        assert.equal(summary(f.run(rendered)), prose)
    })

const negatives: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    [
        "malformed outgoing result",
        (f) => {
            ;(f.outgoing[2]!.content[0] as any).result = {}
        },
    ],
    [
        "duplicate outgoing result",
        (f) => {
            f.outgoing[2]!.content.push(f.outgoing[2]!.content[0]!)
        },
    ],
    [
        "duplicate outgoing message ID",
        (f) => {
            f.outgoing.push({ id: "origin", role: "assistant", content: [] })
        },
    ],
    [
        "missing outgoing call ID",
        (f) => {
            delete (f.outgoing[1]!.content[1] as any).id
        },
    ],
    [
        "legacy block without fingerprint",
        (f) => {
            delete f.origin.originalSummaryHash
            f.saved()
        },
    ],
    [
        "pending native call",
        (f) => {
            ;(f.entries[1] as any).content[0].state.status = "running"
        },
    ],
    [
        "failed native call",
        (f) => {
            ;(f.entries[1] as any).content[0].state.status = "error"
        },
    ],
    [
        "failed outgoing result",
        (f) => {
            ;(f.outgoing[2]!.content[0] as any).result = { type: "error", value: "failed" }
        },
    ],
    [
        "missing outgoing result",
        (f) => {
            f.outgoing.splice(2, 1)
        },
    ],
    [
        "mismatched result name",
        (f) => {
            ;(f.outgoing[2]!.content[0] as any).name = "other"
        },
    ],
    [
        "duplicate outgoing call",
        (f) => {
            f.outgoing[1]!.content.push(f.outgoing[1]!.content[1]!)
        },
    ],
    [
        "duplicate native origin",
        (f) => {
            f.entries.push(f.entries[1]!)
        },
    ],
    [
        "missing origin ID",
        (f) => {
            delete f.outgoing[1]!.id
        },
    ],
    [
        "missing native call",
        (f) => {
            ;(f.entries[1] as any).content[0].id = "other"
        },
    ],
    [
        "mutated outgoing input",
        (f) => {
            ;(f.outgoing[1]!.content[1] as any).input.content[0].summary = "Changed"
        },
    ],
    [
        "mutated native and outgoing input",
        (f) => {
            f.input.content[0]!.summary = "Changed"
            ;(f.entries[1] as any).content[0].state.input.content[0].summary = "Changed"
        },
    ],
    [
        "unsaved origin",
        (f) => {
            f.state.prune.messages.savedBlockSnapshots!.clear()
        },
    ],
    [
        "saved cache mutated",
        (f) => {
            f.origin.topic = "Changed"
        },
    ],
    [
        "manual decompression",
        (f) => {
            f.origin.deactivatedByUser = true
            f.saved()
        },
    ],
    [
        "manual reactivation remains marked",
        (f) => {
            f.origin.active = true
            f.origin.deactivatedByUser = true
            f.saved()
        },
    ],
    [
        "ambiguous origin block",
        (f) => {
            f.state.prune.messages.blocksById.set(2, { ...f.origin, blockId: 2 })
            f.saved()
        },
    ],
    [
        "partial message batch",
        (f) => {
            f.input.content.push({ messageId: "m0002", topic: "Other", summary: prose } as any)
            ;(f.entries[1] as any).content[0].state.input = structuredClone(f.input)
        },
    ],
    [
        "missing active membership",
        (f) => {
            f.state.prune.messages.activeBlockIds.clear()
        },
    ],
    [
        "cyclic lineage",
        (f) => {
            f.origin.active = false
            f.origin.deactivatedByBlockId = 1
            f.origin.consumedBlockIds = [1]
            f.saved()
        },
    ],
    [
        "expanded/protected summary cannot prove original",
        (f) => {
            f.origin.summary += "\nProtected attachment"
            delete f.origin.originalSummaryHash
            f.saved()
        },
    ],
]
for (const [label, mutate] of negatives)
    test(`${label}: retain entire original input`, () => {
        const f = fixture()
        mutate(f)
        const result = f.run()
        assert.equal(
            result.find((m) => m.role === "assistant"),
            f.outgoing.find((m) => m.role === "assistant"),
        )
    })

test("non-rendered and protected compress retain input; command protection does not affect visibility", () => {
    const f = fixture()
    assert.equal(summary(f.run(new Set())), prose)
    for (const pattern of ["compress", "comp*", "*"])
        assert.equal(
            summary(
                f.run(new Set([1]), {
                    ...config,
                    compress: { ...config.compress, protectedTools: [pattern] },
                }),
            ),
            prose,
        )
    assert.equal(summary(f.run()), COMPRESS_INPUT_ARCHIVE_MARKER)
})

function rewriteFixture() {
    const f = fixture()
    const prior = f.origin
    prior.compressMessageId = "legacy-origin"
    prior.compressCallId = "legacy-call"
    delete prior.originalSummaryHash
    prior.active = false
    prior.deactivatedByBlockId = 2
    prior.parentBlockIds = [2]
    Object.assign(f.input.content[0]!, { startId: "b1", endId: "b1", rewrite: true })
    Object.assign((f.entries[1] as any).content[0].state.input, structuredClone(f.input))
    const successor: CompressionBlock = {
        ...block(2),
        runId: 2,
        consumedBlockIds: [1],
        includedBlockIds: [1],
        directMessageIds: [],
        directToolIds: [],
        summary: wrapCompressedSummary(2, "Smaller"),
        originalSummaryHash: summaryHash(prose),
    }
    f.state.prune.messages.blocksById.set(2, successor)
    f.state.prune.messages.activeBlockIds = new Set([2])
    f.state.prune.messages.activeByAnchorMessageId.set("source", 2)
    f.saved()
    return { ...f, successor, runRewrite: () => f.run(new Set([2])) }
}
test("new rewrite hash elides a whole proven call even when predecessor has no submission hash", () => {
    const f = rewriteFixture()
    assert.equal(summary(f.runRewrite()), COMPRESS_INPUT_ARCHIVE_MARKER)
    assert.equal(f.origin.originalSummaryHash, undefined)
})

test("a duplicate native call hidden from outgoing context still prevents argument elision", () => {
    const f = rewriteFixture()
    f.entries.push({ ...structuredClone(f.entries[1]!), id: "other-native-origin" } as any)
    assert.equal(summary(f.runRewrite()), prose)
})

for (const kind of [
    "valid",
    "ordinary-false",
    "wrong-hash",
    "missing-written-proof",
    "changed-coverage",
    "duplicate-global-call",
    "duplicate-alias-in-origin",
    "malformed-extra",
    "mixed-extra",
    "unmatched-extra",
    "balanced-malformed",
    "valid-full-batch",
    "non-native-view",
] as const)
    test(`legacy timestamp preservation is limited to written explicit rewrite evidence: ${kind}`, (t) => {
        const f = rewriteFixture(),
            input: any = structuredClone(f.input)
        f.origin.deactivatedAt = 123
        if (kind === "ordinary-false") input.content[0].rewrite = false
        if (kind === "wrong-hash") input.content[0].summary = "Different submitted summary"
        if (kind === "changed-coverage") f.successor.effectiveToolIds.push("outside")
        const native: any[] = [
            { info: { id: "source", role: "user" }, parts: [{ type: "text", text: "Source" }] },
            { info: { id: "legacy-origin", role: "assistant" }, parts: [] },
            {
                info: { id: "origin", role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        tool: "compress",
                        callID: "call",
                        state: { status: "completed", input, output: "Rewritten" },
                    },
                ],
            },
        ]
        const call = native[2].parts[0]
        if (kind === "duplicate-global-call")
            native.push({
                info: { id: "another-origin", role: "assistant" },
                parts: [structuredClone(call)],
            })
        if (kind === "duplicate-alias-in-origin")
            native[2].parts.push({ ...structuredClone(call), tool: "read" })
        if (kind === "malformed-extra") input.content.push({ rewrite: true })
        if (kind === "mixed-extra") input.content.push({ ...input.content[0], rewrite: false })
        if (kind === "unmatched-extra")
            input.content.push({ ...input.content[0], startId: "b9", endId: "b9" })
        if (kind === "balanced-malformed" || kind === "valid-full-batch") {
            const prior = {
                ...structuredClone(f.origin),
                blockId: 3,
                startId: "m0002",
                endId: "m0002",
                anchorMessageId: "other-source",
                effectiveMessageIds: ["other-source"],
                compressMessageId: "other-legacy-origin",
                compressCallId: "other-legacy-call",
                parentBlockIds: [4],
                deactivatedByBlockId: 4,
            }
            const successor = {
                ...structuredClone(f.successor),
                blockId: 4,
                startId: prior.startId,
                endId: prior.endId,
                anchorMessageId: prior.anchorMessageId,
                effectiveMessageIds: prior.effectiveMessageIds,
                consumedBlockIds: [3],
                includedBlockIds: [3],
            }
            f.state.prune.messages.blocksById.set(3, prior)
            f.state.prune.messages.blocksById.set(4, successor)
            native.push(
                {
                    info: { id: "other-source", role: "user" },
                    parts: [{ type: "text", text: "Other source" }],
                },
                { info: { id: "other-legacy-origin", role: "assistant" }, parts: [] },
            )
            input.content.push(
                kind === "balanced-malformed"
                    ? { rewrite: true }
                    : { ...input.content[0], startId: "b3", endId: "b3" },
            )
        }
        f.saved()
        if (kind === "missing-written-proof") f.state.prune.messages.savedBlockSnapshots!.delete(1)
        t.mock.method(Date, "now", () => 456)
        syncCompressionBlocks(
            f.state,
            new Logger(false),
            native,
            kind === "non-native-view" ? null : native,
        )
        assert.equal(
            f.origin.deactivatedAt,
            kind === "valid" || kind === "valid-full-batch" ? 123 : 456,
        )
        assert.equal(f.origin.originalSummaryHash, undefined)
        if (kind === "valid-full-batch")
            assert.equal(f.state.prune.messages.blocksById.get(3)!.deactivatedAt, 123)
    })
for (const [label, mutate] of [
    ["predecessor proof drift", (f: any) => (f.origin.summary += "changed")],
    ["successor proof drift", (f: any) => (f.successor.summary += "changed")],
    [
        "boundary coverage",
        (f: any) => {
            f.successor.startId = "b1"
            f.saved()
        },
    ],
    [
        "anchor",
        (f: any) => {
            f.successor.anchorMessageId = "other"
            f.saved()
        },
    ],
    [
        "effective messages",
        (f: any) => {
            f.successor.effectiveMessageIds.push("other")
            f.saved()
        },
    ],
    [
        "effective tools",
        (f: any) => {
            f.successor.effectiveToolIds.push("other")
            f.saved()
        },
    ],
    [
        "direct raw pruning",
        (f: any) => {
            f.successor.directMessageIds.push("source")
            f.saved()
        },
    ],
    ["missing predecessor", (f: any) => f.state.prune.messages.blocksById.delete(1)],
    [
        "extra consumed predecessor",
        (f: any) => {
            f.successor.consumedBlockIds.push(9)
            f.saved()
        },
    ],
    [
        "wrong included predecessor",
        (f: any) => {
            f.successor.includedBlockIds = []
            f.saved()
        },
    ],
] as const)
    test(`rewrite ${label} retains every submitted summary`, () => {
        const f = rewriteFixture()
        mutate(f)
        assert.equal(summary(f.runRewrite()), prose)
    })
