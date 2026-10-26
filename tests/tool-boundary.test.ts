import assert from "node:assert/strict"
import test from "node:test"
import type { Plugin, ToolContext, ToolDefinition } from "@opencode-ai/plugin"
import { tool as sdkTool } from "@opencode-ai/plugin"
import { z } from "zod"
import { tool } from "../lib/tool"

test("local helper preserves identity and real SDK schema interoperability", () => {
    const input = {
        description: "Boundary control",
        args: { value: tool.schema.string(), optional: tool.schema.boolean().optional() },
        async execute(args: { value: string }, context: ToolContext) {
            return `${context.sessionID}:${args.value}`
        },
    }
    const definition = tool(input)
    assert.equal(definition, input)
    assert.equal(tool.schema, z)
    const parser = sdkTool.schema.object(definition.args).strict()
    assert.equal(parser.parse({ value: "control" }).value, "control")
    assert.equal(Object.hasOwn(parser.parse({ value: "control" }), "optional"), false)
    assert.throws(() => parser.parse({ value: 1 }))
    assert.throws(() => parser.parse({ value: "control", extra: true }))
})

const inferred = tool({
    description: "Genuine SDK argument/context/result inference",
    args: { value: tool.schema.string() },
    async execute(args, context) {
        const value: string = args.value
        const sessionID: string = context.sessionID
        return { output: `${sessionID}:${value}` }
    },
})
const legacyDefinition: ToolDefinition = inferred
const legacyPlugin: Plugin = async () => ({ tool: { boundary: legacyDefinition } })
void legacyPlugin
