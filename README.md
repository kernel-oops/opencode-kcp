# KCP for OpenCode

**Selective, model-driven compression with guarded summary rewrites and native history preservation.**

Keep useful working context, summarise closed work, and revise an older summary only when its evidence and protection rules permit it. KCP works as a plugin on stock OpenCode V2: **no custom Core build is required**.

**First public release: 0.1.0 · [AGPL-3.0-or-later](LICENSE) · [Releases](https://github.com/kernel-oops/opencode-kcp/releases)**

> **A very large thank-you to DCP and ACP.** KCP is directly derived from [Dynamic Context Pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning), created by **tarquinen and its contributors**. Its architecture, much of its implementation and many everyday features are their work. [Active Context Pruning](https://github.com/ranxianglei/opencode-acp), by **ranxianglei and contributors**, is an important influence on the model-driven approach and our experience of managing long conversations. KCP's direct source ancestry is DCP; this is not a claim that ACP's implementation was copied into KCP. Original notices and the AGPL licence are retained.

[Install](#quick-start) · [What's included](#whats-included) · [DCP, ACP and KCP](#dcp-acp-and-kcp) · [Configuration](#configuration) · [Limits](#limits-worth-understanding) · [Credits](#credits-and-licence)

## What's included

### The DCP foundation

KCP retains DCP's model-invoked compression, ordinary range mode and experimental message mode, nested summaries, protected tool/file handling, duplicate-call cleanup, old error-input cleanup, manual controls and shared configuration. These are **inherited capabilities**, not inventions being rebranded as new KCP features.

### KCP's additions and hardening

| Area                               | What KCP bundles                                                                                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Guarded summary rewrites**       | V2 range mode can replace an existing active summary with a strictly smaller one. Every entry must explicitly request a rewrite; mixed batches, uncertain identity, missing originals, placeholders and non-shrinking results reject.                               |
| **Protected child evidence**       | Rewrites retain attested protected bytes, including prior child payloads. A newer result, changed settings or a cache-only copy cannot stand in for missing original evidence.                                                                                      |
| **Atomic changes**                 | Failed validation or protection checks reject the affected batch without partially committing its proposed rewrite.                                                                                                                                                 |
| **Continuation-focused guidance**  | Compression prompts and nudges emphasise current user intent, authority, ownership, unresolved work and usable evidence rather than a long investigation diary.                                                                                                     |
| **Outgoing-only argument elision** | Proven completed compression inputs can be replaced in the outgoing model view once their summaries are represented by active blocks/lineage. Original native tool arguments and session history remain unchanged; uncertain provenance retains the original input. |
| **Bounded exact counting**         | The Anthropic tokenizer runs in a killable child with deadlines and bounded queues. Counts fail closed rather than becoming estimates; the host event loop does not run the encoder.                                                                                |
| **Optional low-yield advice**      | A supported ordinary V2 range compression can compare its calling assistant with the next matching completed assistant's native prompt usage and offer one advisory. It creates no extra model call and is not an isolated billing-savings measurement.             |
| **Portable packaging**             | Separate server and source-loaded TUI entries, real public SDK types, a small patched runtime dependency graph, and stock-host qualification rather than a required private Core patch.                                                                             |

The public release is the **same full-featured artefact intended for our own use**. There is no enhanced private KCP engine or deliberately reduced public edition. Separate custom host features are not part of this plugin.

## DCP, ACP and KCP

These projects share ideas and ancestry; this is an approach comparison, **not a performance ranking**.

| Project                                                                     | Documented approach                                                                                                                                                    | OpenCode generation / distinction                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [DCP](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)     | Selective model-driven compression plus automatic cleanup, protected content and manual controls.                                                                      | The shared source foundation contains V1/V2 adapters and separate server/TUI entrypoints. KCP builds on that foundation.                                                                          |
| [ACP — Active Context Pruning](https://github.com/ranxianglei/opencode-acp) | Model-driven `compress` / `decompress`, `acp_status` and `search_context`; documented T1 capture → T2 distill → T3 condense hierarchy, with a full-window GC fallback. | Its current README explicitly supports OpenCode **V1**, not V2, and recommends [billion-context](https://github.com/ranxianglei/billion-context) for V2. That does **not** mean ACP is abandoned. |
| **KCP**                                                                     | DCP-derived selective compression with the guarded rewrite/evidence/atomicity and outgoing-view work described above.                                                  | Retains V1/V2 adapters; actual stock **V2.1.4** server and TUI paths have been qualified. KCP does not implement ACP's complete hierarchical/GC system or promise an infinite context window.     |

Comparison checked **26 October 2026** against DCP **3.2.0** ([source](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning/tree/f8232fde1e63c2251687e4d9634bd53ce11568cb)) and ACP **1.18.5** ([README](https://github.com/ranxianglei/opencode-acp/blob/98a16d5b43f640abc2e2eac7903553786baaf37b/README.md)). Both projects may evolve; consult their current documentation. Their benchmarks, papers and marketing claims are not KCP benchmarks or guarantees.

KCP exposes **one model-facing agent tool: `compress`**. ACP's separate
model-facing `decompress`, `search_context` and `acp_status` tools, its tiered
compression system and its GC fallback are **not bundled into KCP**. KCP's
retained user-facing decompression/recompression controls are not equivalent
to that complete ACP toolset. "The same full-featured artefact" means one KCP
for public and own use, not a superset of every historical ACP feature.

## Quick start

Use the **built GitHub release asset**, not an npm registry name or a Git URL that omits the build output. KCP intentionally retains `private: true` as protection against accidental npm publication; it does not prevent local tarball installation.

### 1. Download, verify and install

The following Linux shell example installs release **v0.1.0** into a user-owned prefix. It does not change your OpenCode configuration automatically.

```bash
(
    set -eu
    mkdir -p "$HOME/.cache/opencode-kcp/v0.1.0"
    cd "$HOME/.cache/opencode-kcp/v0.1.0"
    curl --fail --location --remote-name \
        https://github.com/kernel-oops/opencode-kcp/releases/download/v0.1.0/opencode-kcp-0.1.0.tgz
    curl --fail --location --remote-name \
        https://github.com/kernel-oops/opencode-kcp/releases/download/v0.1.0/SHA256SUMS
    sha256sum --check SHA256SUMS
    npm install --prefix "$HOME/.local/share/opencode-kcp" --ignore-scripts \
        "$PWD/opencode-kcp-0.1.0.tgz"
    printf '%s\n' "$HOME/.local/share/opencode-kcp/node_modules/opencode-kcp"
)
```

Keep the printed absolute directory for the next steps. This is the qualified **local npm tarball + installed-directory** route; OpenCode's native registry-install pipeline is not claimed to have been exercised. Node **24.22.0** and npm **11.19.1** were used for qualification. Dependency lifecycle scripts are deliberately disabled.

### 2. Configure the server

Back up your existing configuration and plugin state first. In the server's `opencode.jsonc`, merge KCP into the existing `plugins` array:

```jsonc
{
    "$schema": "https://opencode.ai/config.json",
    "plugins": ["/absolute/path/printed/above"],
}
```

Replace the example with the **actual installed directory**, not the archive or `dist/index.js`. Do not assume `~` or `$HOME` expands inside JSON strings. Preserve unrelated plugins and settings. For server/global/project configuration locations, see the [OpenCode plugin guide](https://opencode.ai/v2/docs/build/plugins).

### 3. Configure each CLI client separately

For the panel and manual-mode controls, add that client's locally installed package directory to its **global** `~/.config/opencode/cli.json` (or `$XDG_CONFIG_HOME/opencode/cli.json`):

```jsonc
{
    "$schema": "https://opencode.ai/v2/cli.json",
    "plugins": ["/absolute/path/on/this/client/to/node_modules/opencode-kcp"],
}
```

The server and CLI settings are separate. With a remote server, install the same release asset on each client that needs the TUI; do not paste a server-only filesystem path into another machine's CLI config. See [CLI settings](https://opencode.ai/v2/docs/cli/config). The host loads the exported `./tui` entry; bare Node is not a TSX renderer.

**Run one context-management engine at a time.** Remove old DCP/ACP/KCP declarations from the relevant server and CLI plugin lists, and check automatically discovered plugin directories too. Back up and move an old engine outside discovery rather than deleting its state. A leftover auto-discovered copy can still load after its explicit configuration entry is removed.

### Updating or migrating

Download and verify the chosen new release, install its exact archive into your chosen prefix, and keep both sides on the intended version. KCP's inherited updater is a **no-op for this package identity**; it does not silently track upstream DCP or an unpublished npm release.

The compatibility names `opencode-dcp`, `/dcp`, the `dcp` RPC namespace, `dcp.jsonc` and existing storage conventions are intentional. They have not been cosmetically renamed. Do not run an old engine alongside KCP merely because these names look familiar. Back up configuration/state before migration; do not blindly copy ACP state, delete state, or assume KCP can recover material already discarded by another engine or native compaction.

## Configuration

KCP retains the existing `dcp.jsonc` / `dcp.json` configuration. Later layers override earlier ones:

1. Global `~/.config/opencode/dcp.jsonc` (or `dcp.json`).
2. `$OPENCODE_CONFIG_DIR/dcp.jsonc` (or `dcp.json`) when set.
3. Project `.opencode/dcp.jsonc` (or `dcp.json`).

A small starting configuration can use the installed schema:

```jsonc
{
    "$schema": "/absolute/path/to/node_modules/opencode-kcp/dcp.schema.json",
    "enabled": true,
    "compress": {
        "mode": "range",
        "minContextLimit": 50000,
        "maxContextLimit": 100000,
    },
}
```

These thresholds are **soft nudge thresholds**, not enforced final-prompt caps. Adjust them to the model and workload; output reservations, added tools and request-specific headroom matter too. KCP does not disable OpenCode's native compaction. Manual mode also does not disable native compaction.

<details>
<summary><strong>Defaults and advanced controls</strong></summary>

The complete option reference is [dcp.schema.json](dcp.schema.json); implementation defaults remain in [lib/config.ts](lib/config.ts). This release does not change those defaults.

- Default compression is `range`; `message` remains experimental. Default permission mode is `allow`. On V2, configured `ask` is currently fail-closed rather than a native approval dialogue; it is not treated as allow.
- Default lower/upper nudge thresholds are **50,000 / 100,000**; nudge frequency is **5**, iteration threshold **15**, and nudge force `soft`.
- `summaryBuffer` defaults to `true`: active summary tokens can extend the soft maximum threshold. `modelSummaryBuffer`, `modelMinLimits` and `modelMaxLimits` provide per-provider/model overrides. None enlarges the actual model window or guarantees a safe request size.
- Use `compress.protectedTools`, `protectedFilePatterns`, optional `protectTags` and `protectUserMessages` to control retained material. Built-in protected-tool handling is inherited from DCP. Do not remove protection merely to make a rewrite succeed.
- Manual-mode `automaticStrategies` defaults to `true`. Deduplication and purge-errors strategies default to enabled; purge-errors uses four turns. Notifications, turn protection and command controls retain their existing options.
- `experimental.customPrompts` defaults to `false`. When enabled, the existing `dcp-prompts` defaults/overrides support `system`, `compress-range`, `compress-message`, `context-limit-nudge`, `turn-nudge` and `iteration-nudge`. Keep host ID, placeholder, protection and fidelity instructions intact when customising them.

</details>

### Everyday controls

- `/dcp` opens the panel with context/statistics and manual-mode controls.
- `/dcp-compress [focus]` asks the model to run a compression pass, optionally focused on named work.
- Existing decompression/recompression controls are retained where the host exposes them. `/dcp recompress` reapplies user-decompressed summaries; it is **not** the guarded summary-rewrite operation.

Explicit rewrites are a **V2 range-mode** feature. Every entry must set `rewrite: true` and select the same active, primary-view-visible block at both boundaries. V1 and message mode reject the field, including `false`. Ordinary range mode continues to use nested-summary placeholders.

## Limits worth understanding

- **Summaries can lose meaning.** Byte-level protected evidence checks do not prove that a model's surrounding prose is complete or correct. Review important decisions and keep independent backups.
- **Fail-closed does not mean permanent archival storage.** Legacy blocks or incomplete child evidence can be ineligible for rewrite. Current context is not an archive; native compaction can retire blocks. Decompression only restores originals/lineage that remain available.
- **No universal savings promise.** DCP-style pruning changes prompt prefixes and may reduce cache hits. Counting uses the Anthropic tokenizer, not a guarantee of every provider's prompt accounting or bill. Low-yield advice is observational, not a causal benchmark.
- **Counting is bounded, not instantaneous.** A count fails on its deadline rather than estimating. Interrupted work can still occupy a child until it completes or hits its deadline; counts cannot make an oversized request universally safe.
- **Host features remain separate.** Custom request-budget enforcement, controller state, peer-inbox/FYI routing, independent build-session orchestration, reviewer routing and native steering changes are not bundled, required or auto-enabled by KCP. The public plugin does not need a custom Core fork.
- **Compatibility is scoped.** The release engine was checked on Linux x64 with stock OpenCode **2.1.4 / embedded Bun1.4.4**, plus Node24.22.0/npm11.19.1 package checks. Both V1/V2 adapters remain, but a new full V1 host/platform matrix is not claimed. Older V1 hosts using an older Zod converter may omit threshold bounds/descriptions from model hints; actual validation remains in place, and the qualified stock2.1.4 converter is unaffected.

## Verification and development

The accepted engine baseline passed **417 source tests + 8 logger tests**, type/capability checks, real archive/privacy checks, fresh plain-Node imports and exact tokenizer cases under Node and stock Bun. Actual stock V2 qualification covered ordinary compression → shrinking rewrite → outgoing argument elision while native history stayed unchanged; native RPC/permission controls and a real PTY panel/manual toggle were checked separately. Release documentation/version changes carry that engine evidence only while code and dependency bytes are unchanged.

The runtime consumer audit was **zero findings** at qualification. The complete development graph had **12 moderate findings and zero high/critical**; that is not a promise of permanent audit-zero status. The high-severity audit gate remains enabled.

```bash
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
npm run format:check
npm run verify:package
npm pack --ignore-scripts
```

Build explicitly before packing; `prepublishOnly` does not run for `npm pack`. Genuine SDK/renderer/Solid type inputs are development/host dependencies, not the runtime closure. Public declarations are not self-contained: type consumers need appropriate real platform SDK contracts. Source-only dependency overrides do not propagate to consumers or make an arbitrary old SDK graph secure.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the existing development/sandbox workflow. Prepared GitHub validation covers clean installation, types/build/tests/format, package privacy and fresh consumer/counter/audit checks. Actual stock/TUI acceptance is a documented local isolated gate; hosted user-bus/cgroup/network-namespace support and remote CI execution are not assumed. No publishing workflow is included.

## Credits and licence

**DCP made this possible.** Thank you to **tarquinen and every DCP contributor** for the original project, plugin architecture, compression workflow, protection mechanisms and shared code that KCP extends. Please visit [DCP](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning); its [upstream Ko-fi page](https://ko-fi.com/dansmolsky) supports the upstream author, not KCP fundraising or an implied affiliation.

**ACP deserves a substantial hat tip too.** Thank you to **ranxianglei and ACP's contributors** for exploring model-driven active context management, hierarchical summarisation and recoverable context workflows. See [Active Context Pruning](https://github.com/ranxianglei/opencode-acp) and its separately documented [V2 successor](https://github.com/ranxianglei/billion-context). KCP does not claim their results, their entire feature set or their endorsement.

Thanks also to the OpenCode, OpenTUI, Solid, Zod and tokenizer communities whose work provides the host and supporting libraries.

KCP is distributed under **[AGPL-3.0-or-later](LICENSE)** with original authorship/notices retained. See the source and dependency licences for their respective terms. Questions and reproducible issues belong in [kernel-oops/opencode-kcp](https://github.com/kernel-oops/opencode-kcp/issues).
