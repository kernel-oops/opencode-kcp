import assert from "node:assert/strict"
import test from "node:test"
import { createSessionState, resetSessionState } from "../lib/state"
import { resetOnCompaction } from "../lib/state/utils"
import {
    isLowYield,
    minimumReductionPercentSchema,
    takeLowYieldAdvisory,
    validateMinimumReductionPercent,
} from "../lib/compress/low-yield"
import { validateArgs as rangeArgs } from "../lib/compress/range-utils"
import { validateArgs as messageArgs } from "../lib/compress/message-utils"

function assistant(id: string, input = 100): any {
    return {
        id,
        type: "assistant",
        agent: "build",
        model: { providerID: "fixture", id: "fixture", variant: "one" },
        time: { created: 1, completed: 2 },
        tokens: { input, cache: { read: 0, write: 0 }, output: 99999, reasoning: 99999 },
    }
}
function pending(threshold = 10) {
    const state = createSessionState("compact")
    state.lowYield = { assistantID: "a", threshold }
    return state
}
test("finite threshold schema and runtime validation; no materialised default", () => {
    for (const value of [undefined, 0, 10, 100]) {
        validateMinimumReductionPercent(value)
        assert.equal(minimumReductionPercentSchema().parse(value), value)
    }
    for (const value of [NaN, Infinity, -Infinity, -1, 101, null, "10"]) {
        assert.throws(() => validateMinimumReductionPercent(value))
        assert.equal(minimumReductionPercentSchema().safeParse(value).success, false)
        assert.throws(
            () => rangeArgs({ minimumReductionPercent: value } as any),
            /minimumReductionPercent/,
        )
        assert.throws(
            () => messageArgs({ minimumReductionPercent: value } as any),
            /minimumReductionPercent/,
        )
    }
    assert.match(minimumReductionPercentSchema().description!, /require supported V2 range mode/)
})
test("exact boundary, zero and growth", () => {
    assert.equal(isLowYield(100, 90, 10), true)
    assert.equal(isLowYield(100, 89, 10), false)
    assert.equal(isLowYield(100, 100, 0), true)
    assert.equal(isLowYield(100, 101, 0), true)
    assert.equal(isLowYield(100, 99, 0), false)
})
test("native non-cached input plus cache; output and reasoning excluded; one shot", () => {
    const a = assistant("a", 60),
        b = assistant("b", 50),
        state = pending()
    a.tokens.cache = { read: 30, write: 10 }
    b.tokens.cache = { read: 30, write: 10 }
    assert.match(takeLowYieldAdvisory(state, [a, b])!, /100 → 90/)
    assert.equal(state.lowYield, null)
    assert.equal(takeLowYieldAdvisory(state, [a, b]), undefined)
})
test("wait for absent or unfinished successor, including completed timestamp zero", () => {
    const state = pending(),
        a = assistant("a"),
        b = assistant("b")
    assert.equal(takeLowYieldAdvisory(state, [a]), undefined)
    delete b.time.completed
    assert.equal(takeLowYieldAdvisory(state, [a, b]), undefined)
    assert.ok(state.lowYield)
    b.time.completed = 0
    assert.ok(takeLowYieldAdvisory(state, [a, b]))
})
for (const mutation of [
    (b: any) => {
        b.agent = "other"
    },
    (b: any) => {
        delete b.agent
    },
    (b: any) => {
        b.model.id = "other"
    },
    (b: any) => {
        b.model.providerID = "other"
    },
    (b: any) => {
        b.model.variant = "other"
    },
    (b: any) => {
        delete b.tokens
    },
    (b: any) => {
        b.tokens.input = 0
    },
    (b: any) => {
        b.tokens.input = NaN
    },
    (b: any) => {
        b.tokens.input = Infinity
    },
    (b: any) => {
        b.tokens.cache.read = -1
    },
    (b: any) => {
        delete b.tokens.cache
    },
    (b: any) => {
        b.error = { message: "failed" }
        delete b.time.completed
    },
    (b: any) => {
        b.time.completed = "bad"
    },
])
    test(`invalid context/usage drops observation: ${mutation.toString()}`, () => {
        const state = pending(),
            a = assistant("a"),
            b = assistant("b")
        mutation(b)
        assert.equal(takeLowYieldAdvisory(state, [a, b, assistant("c")]), undefined)
        assert.equal(state.lowYield, null)
    })
for (const type of ["user", "synthetic", "notification", "idle", "compaction"])
    test(`strict adjacency: ${type} prevents scanning`, () => {
        const state = pending()
        assert.equal(
            takeLowYieldAdvisory(state, [
                assistant("a"),
                { id: "interruption", type },
                assistant("c"),
            ]),
            undefined,
        )
        assert.equal(state.lowYield, null)
    })
test("missing baseline drops, invalid baseline skips, resets clear transient state", () => {
    const state = pending()
    assert.equal(takeLowYieldAdvisory(state, [assistant("b")]), undefined)
    assert.equal(state.lowYield, null)
    const a = assistant("a")
    delete a.tokens
    state.lowYield = { assistantID: "a", threshold: 10 }
    assert.equal(takeLowYieldAdvisory(state, [a, assistant("b")]), undefined)
    state.lowYield = { assistantID: "a", threshold: 10 }
    resetOnCompaction(state)
    assert.equal(state.lowYield, null)
    state.lowYield = { assistantID: "a", threshold: 10 }
    resetSessionState(state)
    assert.equal(state.lowYield, null)
})
