import assert from "node:assert/strict"
import test from "node:test"
import { appendProtectedTools } from "../lib/compress/protected-content"
import { buildSearchContext, resolveSelection } from "../lib/compress/search"
import { Logger } from "../lib/logger"
import { injectExtendedSubAgentResults } from "../lib/messages/inject/subagent-results"
import { stripHallucinationsFromString, stripHallucinations } from "../lib/messages/utils"
import { formatMessageIdTag } from "../lib/message-ids"
import { createSessionState, type WithParts } from "../lib/state"
import {
    mergeSubagentResult,
    transformSubagentResultOutput,
} from "../lib/subagents/subagent-results"
import {
    cleanExpectedFrame,
    expectedFrameParts,
    expectedFrameWithRawBody,
    stripContentOnce,
} from "./fixtures/subagent-cleanup"

const finalText = 'Completed the synthetic check.\n\n<report status="ok">$& $1 $` $\'</report>'
const receipts = [
    "Task launched in background.\nSession ID: ses_example\nTask ID: task_example",
    "Subagent started successfully.\n<task_metadata>\nsession_id: ses_example\n</task_metadata>",
]

function framed(prefix: string, text: string, suffix: string): string {
    return `${prefix}${text}${suffix}\n<!-- dcp-subagent-result:v1 ${prefix.length} ${text.length} ${suffix.length} -->`
}

function appended(receipt: string, text: string): string {
    return framed(`${receipt}\n\n<task_result>\n`, text, "\n</task_result>")
}

test("wrapperless receipts retain their association and gain the complete final result", () => {
    for (const receipt of receipts) {
        const expected = appended(receipt, finalText)
        const expanded = mergeSubagentResult(receipt, finalText)
        assert.equal(expanded, expected)
        assert.equal(mergeSubagentResult(expanded, finalText), expected)
        const refreshed = mergeSubagentResult(expanded, "Updated final.\n<report>Complete</report>")
        assert.equal(refreshed, appended(receipt, "Updated final.\n<report>Complete</report>"))
        assert.equal(mergeSubagentResult(refreshed, finalText), expected)
    }
})

test("existing wrappers retain surrounding launch text, metadata and tags", () => {
    for (const [open, close] of [
        ["<task_result>", "</task_result>"],
        ['<subagent sessionID="ses_example" state="completed">', "</subagent>"],
    ]) {
        const prefix = "Launch receipt\n<task_metadata>ses_example</task_metadata>\n"
        const suffix = "\nEnd of receipt"
        const original = `${prefix}${open}\nold\n${close}${suffix}`
        const expected = `${prefix}${open}\n${finalText}\n${close}${suffix}`
        assert.equal(mergeSubagentResult(original, finalText), expected)
        assert.equal(mergeSubagentResult(expected, finalText), expected)
    }
})

test("empty and whitespace-only fetched text leave wrapped and wrapperless output untouched", () => {
    for (const output of [...receipts, "<task_result>old</task_result>"]) {
        for (const text of ["", " ", "\n\t\n"]) {
            assert.equal(mergeSubagentResult(output, text), output)
        }
    }
})

function parentMessages(tool: string, receipt: string): WithParts[] {
    return [
        {
            info: { id: "parent_message", role: "assistant", time: { created: 1 } },
            parts: [
                {
                    type: "tool",
                    tool,
                    callID: "example_call",
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
}

function childClient(text = finalText) {
    const requests: string[] = []
    return {
        requests,
        session: {
            messages: async ({ path }: { path: { id: string } }) => {
                requests.push(path.id)
                return {
                    data: [
                        {
                            info: {
                                id: "child_message",
                                sessionID: "ses_example",
                                role: "assistant",
                                time: { created: 1 },
                            },
                            parts: [{ type: "text", text }],
                        },
                    ],
                }
            },
        },
    }
}

test("ordinary expansion includes fetched finals and keeps cached reinjection stable", async () => {
    for (const tool of ["task", "subagent"]) {
        const state = createSessionState()
        const client = childClient()
        const messages = parentMessages(tool, receipts[0])
        const expected = mergeSubagentResult(receipts[0], finalText)
        await injectExtendedSubAgentResults(client, state, new Logger(false), messages, true)
        assert.equal((messages[0].parts[0] as any).state.output, expected)
        await injectExtendedSubAgentResults(client, state, new Logger(false), messages, true)
        assert.equal((messages[0].parts[0] as any).state.output, expected)
        assert.deepEqual(client.requests, ["ses_example"])
    }
})

test("ordinary expansion leaves receipts unchanged when no usable final was fetched", async () => {
    for (const parts of [[], [{ type: "text", text: " \n\t" }]]) {
        const state = createSessionState()
        const messages = parentMessages("task", receipts[0])
        const client = {
            session: {
                messages: async () => ({
                    data: [
                        {
                            info: {
                                id: "child_message",
                                sessionID: "ses_example",
                                role: "assistant",
                                time: { created: 1 },
                            },
                            parts,
                        },
                    ],
                }),
            },
        }
        await injectExtendedSubAgentResults(client, state, new Logger(false), messages, true)
        assert.equal((messages[0].parts[0] as any).state.output, receipts[0])
        assert.equal(state.subAgentResultCache.size, 0)
    }
})

test("protected compression includes the complete final through fetched and cached paths", async () => {
    for (const tool of ["task", "subagent"]) {
        for (const text of [finalText, ...delimiterFinals]) {
            for (const cached of [false, true]) {
                const state = createSessionState()
                const client = childClient(text)
                const messages = parentMessages(tool, receipts[1])
                if (cached) state.subAgentResultCache.set("example_call", text)
                const context = buildSearchContext(state, messages)
                const boundary = {
                    kind: "message" as const,
                    rawIndex: 0,
                    messageId: "parent_message",
                }
                const selection = await resolveSelection(context, boundary, boundary)
                const summary = await appendProtectedTools(
                    client,
                    state,
                    true,
                    "Summary",
                    selection,
                    context,
                    [tool],
                )
                assert.equal(
                    summary,
                    `Summary\n\nThe following protected tools were used in this conversation as well:\n### Tool: ${tool}\n${appended(receipts[1], text)}`,
                )
                assert.deepEqual(client.requests, cached ? [] : ["ses_example"])
            }
        }
    }
})

const delimiterFinals = [
    "Completed the check.\nThe literal closing tag is `</task_result>`.\nFinal trailing sentence.",
    "Completed the check.\nThe literal closing tag is `</subagent>`.\nFinal trailing sentence.",
    "Literal tags: </TASK_RESULT>, </SubAgent>, </task_result> and </subagent>.\nAll done.",
    "The wrapper starts with `<task_result>`.\nDone.",
    'Example: <subagent sessionID="ses_nested">nested final</subagent>.\nDone.',
    "Mixed <task_result>opening</subagent> and </task_result> plus <subagent>literal.\nDone.",
    "Frame example:\n<!-- dcp-subagent-result:v1 0 1 2 -->\n<task_result>🦋</task_result>\n<!-- dcp-subagent-result:v1 999 0 0 -->",
]

test("literal result tags and frame examples survive repeated merges and complete final replacement", () => {
    for (const text of delimiterFinals) {
        for (const [open, close] of [
            ["<task_result>", "</task_result>"],
            ['<subagent sessionID="ses_example" state="completed">', "</subagent>"],
            ['<SubAgent sessionID="ses_example">', "</SUBAGENT>"],
        ]) {
            const prefix = "Launch receipt\n<task_metadata>ses_example</task_metadata>\n"
            const suffix = "\n<metadata>Completed launch</metadata>"
            const original = `${prefix}${open}\nOld result\n${close}${suffix}`
            const expected = framed(`${prefix}${open}\n`, text, `\n${close}${suffix}`)
            const expanded = mergeSubagentResult(original, text)
            assert.equal(expanded, expected)
            assert.equal(mergeSubagentResult(expanded, text), expected)
            assert.equal(
                mergeSubagentResult(expanded, "Updated complete final."),
                framed(`${prefix}${open}\n`, "Updated complete final.", `\n${close}${suffix}`),
            )
        }
    }
})

test("replacement matches closing types and preserves unrelated sibling wrappers", () => {
    for (const [open, close, otherOpen, otherClose] of [
        ["<task_result>", "</task_result>", '<subagent sessionID="ses_other">', "</subagent>"],
        ['<subagent sessionID="ses_example">', "</subagent>", "<task_result>", "</task_result>"],
        ["<task_result>", "</task_result>", "<task_result>", "</task_result>"],
    ]) {
        const prefix = "Receipt and metadata\n"
        const suffix = `\nUnrelated content\n${otherOpen}\nOther result\n${otherClose}\nEnd`
        const original = `${prefix}${open}\nOld final mentions ${otherClose}.\nTail\n${close}${suffix}`
        // Without recorded boundaries the first close might be literal prose.
        // Preserve the ambiguous legacy receipt rather than deleting unknown text.
        const expected = appended(original, delimiterFinals[2])
        assert.equal(mergeSubagentResult(original, delimiterFinals[2]), expected)
        assert.equal(mergeSubagentResult(expected, delimiterFinals[2]), expected)
    }
})

test("tag and frame prose survives ordinary and protected fetched/cached expansion", async () => {
    for (const tool of ["task", "subagent"]) {
        for (const text of delimiterFinals) {
            const state = createSessionState()
            const client = childClient(text)
            const messages = parentMessages(tool, receipts[0])
            const expected = appended(receipts[0], text)
            await injectExtendedSubAgentResults(client, state, new Logger(false), messages, true)
            assert.equal((messages[0].parts[0] as any).state.output, expected)

            const context = buildSearchContext(state, messages)
            const boundary = { kind: "message" as const, rawIndex: 0, messageId: "parent_message" }
            const selection = await resolveSelection(context, boundary, boundary)
            for (const cached of [true, false]) {
                if (!cached) state.subAgentResultCache.clear()
                const summary = await appendProtectedTools(
                    client,
                    state,
                    true,
                    "Summary",
                    selection,
                    context,
                    [tool],
                )
                assert.equal(
                    summary,
                    `Summary\n\nThe following protected tools were used in this conversation as well:\n### Tool: ${tool}\n${expected}`,
                )
            }
            await injectExtendedSubAgentResults(client, state, new Logger(false), messages, true)
            assert.equal((messages[0].parts[0] as any).state.output, expected)
            assert.deepEqual(client.requests, ["ses_example", "ses_example"])

            state.subAgentResultCache.set("example_call", "Updated complete final.")
            const updatedExpected = appended(receipts[0], "Updated complete final.")
            const updatedSummary = await appendProtectedTools(
                client,
                state,
                true,
                "Summary",
                selection,
                context,
                [tool],
            )
            assert.equal(
                updatedSummary,
                `Summary\n\nThe following protected tools were used in this conversation as well:\n### Tool: ${tool}\n${updatedExpected}`,
            )
            await injectExtendedSubAgentResults(client, state, new Logger(false), messages, true)
            assert.equal((messages[0].parts[0] as any).state.output, updatedExpected)
            state.subAgentResultCache.clear()
            await injectExtendedSubAgentResults(
                childClient("Another fetched final."),
                state,
                new Logger(false),
                messages,
                true,
            )
            assert.equal(
                (messages[0].parts[0] as any).state.output,
                appended(receipts[0], "Another fetched final."),
            )
        }
    }
})

test("ambiguous legacy tags retain the entire receipt including quoted suffix metadata", () => {
    const originals = [
        'Receipt\n<task_result>old</task_result>\n<task_metadata>Documented closing tag: "</task_result>"</task_metadata>',
        "Receipt\n<task_result>Example <task_result> opening.\nOld tail</task_result>\nSuffix",
        "Receipt\n<task_result>Example </task_result> closing.\nOld tail</task_result>\nSuffix",
    ]
    for (const original of originals) {
        const expected = appended(original, "new")
        assert.equal(mergeSubagentResult(original, "new"), expected)
        assert.equal(mergeSubagentResult(expected, "new"), expected)
        assert.equal(mergeSubagentResult(expected, "updated"), appended(original, "updated"))
    }
})

test("plain legacy wrappers retain sibling wrappers and unrelated suffix text", () => {
    const original =
        'Receipt\n<task_result>old</task_result>\n<subagent sessionID="other">sibling</subagent>\nMetadata'
    const expected = original.replace(">old<", ">new<")
    assert.equal(mergeSubagentResult(original, "new"), expected)
    const marked = mergeSubagentResult(original, delimiterFinals[3])
    assert.equal(
        marked,
        framed(
            "Receipt\n<task_result>",
            delimiterFinals[3],
            original.slice(original.indexOf("</task_result>")),
        ),
    )
    assert.equal(
        mergeSubagentResult(marked, "new"),
        framed("Receipt\n<task_result>", "new", original.slice(original.indexOf("</task_result>"))),
    )
})

test("malformed or displaced frames never remove unknown receipt text", () => {
    const valid = appended(receipts[0], "old")
    const malformed = [
        valid.replace(/\d+ \d+ \d+ -->$/, "999999999999999999999 1 2 -->"),
        valid.replace(/\d+ \d+ \d+ -->$/, "0 0 0 -->"),
        valid.replace("v1 ", "v1 broken "),
        valid.replace("<task_result>", "<other_result>"),
        valid.replace("</task_result>", "</subagent>"),
        `${valid}\n`,
        `${valid}\nUnrelated suffix`,
    ]
    for (const original of malformed) {
        const expected = appended(original, "new")
        assert.equal(mergeSubagentResult(original, "new"), expected)
        assert.equal(mergeSubagentResult(expected, "updated"), appended(original, "updated"))
    }
})

test("framed helper bodies retain leading/trailing whitespace and Unicode verbatim", () => {
    const text = " \n🦋 café\r\n<task_result>example</task_result>\n\t "
    const expected = appended(receipts[0], text)
    assert.equal(mergeSubagentResult(receipts[0], text), expected)
    assert.equal(mergeSubagentResult(expected, text), expected)
    assert.equal(mergeSubagentResult(expected, "\n\t"), expected)
})

test("frame-marker-only prose is identified from the first legacy replacement", () => {
    const text = "Frame example\n<!-- dcp-subagent-result:v1 0 1 2 -->"
    for (const [open, close] of [
        ["<task_result>", "</task_result>"],
        ['<subagent sessionID="ses_example">', "</subagent>"],
    ]) {
        const original = `Receipt\n${open}old${close}\nSuffix`
        const expected = framed(`Receipt\n${open}`, text, `${close}\nSuffix`)
        assert.equal(mergeSubagentResult(original, text), expected)
        assert.equal(mergeSubagentResult(expected, text), expected)
        assert.equal(
            mergeSubagentResult(expected, "updated"),
            framed(`Receipt\n${open}`, "updated", `${close}\nSuffix`),
        )
    }
})

test("ordinary frames use sanitised receipt/body lengths while protected results keep raw cached finals", async () => {
    for (const tool of ["task", "subagent"]) {
        for (const format of ["compact", "xml"] as const) {
            const ref = "@" + "23" + "@"
            const embedded = format === "compact" ? `${ref} [high]` : formatMessageIdTag("m0023")
            const suffix = formatMessageIdTag(
                format === "compact" ? ref : "m0024",
                undefined,
                format,
            )
            const receipt = `Receipt ${embedded}\nSession ID: ses_example${suffix}`
            const text = `Result ${embedded}.\nFinal with a parameter suffix\nm0025</parameter>`
            const cleanReceipt = stripHallucinationsFromString(receipt, format)
            const cleanText = stripHallucinationsFromString(text, format)
            assert.notEqual(cleanReceipt, receipt, "fixture must remove receipt characters")
            assert.notEqual(cleanText, text, "fixture must remove final characters")
            assert.ok(!cleanText.includes("m0025"), "newline parameter suffix is removed")

            const state = createSessionState(format)
            const client = childClient(text)
            const messages = parentMessages(tool, receipt)
            const part = messages[0].parts[0] as any
            const expected = appended(cleanReceipt, cleanText)
            await injectExtendedSubAgentResults(client, state, new Logger(false), messages, true)
            assert.equal(part.state.output, expected)
            assert.equal(state.subAgentResultCache.get("example_call"), text)

            // Both host transforms run this established cleanup before ordinary
            // expansion; it must leave the caller's newly generated frame valid.
            stripHallucinations(messages, format)
            assert.equal(part.state.output, expected)
            await injectExtendedSubAgentResults(client, state, new Logger(false), messages, true)
            assert.equal(part.state.output, expected)

            const context = buildSearchContext(state, messages)
            const boundary = { kind: "message" as const, rawIndex: 0, messageId: "parent_message" }
            const selection = await resolveSelection(context, boundary, boundary)
            const summaryPrefix = `Summary\n\nThe following protected tools were used in this conversation as well:\n### Tool: ${tool}\n`
            for (const cached of [true, false]) {
                if (!cached) state.subAgentResultCache.clear()
                assert.equal(
                    await appendProtectedTools(client, state, true, "Summary", selection, context, [
                        tool,
                    ]),
                    summaryPrefix + appended(cleanReceipt, text),
                )
                assert.equal(
                    part.state.output,
                    expected,
                    "protected expansion does not mutate the ordinary receipt",
                )
            }
            assert.deepEqual(client.requests, ["ses_example", "ses_example"])

            const updated = `Updated ${embedded}.\n<!-- dcp-subagent-result:v1 0 1 2 -->`
            const cleanUpdated = stripHallucinationsFromString(updated, format)
            state.subAgentResultCache.set("example_call", updated)
            assert.equal(
                await appendProtectedTools(client, state, true, "Summary", selection, context, [
                    tool,
                ]),
                summaryPrefix + appended(cleanReceipt, updated),
            )
            await injectExtendedSubAgentResults(client, state, new Logger(false), messages, true)
            assert.equal(part.state.output, appended(cleanReceipt, cleanUpdated))
            await injectExtendedSubAgentResults(client, state, new Logger(false), messages, true)
            assert.equal(part.state.output, appended(cleanReceipt, cleanUpdated))

            state.subAgentResultCache.clear()
            const freshText = `Fresh ${embedded}.\n<task_result>literal opening`
            await injectExtendedSubAgentResults(
                childClient(freshText),
                state,
                new Logger(false),
                messages,
                true,
            )
            const freshExpected = appended(
                cleanReceipt,
                stripHallucinationsFromString(freshText, format),
            )
            assert.equal(part.state.output, freshExpected)
            assert.equal(
                await appendProtectedTools({}, state, true, "Summary", selection, context, [tool]),
                summaryPrefix + appended(cleanReceipt, freshText),
            )
            assert.equal(part.state.output, freshExpected)
            // A meaningful raw final can become empty after ID cleanup. It must
            // clear the identified previous body, not leave that stale body intact.
            state.subAgentResultCache.set("example_call", embedded.trim())
            await injectExtendedSubAgentResults(client, state, new Logger(false), messages, true)
            assert.equal(part.state.output, appended(cleanReceipt, ""))
            await injectExtendedSubAgentResults(client, state, new Logger(false), messages, true)
            assert.equal(part.state.output, appended(cleanReceipt, ""))
            state.subAgentResultCache.clear()
            await injectExtendedSubAgentResults(
                childClient(embedded),
                state,
                new Logger(false),
                messages,
                true,
            )
            assert.equal(part.state.output, appended(cleanReceipt, ""))
        }
    }
})

test("unfinished synthetic tag examples cannot invalidate generated frames during later host cleanup", async () => {
    const unfinished = [
        "<" + "dcp-example",
        "</" + "dcp-example",
        "<" + 'dcp-message-id priority="high"',
    ]
    for (const tool of ["task", "subagent"]) {
        for (const format of ["compact", "xml"] as const) {
            for (const partial of unfinished) {
                for (const placement of ["receipt", "body", "both", "split"]) {
                    const receipt =
                        receipts[0] + (placement !== "body" ? `\nExample ${partial}` : "")
                    const bodyPartial = placement === "split" ? "</" + "dcp-example" : partial
                    const text =
                        "Selected final." +
                        (placement !== "receipt" ? `\nExample ${bodyPartial}` : "")
                    const state = createSessionState(format)
                    const client = childClient(text)
                    const messages = parentMessages(tool, receipt)
                    const part = messages[0].parts[0] as any
                    const expected = appended(receipt, text)
                    await injectExtendedSubAgentResults(
                        client,
                        state,
                        new Logger(false),
                        messages,
                        true,
                    )
                    assert.equal(part.state.output, expected)
                    assert.equal(state.subAgentResultCache.get("example_call"), text)
                    stripHallucinations(messages, format)
                    assert.equal(part.state.output, expected)
                    stripHallucinations(messages, format)
                    assert.equal(part.state.output, expected)
                    await injectExtendedSubAgentResults(
                        client,
                        state,
                        new Logger(false),
                        messages,
                        true,
                    )
                    assert.equal(part.state.output, expected)

                    const context = buildSearchContext(state, messages)
                    const boundary = {
                        kind: "message" as const,
                        rawIndex: 0,
                        messageId: "parent_message",
                    }
                    const selection = await resolveSelection(context, boundary, boundary)
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
                        `Summary\n\nThe following protected tools were used in this conversation as well:\n### Tool: ${tool}\n${expected}`,
                    )
                    state.subAgentResultCache.set("example_call", "Updated final.")
                    await injectExtendedSubAgentResults(
                        client,
                        state,
                        new Logger(false),
                        messages,
                        true,
                    )
                    assert.equal(part.state.output, appended(receipt, "Updated final."))
                    stripHallucinations(messages, format)
                    assert.equal(part.state.output, appended(receipt, "Updated final."))
                    state.subAgentResultCache.clear()
                    await injectExtendedSubAgentResults(
                        childClient("Fetched final."),
                        state,
                        new Logger(false),
                        messages,
                        true,
                    )
                    assert.equal(part.state.output, appended(receipt, "Fetched final."))
                    stripHallucinations(messages, format)
                    assert.equal(part.state.output, appended(receipt, "Fetched final."))
                }
            }
        }
    }
})

test("nested synthetic artifacts remain refreshable through segment-wise cleanup", async () => {
    for (const tool of ["task", "subagent"]) {
        for (const format of ["compact", "xml"] as const) {
            for (const depth of [2, 4, 16]) {
                const ref = "@" + "23" + "@"
                let nested = formatMessageIdTag(
                    format === "compact" ? ref : "m0023",
                    undefined,
                    format,
                ).trim()
                for (let level = 1; level < depth; level++) {
                    nested =
                        format === "compact" ? "@" + nested + "24@" : "<dc" + nested + "p-demo>"
                }
                const cleanNested = stripContentOnce(nested, format)
                for (const placement of ["receipt", "body", "both"]) {
                    const receipt =
                        receipts[0] + (placement !== "body" ? `\nExample ${nested}` : "")
                    const cleanReceipt =
                        receipts[0] + (placement !== "body" ? `\nExample ${cleanNested}` : "")
                    const text = placement !== "receipt" ? `Selected ${nested}` : "Selected final."
                    const cleanText =
                        placement !== "receipt" ? `Selected ${cleanNested}` : "Selected final."
                    const state = createSessionState(format)
                    const client = childClient(text)
                    const messages = parentMessages(tool, receipt)
                    const part = messages[0].parts[0] as any
                    let expected = appended(cleanReceipt, cleanText)
                    await injectExtendedSubAgentResults(
                        client,
                        state,
                        new Logger(false),
                        messages,
                        true,
                    )
                    assert.equal(part.state.output, expected)
                    assert.equal(state.subAgentResultCache.get("example_call"), text)
                    stripHallucinations(messages, format)
                    expected = cleanExpectedFrame(expected, format)
                    stripHallucinations(messages, format)
                    expected = cleanExpectedFrame(expected, format)
                    assert.equal(part.state.output, expected)
                    expectedFrameParts(part.state.output)
                    await injectExtendedSubAgentResults(
                        client,
                        state,
                        new Logger(false),
                        messages,
                        true,
                    )
                    expected = cleanExpectedFrame(expected, format, text)
                    assert.equal(part.state.output, expected)
                    const context = buildSearchContext(state, messages)
                    const boundary = {
                        kind: "message" as const,
                        rawIndex: 0,
                        messageId: "parent_message",
                    }
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
                            summaryPrefix + expectedFrameWithRawBody(expected, text),
                        )
                        assert.equal(part.state.output, expected)
                    }
                    state.subAgentResultCache.set("example_call", `Changed ${nested}`)
                    await injectExtendedSubAgentResults(
                        client,
                        state,
                        new Logger(false),
                        messages,
                        true,
                    )
                    expected = cleanExpectedFrame(expected, format, `Changed ${nested}`)
                    assert.equal(part.state.output, expected)
                    stripHallucinations(messages, format)
                    expected = cleanExpectedFrame(expected, format)
                    assert.equal(part.state.output, expected)
                    state.subAgentResultCache.clear()
                    await injectExtendedSubAgentResults(
                        childClient(`Fresh ${nested}`),
                        state,
                        new Logger(false),
                        messages,
                        true,
                    )
                    expected = cleanExpectedFrame(expected, format, `Fresh ${nested}`)
                    assert.equal(part.state.output, expected)
                    state.subAgentResultCache.set("example_call", nested)
                    await injectExtendedSubAgentResults(
                        client,
                        state,
                        new Logger(false),
                        messages,
                        true,
                    )
                    expected = cleanExpectedFrame(expected, format, nested)
                    assert.equal(part.state.output, expected)
                    state.subAgentResultCache.clear()
                    await injectExtendedSubAgentResults(
                        childClient(nested),
                        state,
                        new Logger(false),
                        messages,
                        true,
                    )
                    expected = cleanExpectedFrame(expected, format, nested)
                    assert.equal(part.state.output, expected)
                    expectedFrameParts(part.state.output)
                }
            }
        }
    }
})

test("frame-aware cleanup preserves generated boundaries while updating segment lengths", () => {
    for (const format of ["compact", "xml"] as const) {
        const clean = (text: string) => stripHallucinationsFromString(text, format)
        const token = formatMessageIdTag("@" + "23" + "@", undefined, "compact").trim()
        for (const receipt of [
            "Receipt @",
            "Receipt <" + "dcp-example",
            "Receipt </" + "dcp-example",
            "Receipt <dc",
            "Receipt\nm0023</parameter>",
        ]) {
            for (const body of [
                "24@",
                ">",
                "p-example>",
                "</" + "dcp-example>",
                "@" + token + "24@",
                formatMessageIdTag("m0023").trim(),
            ]) {
                const normalReceipt = clean(receipt)
                const expected = appended(normalReceipt, clean(body))
                const expanded = mergeSubagentResult(normalReceipt, body, clean)
                assert.equal(expanded, expected)
                const cleaned = transformSubagentResultOutput(expanded, clean)
                assert.equal(cleaned, cleanExpectedFrame(expected, format))
                assert.equal(
                    transformSubagentResultOutput(cleaned, clean),
                    cleanExpectedFrame(cleaned, format),
                )
                assert.equal(
                    mergeSubagentResult(cleaned, body, clean),
                    expectedFrameWithRawBody(cleaned, clean(body)),
                )
                assert.equal(
                    mergeSubagentResult(cleaned, "Updated.", clean),
                    expectedFrameWithRawBody(cleaned, "Updated."),
                )
            }
        }
    }
})
