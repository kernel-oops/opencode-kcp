import { z } from "zod"
import type { tool as sdkTool } from "@opencode-ai/plugin"

export const tool: typeof sdkTool = Object.assign(<T>(input: T): T => input, { schema: z })
