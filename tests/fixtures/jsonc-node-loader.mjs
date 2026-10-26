// The public build bundles jsonc-parser (see tsup.config.ts). Source-only Node
// tests need its published CommonJS entry: the package's ESM directory is not
// marked as ESM. This loader uses the real parser, not a configuration mock.
import { register } from "node:module"

register(
    `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@opencode/plugin/tui" || specifier.startsWith("@opentui/") || specifier === "@opencode/theme")
        throw new Error("Optional TUI runtime deliberately unavailable in server fixtures: " + specifier)
    return nextResolve(specifier === "jsonc-parser/lib/esm/main.js" ? "jsonc-parser" : specifier, context)
}
`)}`,
    import.meta.url,
)
