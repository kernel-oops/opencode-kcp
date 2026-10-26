// Exact token counting with the unchanged @anthropic-ai/tokenizer. Runs only inside the
// tokenizer child process (tokenizer-child.js), which kills its whole process
// on deadline because a worker executing WASM cannot be interrupted under Bun.
// No filesystem writes, network access or logging; text never leaves as output.
import { parentPort } from "node:worker_threads"
import * as tokenizer from "@anthropic-ai/tokenizer"

const getTokenizer = tokenizer.getTokenizer ?? tokenizer.default?.getTokenizer
// Keep PR #639's exact semantics, but only within this killable worker. A replacement
// worker builds its own encoder; the host never initialises or runs the WASM.
let encoder

parentPort.on("message", ({ id, text }) => {
    let count
    try {
        encoder ??= getTokenizer()
        count = encoder.encode(text.normalize("NFKC"), "all").length
    } catch {
        parentPort.postMessage({ id, error: "encode" })
        return
    }
    parentPort.postMessage({ id, count })
})
parentPort.postMessage({ ready: true })
