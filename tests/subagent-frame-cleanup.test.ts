import assert from "node:assert/strict"
import test from "node:test"
import { injectExtendedSubAgentResults as inject } from "../lib/messages/inject/subagent-results"
import { stripHallucinations } from "../lib/messages/utils"
import { createSessionState, type WithParts } from "../lib/state"
import { Logger } from "../lib/logger"
import { appendProtectedTools } from "../lib/compress/protected-content"
import { buildSearchContext, resolveSelection } from "../lib/compress/search"
import { transformSubagentResultOutput } from "../lib/subagents/subagent-results"
import {
    cleanExpectedFrame,
    expectedFrameParts,
    expectedFrameWithRawBody,
    renderExpectedFrame,
    stripContentOnce,
} from "./fixtures/subagent-cleanup"

test("outer-frame cleanup preserves all caller transitions across synthetic and literal content", async () => {
    const token = "@" + "23" + "@"
    const nestedLiteral = renderExpectedFrame(
        "Nested receipt\n<task_result>\n",
        `Nested ${token} literal 🦋`,
        "\n</task_result>",
    )
    const xml = "<dc".repeat(64) + "<dcp-example>" + "p-demo>".repeat(64)
    const compact = "@".repeat(64) + "23@" + "24@".repeat(63)
    const families = [
        ["xml-depth64", xml, xml],
        ["compact-depth64", compact, compact],
        ["mixed", "@<dcp-example/>24@", "@<dcp-example/>24@"],
        [
            "suffix",
            "Receipt\nm0023</parameter><dcp-example/>",
            "Payload\nm0023</parameter><dcp-example/>",
        ],
        ["literal-nested-frame", nestedLiteral, nestedLiteral],
        ["exposed-cross-boundary", "<dc<dcp/>p-demo>", "Preserve child payload</dc<dcp/>p-demo>"],
        [
            "literal-structure",
            "<dcp-example",
            "Literal <task_result> and </subagent>\n<!-- dcp-subagent-result:v1 1 2 3 -->",
        ],
    ]
    let cases = 0
    for (const tool of ["task", "subagent"])
        for (const format of ["xml", "compact"] as const) {
            for (const placement of ["receipt", "body", "both"])
                for (const [name, receiptArtifact, bodyArtifact] of families) {
                    const clean = (text: string) => stripContentOnce(text, format)
                    const receipt =
                        'Launch 🦋\nSession ID: ses_example\n<metadata>literal "</SubAgent>"</metadata>' +
                        (placement !== "body" ? "\n" + receiptArtifact : "")
                    let raw =
                        placement !== "receipt" ? "Selected " + bodyArtifact : "Selected final."
                    let mode = "text"
                    const state = createSessionState(format)
                    const messages = [
                        {
                            info: { id: "parent", role: "assistant", time: { created: 1 } },
                            parts: [
                                {
                                    type: "tool",
                                    tool,
                                    callID: "call",
                                    state: {
                                        status: "completed",
                                        input: {},
                                        output: receipt,
                                        metadata: { sessionId: "ses_example" },
                                    },
                                },
                            ],
                        },
                    ] as unknown as WithParts[]
                    const part = messages[0].parts[0] as any
                    const client = {
                        session: {
                            messages: async () => {
                                if (mode === "failure") throw new Error("Synthetic unavailable")
                                return {
                                    data: [
                                        {
                                            info: {
                                                id: "child",
                                                sessionID: "ses_example",
                                                role: "assistant",
                                                time: { created: 1 },
                                            },
                                            parts:
                                                mode === "empty"
                                                    ? []
                                                    : [{ type: "text", text: raw }],
                                        },
                                    ],
                                }
                            },
                        },
                    }
                    let expected = renderExpectedFrame(
                        clean(receipt) + "\n\n<task_result>\n",
                        clean(raw.trim()),
                        "\n</task_result>",
                    )
                    const check = (stage: string) => {
                        assert.equal(
                            part.state.output,
                            expected,
                            `${tool}/${format}/${placement}/${name}/${stage}`,
                        )
                        expectedFrameParts(part.state.output)
                    }
                    await inject(client, state, new Logger(false), messages, true)
                    check("initial")
                    assert.equal(state.subAgentResultCache.get("call"), raw.trim())
                    for (let round = 0; round < 3; round++) {
                        stripHallucinations(messages, format)
                        expected = cleanExpectedFrame(expected, format)
                        check("host-" + round)
                        await inject(client, state, new Logger(false), messages, true)
                        expected = cleanExpectedFrame(expected, format, raw.trim())
                        check("cached-" + round)
                    }
                    const context = buildSearchContext(state, messages)
                    const boundary = { kind: "message" as const, rawIndex: 0, messageId: "parent" }
                    const selection = await resolveSelection(context, boundary, boundary)
                    const summaryPrefix = `Summary\n\nThe following protected tools were used in this conversation as well:\n### Tool: ${tool}\n`
                    for (const cached of [true, false]) {
                        if (!cached) state.subAgentResultCache.clear()
                        assert.equal(
                            await appendProtectedTools(
                                client,
                                state,
                                true,
                                "Summary",
                                selection,
                                context,
                                [tool],
                            ),
                            summaryPrefix + expectedFrameWithRawBody(expected, raw.trim()),
                        )
                        check("protected-" + cached)
                    }
                    raw = "Fresh complete final 🦋."
                    state.subAgentResultCache.clear()
                    await inject(client, state, new Logger(false), messages, true)
                    expected = cleanExpectedFrame(expected, format, raw)
                    check("fetched-update")
                    raw = format === "compact" ? token : "<dcp-example>synthetic only</dcp-example>"
                    state.subAgentResultCache.set("call", raw)
                    await inject(client, state, new Logger(false), messages, true)
                    expected = cleanExpectedFrame(expected, format, raw)
                    assert.equal(expectedFrameParts(expected).body, "")
                    check("meaningful-id-only-clears")
                    const beforeUnavailable = part.state.output
                    for (const unavailable of ["empty", "failure", "whitespace"]) {
                        mode = unavailable === "whitespace" ? "text" : unavailable
                        raw = " \n\t"
                        state.subAgentResultCache.clear()
                        await inject(client, state, new Logger(false), messages, true)
                        assert.equal(part.state.output, beforeUnavailable)
                    }
                    cases++
                }
        }
    assert.equal(cases, 84)
    for (const tool of ["shell", "webfetch"]) {
        const messages = [
            {
                info: { role: "assistant" },
                parts: [
                    { type: "text", text: nestedLiteral },
                    { type: "tool", tool, state: { status: "completed", output: nestedLiteral } },
                ],
            },
        ] as unknown as WithParts[]
        stripHallucinations(messages, "compact")
        const expected = stripContentOnce(nestedLiteral, "compact")
        assert.equal((messages[0].parts[0] as any).text, expected)
        assert.equal((messages[0].parts[1] as any).state.output, expected)
    }
})

test("ordinary legacy replacements gain framing before cleanup can cross receipt/body boundaries", async () => {
    for (const tool of ["task", "subagent"])
        for (const format of ["xml", "compact"] as const) {
            const receipt =
                "Prefix <dc<dcp/>p-x>\n<task_result>old</task_result>\n<subagent>sibling</subagent>\n<metadata>keep suffix</metadata>"
            let raw = "Selected payload</dc<dcp/>p-x>"
            const cleanReceipt = stripContentOnce(receipt, format)
            const start = cleanReceipt.indexOf("old")
            let expected = renderExpectedFrame(
                cleanReceipt.slice(0, start),
                stripContentOnce(raw, format),
                cleanReceipt.slice(start + 3),
            )
            const state = createSessionState(format)
            const messages = [
                {
                    info: { id: "parent", role: "assistant", time: { created: 1 } },
                    parts: [
                        {
                            type: "tool",
                            tool,
                            callID: "call",
                            state: {
                                status: "completed",
                                input: {},
                                output: receipt,
                                metadata: { sessionId: "ses_example" },
                            },
                        },
                    ],
                },
            ] as unknown as WithParts[]
            const part = messages[0].parts[0] as any
            const client = {
                session: {
                    messages: async () => ({
                        data: [
                            {
                                info: {
                                    id: "child",
                                    sessionID: "ses_example",
                                    role: "assistant",
                                    time: { created: 1 },
                                },
                                parts: [{ type: "text", text: raw }],
                            },
                        ],
                    }),
                },
            }
            // Raw protected expansion keeps the legacy format and selected text,
            // before the ordinary caller introduces its required framing boundary.
            const rawState = createSessionState(format)
            const rawContext = buildSearchContext(rawState, messages)
            const rawBoundary = { kind: "message" as const, rawIndex: 0, messageId: "parent" }
            const rawSelection = await resolveSelection(rawContext, rawBoundary, rawBoundary)
            for (const cached of [true, false]) {
                if (cached) rawState.subAgentResultCache.set("call", raw)
                else rawState.subAgentResultCache.clear()
                assert.equal(
                    await appendProtectedTools(
                        client,
                        rawState,
                        true,
                        "Summary",
                        rawSelection,
                        rawContext,
                        [tool],
                    ),
                    `Summary\n\nThe following protected tools were used in this conversation as well:\n### Tool: ${tool}\n${receipt.replace("old", raw)}`,
                )
                assert.equal(part.state.output, receipt)
            }
            await inject(client, state, new Logger(false), messages, true)
            assert.equal(part.state.output, expected)
            expectedFrameParts(part.state.output)
            for (let round = 0; round < 3; round++) {
                stripHallucinations(messages, format)
                expected = cleanExpectedFrame(expected, format)
                assert.equal(part.state.output, expected)
                assert.ok(
                    part.state.output.includes(
                        round < 2 ? "Selected payload" : "Changed complete final.",
                    ),
                )
                raw = round === 0 ? raw : "Changed complete final."
                if (round === 2) state.subAgentResultCache.clear()
                else state.subAgentResultCache.set("call", raw)
                await inject(client, state, new Logger(false), messages, true)
                expected = cleanExpectedFrame(expected, format, raw)
                assert.equal(part.state.output, expected)
            }
            const context = buildSearchContext(state, messages)
            const boundary = { kind: "message" as const, rawIndex: 0, messageId: "parent" }
            const selection = await resolveSelection(context, boundary, boundary)
            const beforeProtected = part.state.output
            for (const cached of [true, false]) {
                if (!cached) state.subAgentResultCache.clear()
                assert.equal(
                    await appendProtectedTools(client, state, true, "Summary", selection, context, [
                        tool,
                    ]),
                    `Summary\n\nThe following protected tools were used in this conversation as well:\n### Tool: ${tool}\n${expectedFrameWithRawBody(expected, raw)}`,
                )
                assert.equal(part.state.output, beforeProtected)
            }
        }
})

test("output transformation maps only a validated outer frame and never recurses into prose", () => {
    const nested = renderExpectedFrame("Nested\n<task_result>\n", "literal", "\n</task_result>")
    const valid = renderExpectedFrame(
        "Receipt\n<task_result>\n",
        nested,
        "\n</task_result>\nMetadata",
    )
    const seen: string[] = []
    assert.equal(
        transformSubagentResultOutput(valid, (text) => {
            seen.push(text)
            return text
        }),
        valid,
    )
    assert.deepEqual(seen, ["Receipt\n<task_result>\n", nested, "\n</task_result>\nMetadata"])
    for (const unknown of [
        nested + "\n",
        valid.replace(/\d+ \d+ \d+ -->$/, "0 0 0 -->"),
        "Receipt only",
    ]) {
        let calls = 0
        assert.equal(
            transformSubagentResultOutput(unknown, (text) => {
                calls++
                assert.equal(text, unknown)
                return text + " transformed"
            }),
            unknown + " transformed",
        )
        assert.equal(calls, 1)
    }
})
