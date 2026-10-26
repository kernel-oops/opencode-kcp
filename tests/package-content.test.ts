import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { assertPackedFiles, packageLooksCommonJs } from "../scripts/verify-package.mjs"

test("dual exports use the ESM import target rather than the CommonJS main", () => {
    assert.equal(
        packageLooksCommonJs({
            type: "module",
            main: "./index.cjs",
            exports: { ".": { import: "./index.js", require: "./index.cjs" } },
        }),
        false,
    )
    assert.equal(packageLooksCommonJs({ main: "./index.cjs" }), true)
    assert.equal(packageLooksCommonJs({ type: "commonjs", main: "./index.js" }), true)
})

test("real archive listing rejects private canaries and missing runtime files", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "kcp-pack-"))
    const required = [
        "dist/index.js",
        "dist/index.d.ts",
        "dist/tui.d.ts",
        "tui.tsx",
        "server.js",
        "lib/tokenizer/tokenizer-child.js",
        "lib/tokenizer/tokenizer-worker.js",
        "lib/tokenizer/tokenizer-runtime.bunfig.toml",
        "lib/tokenizer/tsconfig.json",
        "lib/auth.ts",
        "lib/config.ts",
        "README.md",
        "LICENSE",
    ]
    const canaries = [
        "release/secret.txt",
        ".qualification/secret.txt",
        ".impl-private/secret.txt",
        "LOCAL-PROVENANCE.json",
        "lib/.env.private",
        "lib/.envrc",
        "lib/.environment",
        "lib/auth/session.json",
        "lib/state/private.db",
        "lib/auth.json",
        "lib/config/private.json",
        "unexpected.txt",
    ]
    try {
        writeFileSync(
            path.join(root, "package.json"),
            JSON.stringify({
                name: "kcp-pack-canary",
                version: "1.0.0",
                private: true,
                files: [...required, ...canaries],
            }),
        )
        for (const name of [...required, ...canaries]) {
            mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
            writeFileSync(path.join(root, name), "canary\n")
        }
        const [packed] = JSON.parse(
            execFileSync("npm", ["pack", "--ignore-scripts", "--json"], {
                cwd: root,
                encoding: "utf8",
                timeout: 30_000,
            }),
        )
        assert.ok(readFileSync(path.join(root, packed.filename)).byteLength > 0)
        const paths = execFileSync("tar", ["-tzf", path.join(root, packed.filename)], {
            encoding: "utf8",
            timeout: 10_000,
        })
            .trim()
            .split("\n")
            .map((name) => name.replace(/^package\//, ""))
        const clean = paths.filter((name) => !canaries.includes(name))
        assertPackedFiles(clean)
        assert.throws(
            () => assertPackedFiles(clean.filter((name) => name !== "server.js")),
            /missing server.js/,
        )
        for (const name of canaries) {
            assert.ok(paths.includes(name), `actual archive must contain test canary ${name}`)
            assert.throws(() => assertPackedFiles([...clean, name]), /forbidden path/, name)
        }
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})
