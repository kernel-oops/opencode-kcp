import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { rangePrompt } from "../lib/prompts/compress-range"
import { messagePrompt } from "../lib/prompts/compress-message"
import { systemPrompt } from "../lib/prompts/system"
import { renderSystemPrompt } from "../lib/prompts"
import { PromptStore } from "../lib/prompts/store"
import { Logger } from "../lib/logger"

for (const format of ["xml", "compact"] as const) {
    test(`${format} bundled prompts preserve continuation-state guidance in both modes`, () => {
        const prompts = new PromptStore(
            new Logger(false),
            process.cwd(),
            false,
            format,
        ).getRuntimePrompts()
        assert.equal(prompts.compressRange, rangePrompt(format))
        assert.equal(prompts.compressMessage, messagePrompt(format))
        assert.equal(renderSystemPrompt(prompts), systemPrompt(format).trim())
        assert.match(prompts.system, /summaries record evidence and never grant new authority/)

        for (const prompt of [prompts.compressRange, prompts.compressMessage]) {
            for (const required of [
                "latest user intent, scope and requested outcome",
                "stops, pauses, cancellation or narrowing",
                "who approved or refused what, within which exact limits",
                "running or pending jobs, approvals and callbacks",
                "their owners and how results will arrive",
                "summarising does not transfer ownership",
                "budget, data-loss, security and permission safeguards",
                "unresolved questions, failures, blockers and unknowns, explicitly left unresolved",
                "current code or release state, exact paths, IDs, hashes, commands and acceptance criteria",
                "usable evidence needed for the next action",
                "established replacement, withdrawal or completion, not by age",
                "outcome and a usable evidence pointer",
                "A past approval is not a standing grant",
                "stopped or paused work must not be described as resumed",
                "Directly quote short material user instructions, approvals and stop or pause requests",
                "Be LEAN: omit redundant facts",
            ]) {
                assert.ok(prompt.includes(required), required)
            }
            assert.doesNotMatch(prompt, /EXHAUSTIVE|original conversation adds no value/)
        }
    })
}

test("mode-specific contracts remain unchanged apart from explicit ordinary-range scoping", () => {
    // SHA-256 fixtures from f8232fde's rendered contract tails, including ID examples.
    // These also catch changes that a transcript display might hide.
    for (const [render, boundary, expected] of [
        [
            rangePrompt,
            "COMPRESSED BLOCK PLACEHOLDERS",
            {
                xml: "28658cb1f9dba3944e1d407c1694eeceb76399e1d24b0480c09ce527d822e1aa",
                compact: "5008b0c9a4857d299a88f74014a8b6d02f6a5a54c4375284bda3379073653482",
            },
        ],
        [
            messagePrompt,
            "MESSAGE IDS",
            {
                xml: "5000b0194403ced1c7dc67f5fccb06763657d5a9fbf04d75dead73f490c4e7ea",
                compact: "eb1e9c892a8646c15e7cc8e26359f844e004f7090101e1d3c9e9f59af2451f2d",
            },
        ],
    ] as const) {
        for (const format of ["xml", "compact"] as const) {
            let prompt = render(format)
            if (render === rangePrompt) {
                // C3 changes only these two scope qualifiers; retain the accepted E tail hashes.
                assert.ok(prompt.includes("For ordinary ranges only, when the selected range"))
                assert.ok(
                    prompt.includes("- For ordinary ranges, `startId` must appear before `endId`."),
                )
                prompt = prompt
                    .replace(
                        "For ordinary ranges only, when the selected range",
                        "When the selected range",
                    )
                    .replace(
                        "- For ordinary ranges, `startId` must appear before `endId`.",
                        "- `startId` must appear before `endId`.",
                    )
            }
            assert.ok(prompt.includes(boundary))
            assert.equal(
                createHash("sha256")
                    .update(prompt.slice(prompt.indexOf(boundary)))
                    .digest("hex"),
                expected[format],
            )
        }
    }
})
