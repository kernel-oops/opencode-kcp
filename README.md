# KCP — unpublished Dynamic Context Pruning derivative

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/dansmolsky)

KCP manages conversation context in OpenCode. This local, unpublished derivative of
[Dynamic Context Pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)
retains upstream author tarquinen's notices and the AGPL-3.0-or-later licence (see
`LICENSE`). It is not the upstream npm package, and no public KCP fork or registry
release is advertised here. Both legacy V1 and V2 adapters remain included.

![DCP in action](assets/images/dcp-demo9.png)

## Installation

**Packaging qualification is pending:** ordinary peer source installation is
supported with lifecycle scripts disabled. Do not use legacy-peer flags or force.
Full installed-package and stock-host acceptance is separate from installation;
the commands below are not a claim that every host/platform has been qualified.

Build with Node 24.22.0 and npm 11.19.1 in a trusted source checkout:

```bash
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
npm run verify:package
npm pack --ignore-scripts
```

Lifecycle scripts are deliberately disabled during dependency installation. Build
explicitly before packing; `npm pack` does not run `prepublishOnly`. The package
retains `private: true` to prevent accidental publication; local packing and tarball
installation do not require removing that protection.

In a separate consumer directory, install the actual generated archive using its
absolute path (not a source symlink or a copied `node_modules` tree):

```bash
npm init -y
npm install --ignore-scripts /absolute/path/to/opencode-kcp-3.2.0-kernel-oops.20261023.1.tgz
```

For a V2 server, add the installed **package directory** to `plugins` in your
`opencode.jsonc`:

```jsonc
{
    "$schema": "https://opencode.ai/config.json",
    "plugins": ["/absolute/path/to/consumer/node_modules/opencode-kcp"],
}
```

CLI plugins have a separate global `cli.json`. To use KCP's panel when connecting
to a remote server, add that same locally installed directory to its `plugins`
array on the CLI machine too. The package exports `./tui` for the host's source
loader; bare Node is not a TSX renderer. The server entrypoints (`.` and `./server`)
load the emitted server code, without starting a renderer. This local-tarball
workflow does not qualify OpenCode's native registry-install pipeline.

KCP's updater remains a no-op for this unpublished identity. Replace a local
installation explicitly after building and qualifying a new archive; do not expect
upstream DCP updates to update KCP.

The non-publishing PR workflow is prepared, not remotely executed or qualified.
Fresh tarball consumer, exact tokenizer, and stock OpenCode 2.1.4 server/panel/manual-toggle
acceptance remain required before delivery. Stock integration is a local gate:
use private HOME/XDG/cache/state, loopback-only rootless network isolation and a
separate user cgroup capped at 4 GiB RAM, no swap and 300 seconds. Do not assume
GitHub-hosted runners provide those capabilities, or substitute a live provider.

### Runtime and declaration dependencies

The runtime package uses the patched direct Zod validator, tokenizer and JSONC
parser; the SDK identity helper is implemented locally with its real SDK type.
OpenCode supplies TUI rendering/JSX at runtime. SDKs, renderer and Solid are
development/host type inputs, not installed runtime requirements. The existing
legacy SDK peer is optional, so a pure runtime consumer does not auto-install it.

Published declarations are not self-contained: TypeScript consumers need the real
`@opencode-ai/plugin`, `@opencode-ai/sdk` and `@opencode/plugin` contracts matching
their host, plus the host's TUI types when inspecting TUI declarations. Do not
replace these with ambient shims. The source graph unifies SDK Zod declarations
with its direct patched validator through an actual dependency override. That
override does not propagate to consumers; runtime safety must come from the
consumer's actual small graph, not source overrides.

Development OpenTUI 0.5.10 requires published Solid 1.9.12. Its actual Seroval and
seroval-plugins leaves are scoped to patched 1.6.12, outside Solid's old declared
leaf range. This is a tested bounded development binding, not patched Solid
1.9.16 or a claim that every Solid SSR API is compatible.

## Upstream Project Status

Development on DCP has slowed because most new context-management work has moved to [Sleev](https://sleev.ai) and the `sleev` CLI.

Sleev builds on DCP's core ideas with more advanced context management and significantly better performance. It's a local proxy that already supports Claude Code, Codex, OpenCode, Pi, and Hermes, and can be extended to support any harness.

DCP remains available for OpenCode plugin users, but new features are landing in Sleev first. If you are starting fresh, we recommend trying Sleev:

```bash
npm i -g sleev
sleev
```

## How It Works

DCP reduces context size through a compress tool and automatic cleanup. Your session history is never modified — DCP replaces pruned content with placeholders before sending requests to your LLM.

### Compress

Compress is a tool exposed to your model that replaces closed, stale conversation content with high-fidelity technical summaries. You can think of this as a much smarter version of Opencode's compaction process. Instead of triggering statically when your session reaches its maximum context and on the entire coding session, Compress allows the model to pick when to activate based on task completion, and to only compress the specific messages that are no longer needed verbatim.

DCP supports two compression modes:

- `range` mode compresses contiguous spans of conversation into one or more summaries.
- `message` mode (experimental) compresses individual raw messages independently, letting the model manage context much more surgically.

In `range` mode, when a new compression overlaps an earlier one, the earlier summary is nested inside the new one so information is preserved through layers of compression rather than diluted away. In both modes, protected tool outputs (such as subagents and skills) and protected file patterns are kept in compression summaries, ensuring that the most important information is never lost. You can also enable `protectUserMessages` to preserve your messages verbatim during compression, though note that large prompts (e.g. copy-pasting log files in the prompt) will then never be compressed away.

On V2, completed `compress` calls can otherwise repeat their submitted summaries alongside the rendered compression blocks. DCP replaces only those historical `content[].summary` arguments in the outgoing model view when every entry has an exact saved origin and a rendered active block (or an unambiguous saved consumed-block lineage to one). The marker explicitly identifies itself as a post-completion view replacement, not the original submission. Native session history, results, IDs, attachments and reasoning are unchanged. Missing or uncertain proof retains the entire call input; explicitly protecting `compress` through `compress.protectedTools` disables this optimisation.

New V2 blocks optionally store a SHA-256 fingerprint of the original summary before protected content and nested blocks are added. Older records without that proof remain readable and retain their historical arguments; no state migration is required. Known archive markers alone are rejected as new summaries in both V1 and V2, while substantive quotations remain allowed. This guard prevents a specific metadata-ingestion mistake, not arbitrary loss of meaning in otherwise valid prose.

### Deduplication

Identifies repeated tool calls (same tool, same arguments) and keeps only the most recent output. Recalculated when the compress tool runs, so prompt cache is only impacted alongside compression.

### Purge Errors

Prunes inputs from errored tool calls after a configurable number of turns. Error messages are preserved; only the potentially large input content is removed. Recalculated on compress tool use.

### Token Counting

Token counts use the Anthropic tokenizer in a separate child process (`lib/tokenizer/`), so a slow encode cannot block OpenCode. Each count has a hard deadline (5 seconds by default); if it is exceeded, the child is killed and the count fails with an error rather than an estimate. After a failed child is confirmed stopped, later counts may start a fresh child; if it cannot be stopped, counting stays unavailable. The child receives a minimal environment, ignores any surrounding project's Bun and TypeScript configuration, and exits with OpenCode or after being idle. Requests are not cancelled early: a count, or an operation needing several counts, started for an interrupted request may keep one CPU core busy until it completes or reaches its deadline.

## Configuration

DCP uses its own config file, searched in order:

1. Global: `~/.config/opencode/dcp.jsonc` (or `dcp.json`), created automatically on first run
2. Custom config directory: `$OPENCODE_CONFIG_DIR/dcp.jsonc` (or `dcp.json`), if `OPENCODE_CONFIG_DIR` is set
3. Project: `.opencode/dcp.jsonc` (or `dcp.json`) in your project's `.opencode` directory

Each level overrides the previous, so project settings take priority over global. Restart OpenCode after making config changes.

> [!NOTE]
> If your model has a smaller context window, lower `compress.minContextLimit` and `compress.maxContextLimit` in your configuration to match the available context.

> [!IMPORTANT]
> Defaults are applied automatically. Expand this if you want to review or override settings.

<details>
<summary><strong>Default Configuration</strong> (click to expand)</summary>

```jsonc
{
    "$schema": "/absolute/path/to/consumer/node_modules/opencode-kcp/dcp.schema.json",
    // Enable or disable the plugin
    "enabled": true,
    // Automatically update npm-installed DCP when a newer npm latest is available.
    // Version-locked plugin specs are not updated.
    "autoUpdate": true,
    // Enable debug logging to ~/.config/opencode/logs/dcp/
    "debug": false,
    // Notification display: "off", "minimal", or "detailed"
    "pruneNotification": "detailed",
    // Notification type: "chat" (in-conversation) or "toast" (system toast)
    "pruneNotificationType": "chat",
    // Slash commands configuration
    "commands": {
        "enabled": true,
        // Additional tools to protect from pruning via commands (e.g., /dcp sweep)
        "protectedTools": [],
    },
    // Manual mode: disables autonomous context management,
    // tools only run when explicitly triggered via /dcp commands
    "manualMode": {
        "enabled": false,
        // When true, automatic cleanup (deduplication, purgeErrors)
        // still runs even in manual mode
        "automaticStrategies": true,
    },
    // Protect from pruning for <turns> message turns past tool invocation
    "turnProtection": {
        "enabled": false,
        "turns": 4,
    },
    // Experimental settings
    "experimental": {
        // Allow DCP processing in subagent sessions
        "allowSubAgents": false,
        // Enable user-editable prompt overrides under dcp-prompts directories
        // When false (default), prompt override files/directories are ignored
        "customPrompts": false,
    },
    // Protect file operations from pruning via glob patterns
    // Patterns match tool parameters.filePath (e.g. read/write/edit)
    "protectedFilePatterns": [],
    // Unified context compression tool and behavior settings
    "compress": {
        // Compression mode: "range" (compress spans into block summaries)
        // or experimental "message" (compress individual raw messages)
        "mode": "range",
        // Permission mode: "allow" (no prompt), "ask" (prompt), "deny" (tool not registered)
        "permission": "allow",
        // Show compression content in a chat notification
        "showCompression": false,
        // Let active summary tokens extend DCP's soft maxContextLimit nudge threshold.
        // This does not increase actual model capacity or a firm request ceiling.
        "summaryBuffer": true,
        // Optional exact provider/model overrides for summaryBuffer.
        // When a key is absent, the global summaryBuffer setting applies.
        // "modelSummaryBuffer": {
        //     "provider/model": false
        // },
        // Soft upper threshold: above this, DCP keeps injecting strong
        // compression nudges (based on nudgeFrequency), so compression is
        // much more likely. Accepts: number or "X%" of model context window.
        "maxContextLimit": 100000,
        // Soft lower threshold for reminder nudges: below this, turn/iteration
        // reminders are off (compression less likely). At/above this, reminders
        // are on. Accepts: number or "X%" of model context window.
        "minContextLimit": 50000,
        // Optional per-model override for maxContextLimit by providerID/modelID.
        // If present, this wins over the global maxContextLimit.
        // Accepts: number or "X%".
        // Example:
        // "modelMaxLimits": {
        //     "provider/model": "80%"
        // },
        // Optional per-model override for minContextLimit.
        // If present, this wins over the global minContextLimit.
        // "modelMinLimits": {
        //     "provider/model": "25%"
        // },
        // How often the context-limit nudge fires (1 = every fetch, 5 = every 5th)
        "nudgeFrequency": 5,
        // Start adding compression reminders after this many
        // messages have happened since the last user message
        "iterationNudgeThreshold": 15,
        // Controls how likely compression is after user messages
        // ("strong" = more likely, "soft" = less likely)
        "nudgeForce": "soft",
        // Tool names whose completed outputs are appended to the compression
        "protectedTools": [],
        // Preserve text wrapped in <protect>...</protect> when compressed
        "protectTags": false,
        // Preserve your messages during compression.
        // Warning: large copy-pasted prompts will never be compressed away
        "protectUserMessages": false,
    },
    // Automatic pruning strategies
    "strategies": {
        // Remove duplicate tool calls (same tool with same arguments)
        "deduplication": {
            "enabled": true,
            // Additional tools to protect from pruning
            "protectedTools": [],
        },
        // Prune tool inputs for errored tools after X turns
        "purgeErrors": {
            "enabled": true,
            // Number of turns before errored tool inputs are pruned
            "turns": 4,
            // Additional tools to protect from pruning
            "protectedTools": [],
        },
    },
}
```

</details>

### Commands

DCP provides a TUI panel and one prompt-producing slash command:

- `/dcp` — Opens the DCP panel with context, stats, and manual-mode controls.
- `/dcp-compress [focus]` — Asks the model to run one compression pass. Optional focus text directs what content to compress, following the active `compress.mode`.

### Prompt Overrides

DCP exposes the following editable prompts:

- `system`
- `compress-range`
- `compress-message`
- `context-limit-nudge`
- `turn-nudge`
- `iteration-nudge`

This feature is disabled by default. Set `experimental.customPrompts` to `true` in your DCP config to activate it.

When enabled, managed defaults are written to `~/.config/opencode/dcp-prompts/defaults/` as plain-text prompt files. A single `README.md` in that directory explains each prompt and how to create overrides.

To customize behavior, add a file with the same name under an overrides directory and edit it as plain text.

Bundled summaries prioritise continuation state, user intent, authority and usable evidence over an investigation archive. Use the existing overrides for site-specific verbosity or evidence presentation, while preserving these fidelity safeguards and the host's ID, placeholder and protection instructions. Overrides are not enabled or replaced automatically by this guidance.

To reset an override, delete the matching file from your overrides directory.

### Protected Tools

By default, these tools are always protected from pruning:
`task`, `skill`, `todowrite`, `todoread`, `compress`, `batch`, `plan_enter`, `plan_exit`, `write`, `edit`

The `protectedTools` arrays in `commands` and `strategies` add to this default list.

For the `compress` tool, `compress.protectedTools` ensures specific tool outputs are appended to the compressed summary. By default it includes `task`, `skill`, `todowrite`, and `todoread`.

## Impact on Prompt Caching

LLM providers cache prompts based on exact prefix matching. When DCP prunes content, it changes messages, which invalidates cached prefixes from that point forward.

**Trade-off:** Pruning reduces context size but can increase cache misses. The cost
balance depends on your conversation, compression frequency, and provider pricing.

**No impact for:**

- **Request-based billing** — Some providers charge per request, not tokens.
- **Uniform token pricing** — Providers that bill cached and uncached tokens at the same rate.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, local installation,
and testing with the V1/V2 sandbox.

## License

AGPL-3.0-or-later

# OpenCode V2 compatibility boundaries

The V2 server adapter uses public OpenCode APIs, not private fork hooks. Its
baseline requires callable `session.get`, `session.context`, `session.hook`,
`agent.get` and `tool.transform`, and a project `location.directory`. Setup checks
these before registering hooks or tools. A missing baseline produces one precise
console diagnostic and leaves compression unregistered; it does not select a
fictional V1 fallback. The existing V1 entry remains a separate loader contract.

| Existing V2 facility                    | When unavailable                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `model.transform`                       | Keep compression and existing absolute configured thresholds; do not invent a context size. |
| `command.transform` or `session.prompt` | Omit DCP command registration; compression tools remain available.                          |
| `rpc.register`                          | Omit RPC/TUI controls; compression and supported commands remain available.                 |
| Compatible TUI runtime                  | Use the server entry without the separate optional `./tui` entry.                           |

Availability means a callable method, not merely a truthy object. Ordinary
registration, I/O, permission and programming errors still propagate; they are
not silently relabelled as an unsupported feature. Setup diagnostics are bounded
per reason per plugin instance and do not call models or add background jobs.
Unknown or invalid model IDs/context limits are not cached. Only finite positive
`limit.context` values with non-empty provider/model IDs are used. Percentage
thresholds cannot resolve without known metadata; absolute configuration retains
its existing behaviour. A model context limit is not a guaranteed safe input
budget: it does not resolve output reservations or request-specific headroom.

Session reads must return the requested session identity and a direct array of
uniquely identified native entries. The public `agent.get` result is correctly
wrapped as `{ location, data }`; permission rules come from `data.permissions`.
Invalid identities or permission rules reject the affected operation before
compression. Permission `deny` and `ask` remain fail-closed. Public V2 already
offers `permission.assert`, but this adapter does **not** yet integrate its ask
flow; ask is not treated as allow. These checks do not add archival retrieval:
`session.context` is the current window after the latest native compaction, not
an archive of all original messages.

The normal server entry is already separate from `./tui` and must not import
host-specific TUI bindings. An optional TUI import failure occurs before setup
and cannot be rescued by a later method check; select only a public-compatible
TUI entry for the installed runtime. An arbitrary TUI evaluation error is not
evidence of a missing capability. No frozen compiler/runtime snapshots are part
of this compatibility change. DCP manual mode does not disable OpenCode's own
automatic native compaction.

Observer measurements, compression-input elision and explicit rewrite are **not
implemented in this public baseline**. Any future patches need their own safe
data/integrity checks; method detection here does not gate or implement them.
Likewise, this change does not incorporate a separate child-result integrity
repair or claim that all protected child evidence can already be reconstructed.
Missing integrity requirements must reject the affected mutation, never disable
protection. No new OpenCode host patch is required for the interfaces above.

## Portable compatibility verification

`tests/v2-capabilities.test.ts` uses the installed public `@opencode/plugin`
contracts for the wrapped agent response, direct context array and mutable
context/compaction request shapes. The dispatch fixture follows public OpenCode
[v2.0.30 request dispatch](https://github.com/anomalyco/opencode/blob/f16ef9ad8878279ea2be3cfab7baeed97aef61aa/packages/core/src/session/model-request.ts#L422-L430):
primary requests trigger `session/context`, and compaction requests trigger
`session/compaction`, passing the draft plus agent/tools. Interface provenance is
also available in the [public Promise adapter](https://github.com/anomalyco/opencode/tree/f7d5b6ffc48223e654b20043a500d315e4bc8053/packages/plugin/src/promise).
The fixture runs registered adapter callbacks and real range/message executors,
without a provider, live session database or private host checkout. It is **not**
a full stock-host integration run and does not establish cross-version TUI ABI
compatibility or provider behaviour.

Run the targeted source test with:

```sh
node --import tsx --import ./tests/fixtures/jsonc-node-loader.mjs --test tests/v2-capabilities.test.ts
npx tsc -p tests/tsconfig.v2-capabilities.json
```

The test isolates HOME/config/data under the checkout's ignored `.impl-private`
directory. The loader uses the real published Node parser entry to work around
`jsonc-parser`'s ESM packaging (the normal public build already bundles it), and
deliberately rejects TUI runtime imports to prove server independence. For the
full source suite, preload that loader with `NODE_OPTIONS`, isolate HOME,
`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `OPENCODE_CONFIG_DIR` and `TMPDIR` in owned
disposable directories, then run `npm test`. Keep build/typecheck/package checks
separate. No test here needs personal configuration or production/provider access.

## Explicit summary rewrites (V2 range mode)

The public V2 range tool accepts an optional per-entry `rewrite` boolean, without inserting a default. Absent or `false` retains ordinary range compression and placeholder reinsertion. A rewrite batch must set `true` on every entry and use the same active, primary-view-visible block ID at both boundaries. Mixed batches, overlapping coverage, missing current originals and replacement placeholders reject the whole batch.

Every fully protected and wrapped replacement must strictly shrink under exact DCP tokenisation. Counts include the raw protection floor and every attested prior child payload; equality or growth rejects. This is not a claim about provider prompt tokens or billing savings. Previously protected child payloads remain verbatim, even when a newer child result exists. Complete evidence attests protected bytes, **not historical finality or terminal success**. Legacy child-bearing blocks, cache-only/fallback captures and incomplete or altered evidence are deliberately ineligible; current settings or a fresh child result cannot repair missing provenance.

Rewrites retain predecessor records and lineage. Native compaction retires blocks: current context is not a permanent archive. Where originals remain available, decompressing a successor restores its predecessor; further decompression can expose raw originals. `/dcp recompress` reapplies user-decompressed summaries; it does not rewrite them. Do not retry automatically after rejection or a committed/superseded outcome.

V1 and message mode do not support `rewrite`, including `false`. Entry schemas reject unknown fields rather than silently stripping them; this also rejects other previously unadvertised extra entry keys. Editable prompt overrides cannot remove the schema or mandatory format rules.

### Optional low-yield observation

The top-level `minimumReductionPercent` accepts a finite number from 0 to 100, defaulting at runtime to 10 without adding a default to submitted arguments. In supported V2 range mode, a successful ordinary compression observes its exact calling assistant and the immediately next completed assistant with the same known agent, provider, model and variant. A reduction at or below the threshold, flat usage or growth can produce one transient advisory at the next normal context hook. Zero still warns on flat usage and growth; it does not disable observation.

This compares native stored prompt usage: non-cached input plus cache reads and writes, excluding output and reasoning. It is a normalised next-prompt comparison, not an isolated causal saving, provider billing claim or safe-input budget. Missing or unusable usage silently skips this optional feature. Intervening context changes invalidate the measurement; the observer never scans forward for a more favourable pair. Successful rewrites/message calls, commands, reset and compaction cancel pending observations; rejected rewrites preserve shared state. No measurement is persisted and no extra provider call, retry or timer is introduced. V1 and message mode accept the percentage but do not produce range-only rewrite advice. Advice never makes legacy or unproven blocks eligible: all rewrite protection, visibility, provenance and strict-shrink checks still apply.
