import assert from "node:assert/strict"
import { existsSync, readFileSync, readlinkSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { pathToFileURL } from "node:url"

const consumer = realpathSync(process.argv[2])
const installed = path.join(consumer, "node_modules/opencode-kcp")
assert.ok(realpathSync(installed).startsWith(consumer + path.sep))
const lock = JSON.parse(readFileSync(path.join(consumer, "package-lock.json"), "utf8"))
for (const name of Object.keys(lock.packages)) {
    assert.ok(
        !/node_modules\/(?:@opencode-ai\/(?:plugin|sdk)|@opencode\/plugin|@opentui\/[^/]+|solid-js|seroval(?:-plugins)?|effect|toml)$/.test(
            name,
        ),
        `unexpected consumer runtime dependency: ${name}`,
    )
}
const imported = spawnSync(
    process.execPath,
    [
        ...(process.versions.bun ? [] : ["--input-type=module"]),
        "-e",
        'import assert from "node:assert/strict"; import main from "opencode-kcp"; import server from "opencode-kcp/server"; import directory from "./node_modules/opencode-kcp/server.js"; assert.equal(main, server); assert.equal(main, directory); assert.equal(main.id, "opencode-dcp"); assert.equal(typeof main.setup, "function"); assert.equal(typeof main.server, "function");',
    ],
    { cwd: consumer, encoding: "utf8", timeout: 30_000 },
)
assert.equal(imported.status, 0, imported.stderr.slice(0, 2000))
const require = createRequire(path.join(installed, "package.json"))
const { countTokens: oracle } = require("@anthropic-ai/tokenizer")
const { TokenCounter, TokenCountError } = await import(
    pathToFileURL(path.join(installed, "lib/token-counter.ts")).href
)
const texts = [
    "",
    "hello world",
    "Ｈｅｌｌｏ ﬁ ①",
    "emoji 👩‍👩‍👧‍👦 and flags 🇬🇧",
    "lone surrogate \ud800 end",
    "<EOT> <|endoftext|> special-looking text",
    "Ünïcödé — “quotes” ‘and’ 日本語テキスト",
]
const counter = new TokenCounter()
const counts = []
let pid
try {
    for (const text of texts) {
        const actual = await counter.count(text)
        const expected = oracle(text)
        assert.equal(actual, expected)
        pid ??= counter.stats.pid
        assert.equal(counter.stats.pid, pid)
        assert.equal(readlinkSync(`/proc/${pid}/exe`), process.execPath)
        assert.equal(
            readFileSync(`/proc/${pid}/cgroup`, "utf8"),
            readFileSync("/proc/self/cgroup", "utf8"),
        )
        if (process.versions.bun) {
            assert.ok(
                readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes("BUN_BE_BUN=1"),
            )
        }
        counts.push({ actual, expected })
    }
    await assert.rejects(
        counter.count("x".repeat(8 * 1024 * 1024 + 1)),
        (error) => error instanceof TokenCountError && error.code === "too_large",
    )
} finally {
    await counter.dispose()
}
assert.ok(pid && !existsSync(`/proc/${pid}`))
const bounded = new TokenCounter({ jobTimeoutMs: 1, killMarginMs: 100, reapTimeoutMs: 2000 })
try {
    await assert.rejects(
        bounded.count("a".repeat(500000)),
        (error) => error instanceof TokenCountError && error.code === "timeout",
    )
} finally {
    await bounded.dispose()
}
console.log(
    JSON.stringify({
        execPath: process.execPath,
        bun: process.versions.bun,
        installed,
        counts,
        reusedChild: true,
        disposed: true,
        tooLarge: true,
        timeout: true,
        runtimeClosureClean: true,
    }),
)
