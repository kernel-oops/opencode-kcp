import assert from "node:assert/strict"
import test, { after } from "node:test"
import fs from "node:fs/promises"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { syncBuiltinESMExports } from "node:module"
const root = await fs.mkdtemp(resolve(".impl-private/c3-public-"))
for (const key of [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "TMPDIR",
    "OPENCODE_CONFIG_DIR",
]) {
    process.env[key] = join(root, key)
    await fs.mkdir(process.env[key]!, { recursive: true })
}
after(() => fs.rm(root, { recursive: true, force: true }))
const plugin = process.env.DCP_PACKAGE_ENTRY
    ? (await import(process.env.DCP_PACKAGE_ENTRY)).default
    : await import("../lib/v2/index")
const { COMPRESS_INPUT_ARCHIVE_MARKER } = await import("../lib/compress/summary")
let next = 0
const captures: unknown[] = []
after(async () => {
    if (process.env.DCP_REWRITE_CAPTURE)
        await fs.writeFile(process.env.DCP_REWRITE_CAPTURE, JSON.stringify(captures, null, 2))
})
async function fixture(mode = "range", child = false) {
    const directory = join(root, `project-${++next}`)
    await fs.mkdir(join(directory, ".opencode"), { recursive: true })
    const configFile = join(directory, ".opencode/dcp.jsonc")
    const configure = async (mode: string) =>
        fs.writeFile(
            configFile,
            JSON.stringify({
                autoUpdate: false,
                pruneNotification: "off",
                commands: { enabled: true },
                experimental: { allowSubAgents: true },
                compress: {
                    mode,
                    permission: "allow",
                    protectedTools: child ? ["task"] : [],
                    protectUserMessages: false,
                    protectTags: false,
                },
                strategies: { deduplication: { enabled: false }, purgeErrors: { enabled: false } },
            }),
        )
    await configure(mode)
    const session: any = {
        id: `public-${next}`,
        agent: "build",
        model: { id: "fixture", providerID: "fixture" },
        permissions: [],
    }
    const raw = "Original raw receipt  \n\t"
    const A =
        "A literal </task_result> <subagent>🐈</subagent>\n<!-- dcp-subagent-result:v1 1 2 3 -->"
    let childText = A,
        childReads = 0,
        reads = 0
    const entries: any[] = [
        { id: "user", type: "user", text: "Investigate", time: { created: 1 } },
        {
            id: "source",
            type: "assistant",
            agent: "build",
            model: session.model,
            time: { created: 2 },
            content: child
                ? [
                      {
                          type: "tool",
                          id: "child-call",
                          name: "task",
                          state: {
                              status: "completed",
                              input: {},
                              metadata: { sessionId: "child" },
                              content: [{ type: "text", text: raw }],
                          },
                      },
                  ]
                : [{ type: "text", text: "Detailed current source ".repeat(300) }],
        },
        { id: "latest", type: "user", text: "Continue", time: { created: 3 } },
    ]
    let hooks: Record<string, any> = {},
        compress: any,
        commands: any[] = [],
        rpc: any
    const ctx: any = {
        location: { directory },
        session: {
            get: async ({ sessionID }: any) => ({ ...session, id: sessionID }),
            context: async ({ sessionID }: any) => {
                if (sessionID === "child") {
                    childReads++
                    if (childText === "THROW") throw new Error("child unavailable")
                    return [
                        {
                            id: "child-text",
                            type: "assistant",
                            agent: "build",
                            model: session.model,
                            time: { created: 1 },
                            content: [{ type: "text", text: childText }],
                        },
                    ]
                }
                reads++
                return structuredClone(entries)
            },
            hook: async (kind: string, callback: any) => (hooks[kind] = callback),
            prompt: async () => {
                throw new Error("no provider prompts")
            },
        },
        agent: { get: async () => ({ data: { permissions: [] } }) },
        tool: {
            transform: async (callback: any) => callback({ add: (tool: any) => (compress = tool) }),
        },
        command: {
            transform: async (callback: any) =>
                callback({ add: (command: any) => commands.push(command) }),
        },
        rpc: { register: async (_: any, handlers: any) => (rpc = handlers) },
    }
    let stop = await plugin.setup(ctx)
    function native() {
        return entries.flatMap((entry): any[] => {
            if (entry.type === "user")
                return [
                    { id: entry.id, role: "user", content: [{ type: "text", text: entry.text }] },
                ]
            if (entry.type !== "assistant") return []
            const content: any[] = [
                    { type: "reasoning", text: "Opaque reasoning", encrypted: "signature" },
                ],
                results: any[] = []
            for (const part of entry.content)
                if (part.type === "tool") {
                    content.push({
                        type: "tool-call",
                        id: part.id,
                        name: part.name,
                        input: structuredClone(part.state.input),
                    })
                    results.push({
                        type: "tool-result",
                        id: part.id,
                        name: part.name,
                        result: { type: "text", value: part.state.content[0].text },
                    })
                } else content.push(structuredClone(part))
            return [
                { id: entry.id, role: "assistant", content },
                ...(results.length ? [{ role: "tool", content: results }] : []),
            ]
        })
    }
    const context = (id: string) => ({
        id,
        sessionID: session.id,
        messageID: `origin-${id}`,
        agent: "build",
        progress: async () => {},
    })
    async function execute(input: any, id: string) {
        return compress.execute(input, context(id))
    }
    function append(input: any, result: any, id: string) {
        entries.splice(entries.length - 1, 0, {
            id: `origin-${id}`,
            type: "assistant",
            agent: "build",
            model: session.model,
            time: { created: 10 + entries.length },
            content: [
                {
                    type: "tool",
                    id,
                    name: "compress",
                    state: {
                        status: "completed",
                        input: structuredClone(input),
                        content: [{ type: "text", text: result.content }],
                    },
                },
            ],
        })
    }
    async function primary(kind = "context") {
        const original = native(),
            before = structuredClone(original)
        const event: any = {
            sessionID: session.id,
            agent: "build",
            model: session.model,
            system: [],
            tools: { compress: {} },
            messages: original,
        }
        await hooks[kind](event)
        assert.deepEqual(original, before)
        return event
    }
    // Await an actual save on the same file queue, not a sleep or timestamp suppression.
    const barrier = () => rpc.manual({ sessionID: session.id, enabled: false })
    const file = join(
        process.env.XDG_DATA_HOME!,
        "opencode/storage/plugin/dcp",
        `${session.id}.json`,
    )
    const persisted = async () => JSON.parse(await fs.readFile(file, "utf8"))
    const ordinary = {
        topic: "Synthetic",
        content: [
            mode === "message"
                ? { messageId: "@2@", topic: "Synthetic", summary: "Old narrative ".repeat(400) }
                : { startId: "@2@", endId: "@2@", summary: "Old narrative ".repeat(400) },
        ],
    }
    const rewrite = {
        topic: "Rewrite",
        content: [{ startId: "@b1@", endId: "@b1@", summary: "Short conclusion", rewrite: true }],
    }
    return {
        ctx,
        session,
        entries,
        ordinary,
        rewrite,
        execute,
        append,
        primary,
        barrier,
        persisted,
        file,
        manual: (enabled: boolean) => rpc.manual({ sessionID: session.id, enabled }),
        get compress() {
            return compress
        },
        reads: () => reads,
        childReads: () => childReads,
        setChild: (text: string) => (childText = text),
        raw,
        A,
        stop: () => stop?.(),
        switchToRange: async () => {
            stop?.()
            await configure("range")
            hooks = {}
            commands = []
            stop = await plugin.setup(ctx)
        },
        command: async (text: string) =>
            commands
                .find((command) => command.name === "dcp")
                .execute({ sessionID: session.id, prompt: { text } }),
    }
}

test("F public primary lifecycle: native usage, rejected C atomicity, one advisory, no persistence", async () => {
    const f = await fixture()
    try {
        // The caller is authoritative native history, not a projected WithParts record.
        f.entries.pop()
        const caller = {
            id: "origin-first",
            type: "assistant",
            agent: "build",
            model: f.session.model,
            time: { created: 3, completed: 4 },
            tokens: {
                input: 600,
                output: 99999,
                reasoning: 99999,
                cache: { read: 300, write: 100 },
            },
            content: [{ type: "text", text: "Compression caller" }],
        }
        f.entries.push(caller)
        await f.primary()
        assert.equal(
            Object.hasOwn(f.compress.input.parse(f.ordinary), "minimumReductionPercent"),
            false,
        )
        const firstInput = { ...f.ordinary, minimumReductionPercent: 0 }
        const firstResult = await f.execute(firstInput, "first")
        ;(caller.content as any[]).push({
            type: "tool",
            id: "first",
            name: "compress",
            state: {
                status: "completed",
                input: firstInput,
                content: [{ type: "text", text: firstResult.content }],
            },
        })
        // Same caller coalesces: latest threshold wins.
        const secondInput = {
            topic: "Second",
            minimumReductionPercent: 10,
            content: [
                { startId: "@b1@", endId: "@b1@", summary: "Coalesced narrative ".repeat(300) },
            ],
        }
        const secondResult = await f.compress.execute(secondInput, {
            id: "second",
            sessionID: f.session.id,
            messageID: caller.id,
            agent: "build",
            progress: async () => {},
        })
        ;(caller.content as any[]).push({
            type: "tool",
            id: "second",
            name: "compress",
            state: {
                status: "completed",
                input: secondInput,
                content: [{ type: "text", text: secondResult.content }],
            },
        })
        await f.primary()
        await f.barrier()
        const bytes = await fs.readFile(f.file, "utf8")
        assert.equal(bytes.includes("lowYield"), false)
        await assert.rejects(
            f.execute(
                {
                    topic: "Rejected",
                    content: [
                        {
                            startId: "@b2@",
                            endId: "@b2@",
                            summary: "Not smaller ".repeat(3000),
                            rewrite: true,
                        },
                    ],
                },
                "bad",
            ),
            /strictly shrink/,
        )
        assert.equal(await fs.readFile(f.file, "utf8"), bytes)
        for (const input of [
            {
                topic: "Invalid threshold",
                minimumReductionPercent: Infinity,
                content: [{ startId: "@b2@", endId: "@b2@", summary: "Short", rewrite: true }],
            },
            {
                topic: "Mixed",
                content: [
                    { startId: "@b2@", endId: "@b2@", summary: "Short", rewrite: true },
                    { startId: "@b2@", endId: "@b2@", summary: "Ordinary" },
                ],
            },
            {
                topic: "Unknown",
                content: [{ startId: "@b999@", endId: "@b999@", summary: "Short", rewrite: true }],
            },
            {
                topic: "Placeholder",
                content: [{ startId: "@b2@", endId: "@b2@", summary: "@b2@", rewrite: true }],
            },
        ]) {
            await assert.rejects(f.execute(input, "rejected"))
            assert.equal(await fs.readFile(f.file, "utf8"), bytes)
        }
        const successor = structuredClone(caller)
        successor.id = "next"
        successor.time = { created: 5, completed: 6 }
        successor.tokens.input = 500
        successor.content = [{ type: "text", text: "Next completed reply" }]
        f.entries.push(successor)
        const event = await f.primary()
        const text = JSON.stringify(event.messages)
        assert.match(text, /1000 → 900/)
        assert.ok(text.includes(COMPRESS_INPUT_ARCHIVE_MARKER))
        assert.equal(text.split("Observed next-prompt input usage").length - 1, 1)
        assert.doesNotMatch(
            JSON.stringify((await f.primary()).messages),
            /Observed next-prompt input usage/,
        )
        captures.push({ feature: "F", messages: event.messages })
    } finally {
        f.stop()
    }
})

for (const cancellation of ["rewrite", "compaction", "command", "missing-usage", "later-call"])
    test(`F public lifecycle cancellation: ${cancellation}`, async () => {
        const f = await fixture()
        try {
            f.entries.pop()
            const caller: any = {
                id: "origin-first",
                type: "assistant",
                agent: "build",
                model: f.session.model,
                time: { created: 3, completed: 4 },
                tokens: { input: 1000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                content: [{ type: "text", text: "Compression caller" }],
            }
            f.entries.push(caller)
            await f.primary()
            const reads = f.reads()
            for (const value of [NaN, Infinity, -1, 101])
                await assert.rejects(
                    f.execute({ ...f.ordinary, minimumReductionPercent: value }, "invalid"),
                    /minimumReductionPercent/,
                )
            assert.equal(f.reads(), reads)
            const firstResult = await f.execute(f.ordinary, "first")
            caller.content.push({
                type: "tool",
                id: "first",
                name: "compress",
                state: {
                    status: "completed",
                    input: f.ordinary,
                    content: [{ type: "text", text: firstResult.content }],
                },
            })
            if (cancellation === "rewrite") {
                await f.primary()
                await f.execute(
                    {
                        topic: "Shorter",
                        content: [
                            {
                                startId: "@b1@",
                                endId: "@b1@",
                                summary: "Concise conclusion",
                                rewrite: true,
                            },
                        ],
                    },
                    "rewrite",
                )
            }
            if (cancellation === "compaction") await f.primary("compaction")
            if (cancellation === "command") await f.command("stats")
            if (cancellation === "later-call")
                await f.execute(
                    {
                        topic: "Later",
                        content: [
                            {
                                startId: "@b1@",
                                endId: "@b1@",
                                summary: "Later narrative ".repeat(200),
                            },
                        ],
                    },
                    "later",
                )
            const successor = structuredClone(caller)
            successor.id = "next"
            successor.time = { created: 5, completed: 6 }
            successor.content = [{ type: "text", text: "Next completed reply" }]
            if (cancellation === "missing-usage") delete successor.tokens
            f.entries.push(successor)
            assert.doesNotMatch(
                JSON.stringify((await f.primary()).messages),
                /Observed next-prompt input usage/,
            )
        } finally {
            f.stop()
        }
    })

test("active summary rewrite forgets obsolete prose while retaining current authority and unknowns", async () => {
    const f = await fixture()
    try {
        const retained =
            "Local checks passed; evidence: fixtures/checks.json. No deployment authorised. Final guarded core qualification remains unknown."
        const obsolete = "Obsolete failed experiment and superseded diagnostic detail. ".repeat(200)
        f.ordinary.content[0].summary = obsolete + retained
        const first = await f.execute(f.ordinary, "first")
        f.append(f.ordinary, first, "first")
        await f.primary()
        f.rewrite.content[0].summary = retained
        const second = await f.execute(f.rewrite, "second")
        f.append(f.rewrite, second, "second")
        const after = await f.primary()
        await f.barrier()
        const active = (await f.persisted()).prune.messages.blocksById["2"]
        assert.ok(active.active)
        assert.ok(active.summary.includes(retained))
        assert.ok(!active.summary.includes("Obsolete failed experiment"))
        assert.ok(JSON.stringify(after.messages).includes(retained))
        assert.ok(!JSON.stringify(after.messages).includes("Obsolete failed experiment"))
    } finally {
        f.stop()
    }
})

for (const child of [false, true])
    test(`public primary rewrite lifecycle preserves native data${child ? " and protected A without latest-child reads" : ""}`, async () => {
        const f = await fixture("range", child)
        try {
            const parsed = f.compress.input.parse(f.ordinary)
            assert.equal(Object.hasOwn(parsed.content[0], "rewrite"), false)
            const first = await f.execute(f.ordinary, "first")
            f.append(f.ordinary, first, "first")
            const beforeRewrite = await f.primary()
            await f.barrier()
            assert.ok(JSON.stringify(beforeRewrite.messages).includes("Old narrative"))
            const childReads = f.childReads()
            f.setChild("THROW")
            const native = structuredClone(f.entries)
            const second = await f.execute(f.rewrite, "second")
            assert.match(second.content, /net DCP summary-token reduction/)
            assert.equal(f.childReads(), childReads)
            assert.deepEqual(f.entries, native)
            f.append(f.rewrite, second, "second")
            const after = await f.primary()
            await f.barrier()
            const call = after.messages
                .find((message: any) => message.id === "origin-second")
                .content.find((part: any) => part.type === "tool-call")
            assert.equal(call.input.content[0].summary, COMPRESS_INPUT_ARCHIVE_MARKER)
            assert.equal(
                f.entries.find((entry) => entry.id === "origin-second").content[0].state.input
                    .content[0].summary,
                "Short conclusion",
            )
            assert.ok(
                after.messages
                    .filter((message: any) => message.role === "assistant")
                    .every((message: any) => message.content[0].encrypted === "signature"),
            )
            const saved = await f.persisted(),
                old = saved.prune.messages.blocksById["1"],
                successor = saved.prune.messages.blocksById["2"]
            assert.deepEqual(successor.consumedBlockIds, [1])
            assert.equal(old.active, false)
            assert.equal(successor.compressedTokens, 0)
            assert.equal(
                successor.originalSummaryHash,
                createHash("sha256").update(JSON.stringify("Short conclusion")).digest("hex"),
            )
            if (child) {
                assert.ok(successor.summary.includes(f.A))
                assert.ok(successor.summary.includes(f.raw))
                assert.equal(successor.protectedChildEvidence.complete, true)
            }
            const stable = (block: any) => {
                const { createdAt, durationMs, deactivatedAt, ...record } = block
                return record
            }
            captures.push({
                child,
                primary: true,
                predecessor: stable(old),
                successor: stable(successor),
                outgoingInput: call.input,
            })
            const baseline = await f.persisted()
            const bad = structuredClone(f.rewrite)
            bad.content[0].summary = COMPRESS_INPUT_ARCHIVE_MARKER
            await assert.rejects(f.execute(bad, "bad"), /NOT summary content/)
            assert.deepEqual(await f.persisted(), baseline)
        } finally {
            f.stop()
        }
    })

test("actual schemas and pre-load dispatch reject invalid/mixed/unsupported flags", async () => {
    for (const mode of ["range", "message"]) {
        const f = await fixture(mode)
        try {
            for (const flag of [null, "true", 1, false, true]) {
                const input: any = structuredClone(f.ordinary)
                input.content[0].rewrite = flag
                if (mode === "range" && typeof flag === "boolean") continue
                const reads = f.reads()
                assert.throws(() => f.compress.input.parse(input))
                await assert.rejects(f.execute(input, "bad"))
                assert.equal(f.reads(), reads)
            }
            if (mode === "range") {
                const mixed = {
                    topic: "Mixed",
                    content: [f.rewrite.content[0], f.ordinary.content[0]],
                }
                const reads = f.reads()
                await assert.rejects(f.execute(mixed, "mixed"), /Mixed/)
                assert.equal(f.reads(), reads)
                await assert.rejects(f.execute(f.rewrite, "not-initialised"), /initialised/)
            }
        } finally {
            f.stop()
        }
    }
})

test("fresh permission deny/ask, manual mode and missing current originals reject without rewriting", async () => {
    const f = await fixture()
    try {
        const first = await f.execute(f.ordinary, "first")
        f.append(f.ordinary, first, "first")
        await f.primary()
        await f.barrier()
        for (const effect of ["deny", "ask"]) {
            f.session.permissions = [{ action: "compress", resource: "*", effect }]
            const before = await f.persisted()
            await assert.rejects(f.execute(f.rewrite, effect))
            assert.deepEqual(await f.persisted(), before)
        }
        f.session.permissions = []
        await f.ctx.session.get({ sessionID: f.session.id })
        f.entries.splice(1, 1)
        const before = await f.persisted()
        await assert.rejects(f.execute(f.rewrite, "missing"))
        assert.deepEqual(await f.persisted(), before)
    } finally {
        f.stop()
    }
})

test("message-created predecessor can be rewritten in range mode and decompressed through predecessor to originals", async () => {
    const f = await fixture("message")
    try {
        const first = await f.execute(f.ordinary, "first")
        f.append(f.ordinary, first, "first")
        await f.switchToRange()
        await f.primary()
        await f.barrier()
        const second = await f.execute(f.rewrite, "second")
        f.append(f.rewrite, second, "second")
        await f.primary()
        await f.barrier()
        await f.command("decompress 2")
        await f.barrier()
        assert.equal((await f.persisted()).prune.messages.blocksById["1"].active, true)
        await f.command("decompress 1")
        await f.barrier()
        assert.deepEqual((await f.persisted()).prune.messages.activeBlockIds, [])
        assert.ok(JSON.stringify((await f.primary()).messages).includes("Detailed current source"))
    } finally {
        f.stop()
    }
})

test("compaction-prefix visibility is insufficient; manual and newer native compaction reject without preparation", async () => {
    const f = await fixture()
    try {
        const first = await f.execute(f.ordinary, "first")
        f.append(f.ordinary, first, "first")
        await f.primary("compaction")
        await f.barrier()
        let before = await f.persisted()
        await assert.rejects(f.execute(f.rewrite, "invisible"), /visible/)
        assert.deepEqual(await f.persisted(), before)
        await f.primary()
        await f.barrier()
        await f.manual(true)
        before = await f.persisted()
        await assert.rejects(f.execute(f.rewrite, "manual"), /Manual mode/)
        assert.deepEqual(await f.persisted(), before)
        await f.manual(false)
        f.entries.splice(f.entries.length - 1, 0, {
            id: "checkpoint",
            type: "compaction",
            status: "completed",
            time: { created: 999 },
        })
        before = await f.persisted()
        await assert.rejects(f.execute(f.rewrite, "compacted"), /generation changed/)
        assert.deepEqual(await f.persisted(), before)
    } finally {
        f.stop()
    }
})

test("new rewrite may elide while a legacy predecessor's own uncertain arguments remain", async () => {
    const f = await fixture()
    try {
        const first = await f.execute(f.ordinary, "first")
        f.append(f.ordinary, first, "first")
        const state = await f.persisted()
        delete state.prune.messages.blocksById["1"].originalSummaryHash
        await fs.writeFile(f.file, JSON.stringify(state))
        await f.switchToRange()
        await f.primary()
        await f.barrier()
        assert.equal(
            Object.hasOwn(
                (await f.persisted()).prune.messages.blocksById["1"],
                "originalSummaryHash",
            ),
            false,
        )
        const second = await f.execute(f.rewrite, "second")
        f.append(f.rewrite, second, "second")
        const event = await f.primary()
        const call = (id: string) =>
            event.messages
                .find((message: any) => message.id === `origin-${id}`)
                .content.find((part: any) => part.type === "tool-call")
        assert.equal(call("first").input.content[0].summary, f.ordinary.content[0].summary)
        assert.equal(call("second").input.content[0].summary, COMPRESS_INPUT_ARCHIVE_MARKER)
        await f.barrier()
        assert.equal(
            Object.hasOwn(
                (await f.persisted()).prune.messages.blocksById["1"],
                "originalSummaryHash",
            ),
            false,
        )
    } finally {
        f.stop()
    }
})

test("public child legacy/incomplete/tampered evidence refuses despite current cache or receipt", async () => {
    for (const kind of ["absent", "incomplete", "tampered"]) {
        const f = await fixture("range", true)
        try {
            const first = await f.execute(f.ordinary, "first")
            f.append(f.ordinary, first, "first")
            const saved = await f.persisted(),
                block = saved.prune.messages.blocksById["1"]
            if (kind === "absent") delete block.protectedChildEvidence
            if (kind === "incomplete") block.protectedChildEvidence.complete = false
            if (kind === "tampered")
                block.protectedChildEvidence.entries[0].payloadHash = "0".repeat(64)
            await fs.writeFile(f.file, JSON.stringify(saved))
            await f.switchToRange()
            await f.primary()
            await f.barrier()
            const reads = f.childReads(),
                before = await f.persisted()
            await assert.rejects(f.execute(f.rewrite, kind))
            assert.deepEqual(await f.persisted(), before)
            assert.equal(f.childReads(), reads)
        } finally {
            f.stop()
        }
    }
})

test("adapter follow-up save failure stays committed and retains unproved arguments", async (t) => {
    const f = await fixture()
    try {
        const first = await f.execute(f.ordinary, "first")
        f.append(f.ordinary, first, "first")
        await f.primary()
        await f.barrier()
        const rename = fs.rename,
            now = Date.now()
        let writes = 0,
            ticks = 0
        t.mock.method(Date, "now", () => now + ++ticks * 100)
        t.mock.method(fs, "rename", async (...args) => {
            if (++writes >= 2) throw new Error("synthetic follow-up save failure")
            return rename(...args)
        })
        syncBuiltinESMExports()
        t.after(() => {
            t.mock.restoreAll()
            syncBuiltinESMExports()
        })
        const result = await f.execute(f.rewrite, "second")
        assert.match(result.content, /Rewrote/)
        assert.equal(writes, 2)
        assert.ok((await f.persisted()).prune.messages.blocksById["2"])
        f.append(f.rewrite, result, "second")
        const event = await f.primary()
        const call = event.messages
            .find((message: any) => message.id === "origin-second")
            .content.find((part: any) => part.type === "tool-call")
        assert.equal(call.input.content[0].summary, "Short conclusion")
    } finally {
        f.stop()
    }
})

test("public batches reject one growing member atomically, then commit and elide every proven member", async () => {
    const f = await fixture()
    try {
        const ordinary: any = structuredClone(f.ordinary)
        ordinary.content.unshift({ ...ordinary.content[0], startId: "@1@", endId: "@1@" })
        const first = await f.execute(ordinary, "first")
        f.append(ordinary, first, "first")
        await f.primary()
        await f.barrier()
        const input: any = structuredClone(f.rewrite)
        input.content.push({
            ...input.content[0],
            startId: "@b2@",
            endId: "@b2@",
            summary: "growth ".repeat(5000),
        })
        const before = await f.persisted()
        await assert.rejects(f.execute(input, "growth"), /strictly shrink/)
        assert.deepEqual(await f.persisted(), before)
        input.content[1].summary = "Short second conclusion"
        const result = await f.execute(input, "second")
        f.append(input, result, "second")
        const event = await f.primary()
        const call = event.messages
            .find((message: any) => message.id === "origin-second")
            .content.find((part: any) => part.type === "tool-call")
        assert.ok(
            call.input.content.every(
                (entry: any) => entry.summary === COMPRESS_INPUT_ARCHIVE_MARKER,
            ),
        )
        assert.deepEqual((await f.persisted()).prune.messages.activeBlockIds, [3, 4])
    } finally {
        f.stop()
    }
})

test("registered rewrite and manual operations retain the existing per-session queue", async (t) => {
    const f = await fixture()
    try {
        const first = await f.execute(f.ordinary, "first")
        f.append(f.ordinary, first, "first")
        await f.primary()
        await f.barrier()
        let entered!: () => void, release!: () => void
        const ready = new Promise<void>((resolve) => (entered = resolve)),
            gate = new Promise<void>((resolve) => (release = resolve))
        const rename = fs.rename
        let held = false
        t.mock.method(fs, "rename", async (...args) => {
            if (!held) {
                held = true
                entered()
                await gate
            }
            return rename(...args)
        })
        syncBuiltinESMExports()
        t.after(() => {
            t.mock.restoreAll()
            syncBuiltinESMExports()
        })
        const pending = f.execute(f.rewrite, "second")
        await ready
        let manualFinished = false
        const manual = f.manual(true).then(() => (manualFinished = true))
        assert.equal(manualFinished, false)
        release()
        assert.match((await pending).content, /Rewrote/)
        await manual
        assert.equal((await f.persisted()).manualMode, true)
    } finally {
        f.stop()
    }
})

test("adapter post-commit timing failure cannot turn a committed rewrite into a retryable failure", async (t) => {
    const f = await fixture()
    try {
        const first = await f.execute(f.ordinary, "first")
        f.append(f.ordinary, first, "first")
        await f.primary()
        await f.barrier()
        const now = Date.now()
        let calls = 0
        t.mock.method(Date, "now", () => {
            if (++calls === 4) throw new Error("post-commit clock failure")
            return now + calls * 100
        })
        t.after(() => t.mock.restoreAll())
        const result = await f.execute(f.rewrite, "second")
        assert.match(result.content, /Rewrote/)
        assert.equal(calls, 4)
        assert.ok((await f.persisted()).prune.messages.blocksById["2"])
    } finally {
        f.stop()
    }
})

test("invalid flags do not consume an actual queued manual compression trigger", async () => {
    const f = await fixture()
    try {
        const first = await f.execute(f.ordinary, "first")
        f.append(f.ordinary, first, "first")
        await f.primary()
        await f.barrier()
        await f.manual(true)
        let prompts = 0
        // Synthetic delivery sink only: no provider or live session is contacted.
        f.ctx.session.prompt = async () => {
            prompts++
        }
        await f.command("compress")
        assert.equal(prompts, 1)
        const before = await f.persisted(),
            reads = f.reads(),
            invalid: any = structuredClone(f.rewrite)
        invalid.content[0].rewrite = null
        await assert.rejects(f.execute(invalid, "invalid"))
        assert.equal(f.reads(), reads)
        assert.deepEqual(await f.persisted(), before)
        assert.match((await f.execute(f.rewrite, "second")).content, /Rewrote/)
        assert.equal((await f.persisted()).manualMode, false)
    } finally {
        f.stop()
    }
})

test("explicit false remains ordinary reinsertion rather than an implicit equal-boundary rewrite", async () => {
    const f = await fixture()
    try {
        const first = await f.execute(f.ordinary, "first")
        f.append(f.ordinary, first, "first")
        await f.primary()
        await f.barrier()
        const input = {
            topic: "Ordinary again",
            content: [{ ...f.rewrite.content[0], rewrite: false, summary: "Ordinary insertion" }],
        }
        const second = await f.execute(input, "second")
        assert.match(second.content, /^Compressed/)
        f.append(input, second, "second")
        const saved = await f.persisted(),
            block = saved.prune.messages.blocksById["2"]
        assert.ok(block.summary.includes("Old narrative"))
        assert.equal(block.startId, "@b1@")
        const event = await f.primary()
        const call = event.messages
            .find((message: any) => message.id === "origin-second")
            .content.find((part: any) => part.type === "tool-call")
        assert.equal(call.input.content[0].rewrite, false)
        assert.equal(call.input.content[0].summary, COMPRESS_INPUT_ARCHIVE_MARKER)
    } finally {
        f.stop()
    }
})

test("public reload rejects persisted unsafe/overflow allocation without changing prose or the file", async () => {
    for (const counter of ["nextBlockId", "nextRunId"] as const)
        for (const value of [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
            const f = await fixture()
            try {
                const first = await f.execute(f.ordinary, "first")
                f.append(f.ordinary, first, "first")
                const saved = await f.persisted()
                saved.prune.messages[counter] = value
                await fs.writeFile(f.file, JSON.stringify(saved))
                await f.switchToRange()
                await f.primary()
                await f.barrier()
                const before = await fs.readFile(f.file, "utf8")
                await assert.rejects(f.execute(f.rewrite, "unsafe"), /allocation/i)
                assert.equal(await fs.readFile(f.file, "utf8"), before)
                assert.ok(
                    (await f.persisted()).prune.messages.blocksById["1"].summary.includes(
                        "Old narrative",
                    ),
                )
            } finally {
                f.stop()
            }
        }
})

test("public legacy timestamp proof requires globally unique native identity and a complete batch", async () => {
    for (const kind of ["valid", "duplicate-global-call", "alias-in-origin", "malformed-extra"]) {
        const f = await fixture()
        try {
            const first = await f.execute(f.ordinary, "first")
            f.append(f.ordinary, first, "first")
            const initial = await f.persisted()
            delete initial.prune.messages.blocksById["1"].originalSummaryHash
            await fs.writeFile(f.file, JSON.stringify(initial))
            await f.switchToRange()
            await f.primary()
            await f.barrier()
            const second = await f.execute(f.rewrite, "second")
            f.append(f.rewrite, second, "second")
            const saved = await f.persisted()
            saved.prune.messages.blocksById["1"].deactivatedAt = 123
            await fs.writeFile(f.file, JSON.stringify(saved))
            await f.switchToRange()
            const origin = f.entries.find((entry) => entry.id === "origin-second")!
            if (kind === "duplicate-global-call")
                f.entries.splice(f.entries.length - 1, 0, {
                    ...structuredClone(origin),
                    id: "duplicate-native-origin",
                })
            if (kind === "alias-in-origin")
                origin.content.push({ ...structuredClone(origin.content[0]), name: "read" })
            if (kind === "malformed-extra")
                origin.content[0].state.input.content.push({ rewrite: true })
            const nativeBefore = structuredClone(f.entries)
            await f.primary()
            await f.barrier()
            assert.deepEqual(f.entries, nativeBefore)
            const current = (await f.persisted()).prune.messages.blocksById["1"]
            assert.equal(current.originalSummaryHash, undefined)
            if (kind === "valid") assert.equal(current.deactivatedAt, 123)
            else assert.notEqual(current.deactivatedAt, 123)
        } finally {
            f.stop()
        }
    }
})
