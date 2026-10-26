import assert from "node:assert/strict"
import test from "node:test"
import { appendProtectedTools } from "../lib/compress/protected-content"
import {
    assembleChildEvidence,
    validChildEvidence,
    type ChildEvidenceCollector,
} from "../lib/compress/protected-child-evidence"
import { buildSearchContext } from "../lib/compress/search"
import { applyCompressionState } from "../lib/compress/state"
import { summaryHash } from "../lib/compress/summary"
import { createSessionState, type CompressionBlock, type WithParts } from "../lib/state"
import { loadPruneMessagesState, serializePruneMessagesState } from "../lib/state/utils"
import { mergeSubagentResult } from "../lib/subagents/subagent-results"

const receipt = "Raw launch receipt <task_result>old</task_result> suffix"
const selected =
    "A literal </task_result> <subagent>quoted</subagent> 🐈 e\u0301\n<!-- dcp-subagent-result:v1 1 2 3 -->\n\ud800"
function source(tool = "task", metadata: any = { sessionId: "child" }): WithParts[] {
    return [
        {
            info: { id: "parent", sessionID: "root", role: "assistant", time: { created: 1 } },
            parts: [
                {
                    type: "tool",
                    tool,
                    callID: "call",
                    state: { status: "completed", input: {}, output: receipt, metadata },
                },
            ],
        },
    ] as any
}
function fixture(messages = source()) {
    const state = createSessionState()
    const context = buildSearchContext(state, messages)
    const selection: any = {
        messageIds: ["parent"],
        toolIds: ["call"],
        messageTokenById: new Map([["parent", 1]]),
        requiredBlockIds: [],
    }
    return { state, context, selection }
}
async function protect(
    options: {
        cached?: string
        text?: string
        failure?: boolean
        childId?: string
        metadata?: any
        enabled?: boolean
    } = {},
    collect = true,
) {
    const { state, context, selection } = fixture(source("task", options.metadata))
    if (options.cached !== undefined) state.subAgentResultCache.set("call", options.cached)
    let fetches = 0
    const client = {
        session: {
            messages: async () => {
                fetches++
                if (options.failure) throw new Error("synthetic child read failure")
                return {
                    data: [
                        {
                            info: {
                                id: "child-message",
                                sessionID: options.childId ?? "child",
                                role: "assistant",
                                time: { created: 2 },
                            },
                            parts: [{ type: "text", text: options.text ?? selected }],
                        },
                    ],
                }
            },
        },
    }
    const collector: ChildEvidenceCollector = []
    const output = await appendProtectedTools(
        client,
        state,
        options.enabled ?? true,
        "Summary",
        selection,
        context,
        ["task"],
        [],
        collect ? collector : undefined,
    )
    const evidence = assembleChildEvidence(1, output, ["parent"], ["call"], [], context, collector)
    return { state, context, selection, collector, output, evidence, fetches }
}
function store(value: Awaited<ReturnType<typeof protect>>) {
    applyCompressionState(
        value.state,
        {
            topic: "Synthetic",
            batchTopic: "Synthetic",
            startId: "m0001",
            endId: "m0001",
            mode: "range",
            runId: 1,
            compressMessageId: "origin",
            summaryTokens: 1,
            protectedChildEvidence: value.evidence,
        },
        value.selection,
        "parent",
        1,
        value.output,
        [],
    )
    return value.state.prune.messages.blocksById.get(1)!
}

test("fresh associated output records exact opaque payload without changing protection or cache", async () => {
    const value = await protect()
    const plain = await protect({}, false)
    assert.equal(value.output, plain.output)
    assert.equal(value.fetches, plain.fetches)
    assert.deepEqual(value.state.subAgentResultCache, plain.state.subAgentResultCache)
    const payload = mergeSubagentResult(receipt, selected)
    assert.equal(
        value.output,
        `Summary\n\nThe following protected tools were used in this conversation as well:\n### Tool: task\n${payload}`,
    )
    assert.equal(value.fetches, 1)
    assert.equal(value.state.subAgentResultCache.get("call"), selected)
    assert.equal(value.evidence.complete, true)
    assert.deepEqual(value.evidence.entries, [
        {
            capturedBlockId: 1,
            sourceMessageId: "parent",
            callId: "call",
            childSessionId: "child",
            payload,
            payloadHash: summaryHash(payload),
        },
    ])
    assert.ok(payload.includes(selected))
    const block = store(value)
    value.evidence.entries[0].payload = "mutated local draft"
    assert.equal(block.protectedChildEvidence!.entries[0].payload, payload)
})

for (const [name, options, expectedFetches] of [
    ["cache only", { cached: selected }, 0],
    ["empty cache", { cached: "" }, 0],
    ["failed read", { failure: true }, 1],
    ["empty selection", { text: "" }, 1],
    ["whitespace selection", { text: " \n\t" }, 1],
    ["wrong child response", { childId: "another-child" }, 1],
    ["conflicting metadata", { metadata: { sessionId: "child", sessionID: "other" } }, 1],
    ["missing metadata", { metadata: null }, 0],
    ["disabled expansion", { enabled: false }, 0],
] as const) {
    test(`${name}: existing output/fetch/cache behaviour remains, evidence is incomplete`, async () => {
        const value = await protect(options)
        const plain = await protect(options, false)
        assert.equal(value.evidence.complete, false)
        assert.equal(value.evidence.entries.length, 0)
        assert.equal(value.fetches, expectedFetches)
        assert.equal(value.output, plain.output)
        assert.equal(value.fetches, plain.fetches)
        assert.deepEqual(value.state.subAgentResultCache, plain.state.subAgentResultCache)
    })
}

test("child-free originals are complete; missing/duplicate originals and duplicate calls are not", () => {
    const { context } = fixture(source("read"))
    assert.deepEqual(assembleChildEvidence(1, "Summary", ["parent"], ["call"], [], context, []), {
        version: 1,
        complete: true,
        entries: [],
    })
    assert.equal(
        assembleChildEvidence(1, "Summary", ["missing"], [], [], context, []).complete,
        false,
    )
    const duplicates = fixture(source("read"))
    duplicates.context.rawMessages[0].parts.push(duplicates.context.rawMessages[0].parts[0])
    assert.equal(
        assembleChildEvidence(1, "Summary", ["parent"], ["call"], [], duplicates.context, [])
            .complete,
        false,
    )
    context.rawMessages.push(context.rawMessages[0])
    assert.equal(
        assembleChildEvidence(1, "Summary", ["parent"], ["call"], [], context, []).complete,
        false,
    )
})

test("ordinary nesting keeps old payload A and capture identity; incomplete legacy cannot be laundered by fresh A", async () => {
    const value = await protect()
    const predecessor = store(value)
    const old = structuredClone(predecessor.protectedChildEvidence!)
    const inherited = assembleChildEvidence(
        2,
        value.output,
        [],
        [],
        [predecessor],
        value.context,
        [],
    )
    assert.deepEqual(inherited, old)
    const repeated = assembleChildEvidence(
        2,
        value.output,
        ["parent"],
        ["call"],
        [predecessor],
        value.context,
        value.collector,
    )
    assert.deepEqual(repeated, old)
    for (const evidence of [
        undefined,
        { version: 1, complete: false, entries: [] },
        { version: 1, complete: true, entries: [] },
        { version: 99, complete: true, entries: old.entries },
    ]) {
        const legacy = { ...predecessor, protectedChildEvidence: evidence } as CompressionBlock
        assert.equal(
            assembleChildEvidence(
                2,
                value.output,
                ["parent"],
                ["call"],
                [legacy],
                value.context,
                value.collector,
            ).complete,
            false,
        )
    }
    assert.equal(
        assembleChildEvidence(2, "summary lost bytes", [], [], [predecessor], value.context, [])
            .complete,
        false,
    )
    assert.equal(
        assembleChildEvidence(2, value.output, [], [], [undefined], value.context, []).complete,
        false,
    )
    const secondPayload = "A distinct prior payload 🐈"
    const second = structuredClone(predecessor)
    second.protectedChildEvidence!.entries.push({
        ...old.entries[0],
        payload: secondPayload,
        payloadHash: summaryHash(secondPayload),
    })
    second.summary += secondPayload
    const multiple = assembleChildEvidence(2, second.summary, [], [], [second], value.context, [])
    assert.equal(multiple.complete, true)
    assert.deepEqual(
        multiple.entries.map((entry) => entry.payload),
        [old.entries[0].payload, secondPayload],
    )
})

test("JSON-string hashes distinguish lone surrogates and preserve literal Unicode", () => {
    assert.notEqual(summaryHash("\ud800"), summaryHash("\ud801"))
    assert.notEqual(summaryHash("\ud800"), summaryHash("�"))
    assert.notEqual(summaryHash("é"), summaryHash("e\u0301"))
})

test("multiple ordinary consumed generations keep capture identity through reload", async () => {
    const value = await protect()
    store(value)
    for (const id of [2, 3]) {
        const prior = value.state.prune.messages.blocksById.get(id - 1)!
        const evidence = assembleChildEvidence(
            id,
            value.output,
            [],
            [],
            [prior],
            value.context,
            [],
            value.state.prune.messages.blocksById,
        )
        assert.equal(evidence.complete, true)
        assert.equal(evidence.entries[0].capturedBlockId, 1)
        applyCompressionState(
            value.state,
            {
                topic: "Nested",
                batchTopic: "Nested",
                startId: "m0001",
                endId: "m0001",
                mode: "range",
                runId: id,
                compressMessageId: `origin-${id}`,
                summaryTokens: 1,
                protectedChildEvidence: evidence,
            },
            { ...value.selection, messageIds: [], toolIds: [], messageTokenById: new Map() },
            "parent",
            id,
            value.output,
            [id - 1],
        )
    }
    const loaded = await loadPruneMessagesState(
        JSON.parse(JSON.stringify(serializePruneMessagesState(value.state.prune.messages))),
    )
    assert.equal(loaded.blocksById.get(3)!.protectedChildEvidence!.complete, true)
    assert.equal(loaded.blocksById.get(3)!.protectedChildEvidence!.entries[0].capturedBlockId, 1)
    assert.equal(loaded.savedBlockSnapshots!.size, 3)
})

test("metadata round-trips with exact saved proof; invalid present evidence stays incomplete without proof", async () => {
    const value = await protect()
    const original = store(value)
    const persisted = JSON.parse(
        JSON.stringify(serializePruneMessagesState(value.state.prune.messages)),
    )
    const restored = await loadPruneMessagesState(persisted)
    assert.deepEqual(
        JSON.parse(JSON.stringify(restored.blocksById.get(1))),
        JSON.parse(JSON.stringify(original)),
    )
    assert.equal(restored.savedBlockSnapshots!.get(1), JSON.stringify(original))
    for (const mutate of [
        (block: any) => (block.protectedChildEvidence.version = 99),
        (block: any) => (block.protectedChildEvidence.entries[0].payload += "changed"),
        (block: any) => (block.protectedChildEvidence.entries[0].payloadHash = "0".repeat(64)),
        (block: any) => (block.protectedChildEvidence.entries[0].sourceMessageId = "outside"),
        (block: any) => (block.protectedChildEvidence.entries[0].callId = "outside"),
        (block: any) => (block.protectedChildEvidence.entries[0].capturedBlockId = 99),
        (block: any) => (block.protectedChildEvidence.entries[0].childSessionId = ""),
        (block: any) => (block.protectedChildEvidence.complete = "yes"),
        (block: any) => (block.effectiveToolIds = []),
        (block: any) => (block.summary = "payload missing"),
    ]) {
        const changed = structuredClone(persisted)
        mutate(changed.blocksById["1"])
        const loaded = await loadPruneMessagesState(changed)
        assert.deepEqual(loaded.blocksById.get(1)!.protectedChildEvidence, {
            version: 1,
            complete: false,
            entries: [],
        })
        assert.equal(loaded.blocksById.get(1)!.summary, changed.blocksById["1"].summary)
        assert.equal(loaded.savedBlockSnapshots!.has(1), false)
    }
    const legacy = structuredClone(persisted)
    delete legacy.blocksById["1"].protectedChildEvidence
    assert.equal(
        (await loadPruneMessagesState(legacy)).blocksById.get(1)!.protectedChildEvidence,
        undefined,
    )
    assert.equal(
        validChildEvidence({ version: 1, complete: true, entries: [null] }, original),
        false,
    )
})
