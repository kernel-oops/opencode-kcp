import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { join } from "node:path"
import test from "node:test"

const fixtureRoot = mkdtempSync(join(process.cwd(), "tests/.model-summary-buffer-"))
const globalConfig = join(fixtureRoot, "global")
const configDir = join(fixtureRoot, "config-dir")
const project = join(fixtureRoot, "project")
mkdirSync(join(globalConfig, "opencode"), { recursive: true })
mkdirSync(configDir, { recursive: true })
mkdirSync(join(project, ".opencode"), { recursive: true })
writeFileSync(
    join(globalConfig, "opencode", "dcp.json"),
    JSON.stringify({
        compress: { summaryBuffer: false, modelSummaryBuffer: { "provider/model-a": true } },
    }),
)
writeFileSync(
    join(configDir, "dcp.json"),
    JSON.stringify({ compress: { modelSummaryBuffer: { "provider/model-b": false } } }),
)
writeFileSync(
    join(project, ".opencode", "dcp.json"),
    JSON.stringify({ compress: { modelSummaryBuffer: { "provider/model-a": false } } }),
)
process.env.XDG_CONFIG_HOME = globalConfig
process.env.OPENCODE_CONFIG_DIR = configDir

// Node's ESM loader treats jsonc-parser's generated ESM files as CommonJS.
// Resolve the same package API for this source-level config test.
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "jsonc-parser/lib/esm/main.js") {
            return nextResolve("jsonc-parser", context)
        }
        return nextResolve(specifier, context)
    },
})

const { getConfig, getInvalidConfigKeys, validateConfigTypes } = await import("../lib/config")
const { createSessionState } = await import("../lib/state")
const { isContextOverLimits } = await import("../lib/messages/inject/utils")

const globalConfigPath = join(globalConfig, "opencode", "dcp.json")
const configDirPath = join(configDir, "dcp.json")
const projectConfigPath = join(project, ".opencode", "dcp.json")

function writeJson(path: string, value: unknown): void {
    writeFileSync(path, JSON.stringify(value))
}

function loadProjectConfig(warnings: string[] = []) {
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((callback: () => void) => {
        callback()
        return 0
    }) as typeof setTimeout

    try {
        return getConfig({
            directory: project,
            client: { tui: { showToast: ({ body }) => warnings.push(body.message) } },
        } as any)
    } finally {
        globalThis.setTimeout = originalSetTimeout
    }
}

test("nudge force defaults to strong and accepts explicit soft", () => {
    assert.equal(loadProjectConfig().compress.nudgeForce, "strong")
    const original = readFileSync(projectConfigPath, "utf8")
    try {
        writeJson(projectConfigPath, { compress: { nudgeForce: "soft" } })
        assert.equal(loadProjectConfig().compress.nudgeForce, "soft")
    } finally {
        writeFileSync(projectConfigPath, original)
    }
    const schema = JSON.parse(readFileSync(join(process.cwd(), "dcp.schema.json"), "utf8"))
    assert.equal(schema.properties.compress.properties.nudgeForce.default, "strong")
    assert.equal(schema.properties.compress.default.nudgeForce, "strong")
})

test("modelSummaryBuffer validates as a boolean map without treating qualified keys as config paths", () => {
    const config = { compress: { modelSummaryBuffer: { "provider/model": true } } }
    assert.deepEqual(getInvalidConfigKeys(config), [])
    assert.deepEqual(validateConfigTypes(config), [])

    for (const invalid of [null, [], "bad", 1]) {
        assert.ok(
            validateConfigTypes({ compress: { modelSummaryBuffer: invalid } }).some(
                (error) => error.key === "compress.modelSummaryBuffer",
            ),
        )
    }
    for (const invalid of ["true", 0, null, {}]) {
        assert.ok(
            validateConfigTypes({
                compress: { modelSummaryBuffer: { "provider/model": invalid } },
            }).some((error) => error.key === "compress.modelSummaryBuffer.provider/model"),
        )
    }
})

test("modelSummaryBuffer merges layers by key and each loaded config owns its map", () => {
    const first = loadProjectConfig()
    assert.deepEqual(first.compress.modelSummaryBuffer, {
        "provider/model-a": false,
        "provider/model-b": false,
    })
    first.compress.modelSummaryBuffer!["provider/model-b"] = true

    const second = loadProjectConfig()
    assert.deepEqual(second.compress.modelSummaryBuffer, {
        "provider/model-a": false,
        "provider/model-b": false,
    })
    assert.equal(second.compress.summaryBuffer, false)
})

test("modelSummaryBuffer accepts only qualified keys and boolean values", () => {
    const validRefs = ["provider/model", "provider/namespace/model"]
    const invalidRefs = [
        "",
        "unqualified",
        "/model",
        "provider/",
        "provider/model name",
        "provider/model\nname",
    ]

    for (const ref of validRefs) {
        assert.deepEqual(
            validateConfigTypes({ compress: { modelSummaryBuffer: { [ref]: false } } }),
            [],
        )
    }
    for (const ref of invalidRefs) {
        assert.ok(
            validateConfigTypes({ compress: { modelSummaryBuffer: { [ref]: true } } }).some(
                (error) => error.key === `compress.modelSummaryBuffer.${ref}`,
            ),
            `expected invalid reference ${JSON.stringify(ref)} to be rejected`,
        )
    }

    for (const value of ["false", "true", 0, 1, null, [], {}]) {
        assert.ok(
            validateConfigTypes({
                compress: { modelSummaryBuffer: { "provider/model": value } },
            }).some((error) => error.key === "compress.modelSummaryBuffer.provider/model"),
            `expected invalid value ${JSON.stringify(value)} to be rejected`,
        )
    }

    const schema = JSON.parse(readFileSync(join(process.cwd(), "dcp.schema.json"), "utf8"))
    const mapSchema = schema.properties.compress.properties.modelSummaryBuffer
    const keyPattern = new RegExp(mapSchema.propertyNames.pattern)
    assert.equal(mapSchema.additionalProperties.type, "boolean")
    for (const ref of validRefs) assert.equal(keyPattern.test(ref), true)
    for (const ref of invalidRefs) assert.equal(keyPattern.test(ref), false)
})

test("invalid entries across global, config-dir and project files are warned and ignored", () => {
    writeJson(globalConfigPath, {
        debug: true,
        compress: {
            summaryBuffer: false,
            modelSummaryBuffer: {
                "provider/global-string-false": "false",
                "provider/retained": true,
            },
        },
    })
    writeJson(configDirPath, {
        compress: {
            modelSummaryBuffer: {
                "provider/custom-string-false": "false",
                "provider/retained": "false",
                "provider/number": 0,
                "provider/null": null,
                "provider/array": [],
                "provider/object": {},
                unqualified: true,
            },
        },
    })
    writeJson(projectConfigPath, {
        compress: {
            modelSummaryBuffer: {
                "provider/project-string-false": "false",
                "provider/retained": "false",
            },
        },
    })

    const warnings: string[] = []
    const config = loadProjectConfig(warnings)

    assert.equal(config.debug, true)
    assert.equal(config.compress.summaryBuffer, false)
    assert.deepEqual(config.compress.modelSummaryBuffer, { "provider/retained": true })
    config.compress.maxContextLimit = -1
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, { active: true, summaryTokens: 100 } as any)
    state.prune.messages.activeBlockIds.add(1)
    assert.equal(
        isContextOverLimits(config, state, "provider", "global-string-false", []).overMaxLimit,
        true,
    )
    assert.equal(warnings.length, 3)
    assert.ok(warnings.some((warning) => warning.includes("provider/global-string-false")))
    assert.ok(warnings.some((warning) => warning.includes("provider/custom-string-false")))
    assert.ok(warnings.some((warning) => warning.includes("provider/project-string-false")))
})

test("an invalid whole map is warned and ignored without erasing valid lower layers", () => {
    writeJson(globalConfigPath, {
        debug: true,
        compress: { summaryBuffer: false, modelSummaryBuffer: { "provider/lower": true } },
    })
    writeJson(configDirPath, { compress: { modelSummaryBuffer: { "provider/custom": false } } })

    for (const invalid of [null, [], "invalid", 1]) {
        writeJson(projectConfigPath, {
            debug: true,
            compress: { modelSummaryBuffer: invalid },
        })
        const warnings: string[] = []
        const config = loadProjectConfig(warnings)
        assert.equal(config.debug, true)
        assert.equal(config.compress.summaryBuffer, false)
        assert.deepEqual(config.compress.modelSummaryBuffer, {
            "provider/lower": true,
            "provider/custom": false,
        })
        assert.equal(warnings.length, 1)
        assert.ok(warnings[0].includes("compress.modelSummaryBuffer"))
    }
})

test.after(() => rmSync(fixtureRoot, { recursive: true, force: true }))
