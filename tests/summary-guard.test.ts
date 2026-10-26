import assert from "node:assert/strict"
import test from "node:test"
import { COMPRESS_INPUT_ARCHIVE_MARKER, validateSummaryContent } from "../lib/compress/summary"
import { validateArgs as rangeArgs } from "../lib/compress/range-utils"
import { validateArgs as messageArgs } from "../lib/compress/message-utils"
import { createCompressRangeTool } from "../lib/compress/range"
import { createCompressMessageTool } from "../lib/compress/message"
import { createSessionState } from "../lib/state"
import { Logger } from "../lib/logger"
import { rangePrompt } from "../lib/prompts/compress-range"
import { messagePrompt } from "../lib/prompts/compress-message"

const markers = [
    "[DCP: original submitted summary remains in stored history; represented by active compression 1.]",
    "[DCP: original submitted summary remains in stored history; represented by active compression 123. NOT summary content.]",
    COMPRESS_INPUT_ARCHIVE_MARKER,
]
const whitespace = ["", " ", "\n\t", "\r\n\u00a0"]
test("producer-coupled marker matrix rejects 72 whole trimmed markers and accepts 144 substantive quotations", () => {
    let rejected = 0,
        accepted = 0
    for (const marker of markers)
        for (const space of whitespace)
            for (const mode of ["range", "message"])
                for (const id of ["m0001", "@1@", "@m1@"]) {
                    const summary = `${space}${marker}${space}`
                    const validate = (text: string) =>
                        mode === "range"
                            ? rangeArgs({
                                  topic: "Decision",
                                  content: [{ startId: id, endId: id, summary: text }],
                              })
                            : messageArgs({
                                  topic: "Decision",
                                  content: [{ messageId: id, topic: "Decision", summary: text }],
                              })
                    assert.throws(() => validate(summary), /NOT summary content/)
                    rejected++
                    for (const quoted of [
                        `The historical view displayed ${summary}; native evidence retained the original prose.`,
                        `${summary}\nThis quotation documents an incident, not a replacement summary.`,
                    ]) {
                        assert.doesNotThrow(() => validate(quoted))
                        accepted++
                    }
                }
    assert.equal(rejected, 72)
    assert.equal(accepted, 144)
    assert.doesNotThrow(() =>
        validateSummaryContent(
            "Substantive non-empty prose is allowed, not guaranteed faithful.",
            "content[0]",
        ),
    )
    for (const marker of markers)
        assert.throws(
            () => validateSummaryContent(marker.replace(/ /g, "\n\t"), "content[0]"),
            /NOT summary content/,
        )
})

for (const mode of ["range", "message"] as const)
    test(`${mode} rejects a later batch marker before authorisation, prepare, counts or mutation`, async () => {
        const state = createSessionState()
        const before = structuredClone(state)
        let reads = 0
        const ctx: any = {
            state,
            logger: new Logger(false),
            config: {},
            client: new Proxy(
                {},
                {
                    get() {
                        reads++
                        throw new Error("Unexpected client read")
                    },
                },
            ),
            prompts: {
                reload() {},
                getRuntimePrompts: () => ({ compressRange: "range", compressMessage: "message" }),
            },
        }
        const tool = (mode === "range" ? createCompressRangeTool : createCompressMessageTool)(ctx)
        const entry = (summary: string) =>
            mode === "range"
                ? { startId: "m0001", endId: "m0001", summary }
                : { messageId: "m0001", topic: "Decision", summary }
        const context: any = {
            sessionID: "fixture",
            messageID: "origin",
            ask() {
                throw new Error("Unexpected authorisation")
            },
            metadata() {
                throw new Error("Unexpected metadata")
            },
        }
        await assert.rejects(
            tool.execute(
                {
                    topic: "Decision",
                    content: [
                        entry("Real summary"),
                        entry(` \n${COMPRESS_INPUT_ARCHIVE_MARKER}\t`),
                    ],
                } as any,
                context,
            ),
            /content\[1\].summary is DCP archive metadata/,
        )
        assert.equal(reads, 0)
        assert.deepEqual(state, before)
    })

test("prompt cues exist in runtime strings without assuming rendered template visibility", () => {
    for (const format of ["xml", "compact"] as const)
        for (const prompt of [rangePrompt(format), messagePrompt(format)]) {
            assert.ok(prompt.length > 100)
            assert.ok(prompt.includes("NOT original submitted arguments or summary content"))
            assert.ok(prompt.includes("or stop"))
        }
})
