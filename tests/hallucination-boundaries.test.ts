import assert from "node:assert/strict"
import test from "node:test"
import { formatMessageIdTag } from "../lib/message-ids"
import { stripHallucinationsFromString as clean } from "../lib/messages/utils"
import { stripContentOnce } from "./fixtures/subagent-cleanup"

test("complete synthetic paired and orphan tags retain their cleanup contract", () => {
    for (const format of ["xml", "compact"] as const) {
        // Existing synthetic producers use message-id and system-reminder;
        // hallucinated bare, colon, underscore and mixed-case variants are also supported.
        for (const name of [
            "dcp-message-id",
            "dcp-system-reminder",
            "dcp",
            "dcp:example",
            "dcp_example",
            "DCP-EXAMPLE",
        ]) {
            const open = `<${name} priority="high" example="&lt;safe&gt;">`
            const close = `</${name}>`
            assert.equal(
                clean(`before${open}synthetic payload${close}after`, format),
                "beforeafter",
            )
            assert.equal(clean(`before${open}after`, format), "beforeafter")
            assert.equal(clean(`before${close}after`, format), "beforeafter")
            assert.equal(clean(`before<${name} />after`, format), "beforeafter")
        }
        const produced = formatMessageIdTag("m0023", { priority: "high", example: "<safe>" })
        assert.equal(clean(`before${produced}after`, format), "before\nafter")
        assert.equal(clean(`before${produced}`, format), "before\n")
        assert.equal(clean("before\nm0023</parameter>\n", format), "before\n")
    }
    for (const ref of ["23", "b23", "blocked"]) {
        const token = "@" + ref + "@"
        assert.equal(clean(`before${token} [high]after`, "compact"), "beforeafter")
        assert.equal(clean(`before${token}after`, "xml"), `before${token}after`)
    }
})

const unfinishedDcpTags = [
    "<" + "dcp-example",
    "</" + "dcp-example",
    "<" + 'dcp-message-id priority="high"',
    "</" + "dcp-message-id",
    "<" + 'DCP_SYSTEM_REMINDER\nexample="unfinished',
    "</" + "dcp:example",
]

test("unfinished synthetic tags cannot consume following unrelated tags", () => {
    for (const format of ["xml", "compact"] as const) {
        for (const unfinished of unfinishedDcpTags) {
            for (const following of [
                "\n<task_result>payload</task_result>",
                '\n<subagent sessionID="example">payload</subagent>',
                "\n<report>payload</report>",
            ]) {
                const original = `Example ${unfinished}${following}`
                assert.equal(clean(original, format), original)
                assert.equal(clean(clean(original, format), format), original)
            }
        }
    }
})

test("cleanup retains one ordered content pass for nested and mutually exposed artifacts", () => {
    for (const format of ["compact", "xml"] as const) {
        for (const depth of [1, 2, 4, 16, 64, 128]) {
            const ref = "@" + "23" + "@"
            let nested = formatMessageIdTag(
                format === "compact" ? ref : "m0023",
                undefined,
                format,
            ).trim()
            for (let level = 1; level < depth; level++) {
                nested = format === "compact" ? "@" + nested + "24@" : "<dc" + nested + "p-demo>"
            }
            const remainder = stripContentOnce(nested, format)
            assert.equal(clean(nested, format), remainder)
            const text = `before ${nested} after; mail a@b.com; literal [high]`
            const expected = `before ${remainder} after; mail a@b.com; literal [high]`
            assert.equal(clean(text, format), expected)
            assert.equal(clean(expected, format), stripContentOnce(expected, format))
        }
        const xml = formatMessageIdTag("m0023").trim()
        const mixed = "@" + xml + "24@"
        const expected = "@" + "24" + "@"
        assert.equal(clean(mixed, format), expected)
        assert.equal(clean(expected, format), stripContentOnce(expected, format))
        const suffix = `Payload\nm0023</parameter>${xml}`
        assert.equal(clean(suffix, format), "Payload\nm0023</parameter>")
        assert.equal(clean(clean(suffix, format), format), "Payload\n")
    }
})
