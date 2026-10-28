// Public V2 setup/SDK-shaped fixture: no provider or live server requests.
import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import type { Message } from "@opencode/ai/schema/messages"
import { COMPRESS_INPUT_ARCHIVE_MARKER } from "../lib/compress/summary"

const root = mkdtempSync(join(tmpdir(), "dcp-v2-elision-"))
for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "OPENCODE_CONFIG_DIR"]) {
    process.env[name] = join(root, name)
    mkdirSync(process.env[name]!, { recursive: true })
}
test.after(() => rmSync(root, { recursive: true, force: true }))
const entrypoint =
    process.env.DCP_PACKAGE_ENTRY || new URL("../dist/index.js", import.meta.url).href
const built =
    process.env.DCP_PACKAGE_ENTRY !== undefined ||
    existsSync(new URL("../dist/index.js", import.meta.url))
const plugin: any = built ? (await import(entrypoint)).default : undefined

for (const mode of ["range", "message"] as const)
    test(
        `public V2 ${mode} hook reduces completed arguments, preserves native GET, and guards archive ingestion`,
        { skip: !built && "build the package first" },
        async () => {
            const directory = join(root, mode)
            mkdirSync(join(directory, ".opencode"), { recursive: true })
            writeFileSync(
                join(directory, ".opencode", "dcp.jsonc"),
                JSON.stringify({
                    autoUpdate: false,
                    pruneNotification: "off",
                    commands: { enabled: false },
                    compress: {
                        mode,
                        permission: "allow",
                        protectTags: true,
                        protectUserMessages: false,
                    },
                    strategies: {
                        deduplication: { enabled: false },
                        purgeErrors: { enabled: false },
                    },
                }),
            )
            const session = {
                id: `synthetic-${mode}`,
                agent: "build",
                model: { id: "fixture", providerID: "synthetic" },
                permissions: [],
            }
            const source =
                "Inspect the synthetic fixture. <protect>Retain synthetic acceptance evidence.</protect>"
            const summary =
                "Synthetic decision and implementation evidence, without claiming semantic fidelity. ".repeat(
                    60,
                )
            const input = {
                topic: "Synthetic decision",
                content: [
                    mode === "range"
                        ? { startId: "@1@", endId: "@1@", summary }
                        : { messageId: "@1@", topic: "Synthetic decision", summary },
                ],
            }
            let entries: any[] = [
                { id: "source", type: "user", text: source, time: { created: 1 } },
                { id: "latest", type: "user", text: "Continue", time: { created: 2 } },
            ]
            const hooks: Record<string, any> = {}
            let compress: any
            const ctx: any = {
                location: { directory },
                session: {
                    get: async () => structuredClone(session),
                    context: async () => structuredClone(entries),
                    hook: async (kind: string, callback: any) => {
                        hooks[kind] = callback
                    },
                },
                agent: { get: async () => ({ data: { permissions: [] } }) },
                model: { transform: async (callback: any) => callback({ list: () => [] }) },
                tool: {
                    transform: async (callback: any) =>
                        callback({
                            add: (tool: any) => {
                                compress = tool
                            },
                        }),
                },
                rpc: { register: async () => {} },
            }
            const stop = await plugin.setup(ctx)
            const context = {
                id: "call",
                sessionID: session.id,
                messageID: "origin",
                agent: "build",
                progress: async () => {},
            }
            const completed = await compress.execute(structuredClone(input), context)
            entries = [
                entries[0],
                {
                    id: "origin",
                    type: "assistant",
                    time: { created: 3 },
                    agent: "build",
                    model: session.model,
                    content: [
                        {
                            type: "tool",
                            id: "call",
                            name: "compress",
                            state: {
                                status: "completed",
                                input: structuredClone(input),
                                content: [{ type: "text", text: completed.content }],
                            },
                        },
                    ],
                },
                entries[1],
            ]
            const originalGET = structuredClone(entries)
            const native: Message[] = [
                { id: "source", role: "user", content: [{ type: "text", text: source }] },
                {
                    id: "origin",
                    role: "assistant",
                    content: [
                        {
                            type: "reasoning",
                            text: "Opaque fixture reasoning",
                            encrypted: "signature",
                        },
                        {
                            type: "tool-call",
                            id: "call",
                            name: "compress",
                            input: structuredClone(input),
                        },
                    ],
                },
                {
                    role: "tool",
                    content: [
                        {
                            type: "tool-result",
                            id: "call",
                            name: "compress",
                            result: { type: "text", value: completed.content },
                        },
                    ],
                },
                { id: "latest", role: "user", content: [{ type: "text", text: "Continue" }] },
            ] as Message[]
            const event = {
                sessionID: session.id,
                agent: "build",
                model: session.model,
                tools: { compress: {} },
                system: [],
                messages: native,
            }
            const file = join(
                process.env.XDG_DATA_HOME!,
                "opencode/storage/plugin/dcp",
                `${session.id}.json`,
            )
            const beforeHook = JSON.parse(readFileSync(file, "utf8"))
            beforeHook.lastUpdated = "before-context-hook"
            writeFileSync(file, JSON.stringify(beforeHook))
            await hooks.context(event)
            assert.notEqual(
                JSON.parse(readFileSync(file, "utf8")).lastUpdated,
                "before-context-hook",
            )
            const outgoingCall = event.messages
                .find((message) => message.id === "origin")!
                .content.find((part) => part.type === "tool-call") as any
            assert.equal(outgoingCall.input.content[0].summary, COMPRESS_INPUT_ARCHIVE_MARKER)
            assert.ok(JSON.stringify(outgoingCall.input).length < JSON.stringify(input).length)
            assert.deepEqual(await ctx.session.context(), originalGET)
            assert.equal((native[1]!.content[1] as any).input.content[0].summary, summary)
            assert.equal(
                (event.messages.find((m) => m.id === "origin")!.content[0] as any).encrypted,
                "signature",
            )
            const stored = JSON.parse(readFileSync(file, "utf8"))
            const block = stored.prune.messages.blocksById["1"]
            assert.ok(block.summary.includes("Retain synthetic acceptance evidence."))
            assert.equal(
                block.originalSummaryHash,
                createHash("sha256").update(JSON.stringify(summary)).digest("hex"),
            )
            const bad = structuredClone(input)
            bad.content[0]!.summary = COMPRESS_INPUT_ARCHIVE_MARKER
            await assert.rejects(
                compress.execute(bad, { ...context, id: "bad-call" }),
                /NOT summary content/,
            )
            assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), stored)
            stop?.()
        },
    )
