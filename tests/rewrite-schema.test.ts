import assert from "node:assert/strict"
import test from "node:test"
import { tool } from "@opencode-ai/plugin"
import { createCompressRangeTool } from "../lib/compress/range"
import { createCompressMessageTool } from "../lib/compress/message"
import { createSessionState } from "../lib/state"
import { Logger } from "../lib/logger"
import { rangeFormat, messageFormat } from "../lib/prompts/extensions/tool"
function context(supported = false): any {
    return {
        state: createSessionState(),
        logger: new Logger(false),
        client: {},
        config: { compress: { mode: "range" } },
        nativeInputProof: supported ? true : undefined,
        supportsRewrite: supported ? true : undefined,
        prompts: {
            reload() {},
            getRuntimePrompts: () => ({
                compressRange: "CUSTOM EDITABLE PREFIX",
                compressMessage: "CUSTOM EDITABLE PREFIX",
            }),
        },
    }
}
test("unsupported V1 range/message actual parsers and direct executors reject present flags, including false", async () => {
    for (const mode of ["range", "message"]) {
        const definition =
            mode === "range"
                ? createCompressRangeTool(context())
                : createCompressMessageTool(context())
        for (const rewrite of [false, true, null, "true", 1]) {
            const input: any = {
                topic: "Synthetic",
                content: [
                    mode === "range"
                        ? { startId: "m0001", endId: "m0001", summary: "Summary", rewrite }
                        : { messageId: "m0001", topic: "Synthetic", summary: "Summary", rewrite },
                ],
            }
            assert.throws(() => tool.schema.object(definition.args).parse(input))
            await assert.rejects(definition.execute(input, {} as any), /unsupported/)
        }
        assert.ok(!definition.description.includes("EXPLICIT SUMMARY REWRITE"))
    }
})
test("supported optional boolean has no materialised default and mandatory rules survive editable overrides", () => {
    const definition = createCompressRangeTool(context(true)),
        parser = tool.schema.object(definition.args)
    const input = {
        topic: "Synthetic",
        content: [{ startId: "b1", endId: "b1", summary: "Summary" }],
    }
    assert.equal(Object.hasOwn(parser.parse(input).content[0]!, "rewrite"), false)
    for (const rewrite of [false, true])
        assert.equal(
            (
                parser.parse({ ...input, content: [{ ...input.content[0], rewrite }] })
                    .content[0] as any
            ).rewrite,
            rewrite,
        )
    for (const rewrite of [null, 1, "true"])
        assert.throws(() => parser.parse({ ...input, content: [{ ...input.content[0], rewrite }] }))
    assert.ok(definition.description.startsWith("CUSTOM EDITABLE PREFIX"))
    for (const text of [
        "Absent or false",
        "EVERY entry",
        "SAME active block ID",
        "strictly smaller",
        "Missing originals",
        "Do not retry automatically",
    ])
        assert.ok(definition.description.includes(text), text)
    assert.ok(!rangeFormat().includes("rewrite?:"))
    assert.ok(!messageFormat().includes("rewrite?:"))
})

test("F real schemas and direct executors reject invalid thresholds before permission, fetch or mutation", async () => {
    for (const supported of [false, true])
        for (const mode of ["range", "message"]) {
            const ctx = context(supported)
            ctx.state.lowYield = { assistantID: "pending", threshold: 10 }
            let effects = 0
            ctx.client = {
                session: {
                    messages: async () => {
                        effects++
                        throw new Error("unexpected fetch")
                    },
                },
            }
            const definition =
                mode === "range" ? createCompressRangeTool(ctx) : createCompressMessageTool(ctx)
            const parser = tool.schema.object(definition.args)
            const base: any = {
                topic: "Synthetic",
                content: [
                    mode === "range"
                        ? { startId: "m0001", endId: "m0001", summary: "Summary" }
                        : { messageId: "m0001", topic: "Synthetic", summary: "Summary" },
                ],
            }
            assert.equal(Object.hasOwn(parser.parse(base), "minimumReductionPercent"), false)
            for (const minimumReductionPercent of [0, 100])
                assert.equal(
                    (parser.parse({ ...base, minimumReductionPercent }) as any)
                        .minimumReductionPercent,
                    minimumReductionPercent,
                )
            for (const minimumReductionPercent of [NaN, Infinity, -Infinity, -1, 101, null, "10"]) {
                const input = { ...base, minimumReductionPercent }
                const before = structuredClone(ctx.state)
                assert.throws(() => parser.parse(input))
                await assert.rejects(
                    definition.execute(input, {
                        ask: async () => {
                            effects++
                        },
                    } as any),
                    /minimumReductionPercent/,
                )
                assert.deepEqual(ctx.state, before)
            }
            assert.equal(effects, 0)
        }
})
