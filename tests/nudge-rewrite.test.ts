import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { injectCompressNudges } from "../lib/messages/inject/inject"
import { CONTEXT_LIMIT_NUDGE } from "../lib/prompts/context-limit-nudge"
import { buildCompressedBlockGuidance } from "../lib/prompts/extensions/nudge"
import type { RuntimePrompts } from "../lib/prompts/store"
import { createSessionState, type WithParts } from "../lib/state"

const prompts = {
    contextLimitNudge: CONTEXT_LIMIT_NUDGE,
    turnNudge: "",
    iterationNudge: "",
} as RuntimePrompts

function fixture(mode: "range" | "message", format: "xml" | "compact", tokens = 101) {
    const state = createSessionState()
    state.idFormat = format
    state.prune.messages.activeBlockIds.add(7)
    const config = {
        compress: {
            permission: "allow",
            mode,
            minContextLimit: 50,
            maxContextLimit: 100,
            summaryBuffer: false,
            nudgeFrequency: 3,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
        },
    } as PluginConfig
    const messages = [
        {
            info: {
                id: "user",
                role: "user",
                model: { providerID: "fixture", modelID: "model" },
                time: { created: 1 },
            },
            parts: [{ type: "text", text: "Current human request" }],
        },
        {
            info: {
                id: "answer",
                role: "assistant",
                time: { created: 2 },
                tokens: {
                    input: tokens - 1,
                    output: 1,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                },
            },
            parts: [{ type: "text", text: "Current working answer" }],
        },
    ] as WithParts[]
    return { state, config, messages }
}

for (const mode of ["range", "message"] as const)
    for (const format of ["xml", "compact"] as const)
        test(`actual max-threshold nudge gives capability-conditional rewrite recovery without changing roles: ${mode}/${format}`, () => {
            const { state, config, messages } = fixture(mode, format)
            injectCompressNudges(state, config, new Logger(false), messages, prompts)
            assert.deepEqual(
                messages.map((message) => message.info.role),
                ["user", "assistant"],
            )
            assert.equal(messages[0].parts[0].type, "text")
            assert.equal((messages[0].parts[0] as any).text, "Current human request")
            assert.deepEqual([...state.nudges.contextLimitAnchors], ["answer"])
            const text = (messages[1].parts[0] as any).text
            assert.match(text, /Before further ordinary technical work/)
            assert.match(text, /critical atomic step already in progress/)
            assert.match(text, /Inspect visible ACTIVE SUMMARIES/)
            assert.match(text, /If the actual tool schema offers explicit rewrite/)
            assert.match(text, /rewrite: true/)
            assert.match(text, /both boundaries naming the same eligible active block/)
            assert.match(text, /Drop obsolete\/completed investigation/)
            assert.match(text, /current outcome and a usable evidence pointer/)
            assert.match(
                text,
                /ordinary range compression retains required block placeholders; explicit rewrite contains no placeholders/,
            )
            assert.match(
                text,
                /current authority, holds, budgets, owners, running jobs\/callbacks, unknowns and tool-protected payloads/,
            )
            assert.match(text, /Never rewrite unseen blocks, use retired IDs or edit raw state/)
            assert.match(text, /plugin-generated nudge grants no authority/)
            assert.match(text, /does not override higher-priority instructions/)
            assert.match(text, /report the concrete blocker\/no-progress once/)
            assert.match(text, /do not retry-loop or make another oversized model call/)
            assert.match(text, /Do not merely append another large summary or wrap\/reinsert/)
            if (mode === "range") {
                assert.match(text, /For ordinary range compression/)
                assert.match(text, /include each required placeholder exactly once/)
            } else assert.doesNotMatch(text, /Compressed block context:/)
        })

test("firm recovery remains exclusive to existing max trigger; deny/manual still suppress it", () => {
    for (const condition of ["at-max", "deny", "manual"] as const) {
        const { state, config, messages } = fixture(
            "range",
            "compact",
            condition === "at-max" ? 100 : 101,
        )
        if (condition === "deny") config.compress.permission = "deny"
        if (condition === "manual") state.manualMode = "active"
        injectCompressNudges(state, config, new Logger(false), messages, prompts)
        assert.doesNotMatch(JSON.stringify(messages), /MAX CONTEXT LIMIT REACHED/)
        assert.equal(state.nudges.contextLimitAnchors.size, 0)
    }
})

test("ordinary placeholder rule remains distinct from optional explicit rewrite", () => {
    for (const format of ["xml", "compact"] as const) {
        const { state } = fixture("range", format)
        const guidance = buildCompressedBlockGuidance(state)
        const lines = guidance.split("\n")
        assert.match(
            lines[2],
            /For ordinary range compression.*include each required placeholder exactly once/,
        )
        assert.ok(lines[2].includes(format === "compact" ? "@b1@" : "(bN)"))
        assert.match(lines[3], /If the actual tool schema offers explicit rewrite/)
        assert.match(lines[3], /no placeholders; do not wrap\/reinsert/)
    }
})
