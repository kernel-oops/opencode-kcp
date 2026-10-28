# KCP for OpenCode

KCP helps OpenCode manage long conversations. It lets the AI replace finished parts of a chat with shorter summaries, so there is less old material to read each time.

**KCP does not delete the original records from your saved OpenCode conversation.** OpenCode's own compaction can separately remove older material from the context it makes available, so this is not a promise that everything can always be recovered.

KCP works with standard OpenCode **2.1.4**. You do not need a special OpenCode build.

**Release: 0.1.1 · [AGPL-3.0-or-later](LICENSE) · [Releases](https://github.com/kernel-oops/opencode-kcp/releases)**

> **A very large thank-you to DCP and ACP.** KCP is built from [Dynamic Context Pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning), created by **tarquinen and its contributors**. Much of the code, design and everyday functionality is their work. [Active Context Pruning](https://github.com/ranxianglei/opencode-acp), by **ranxianglei and contributors**, also helped shape our thinking about letting the AI manage long conversations. KCP's code starts with DCP; we credit ACP for its ideas and our experience using it, not as a claim that we copied its implementation. Original notices and the AGPL licence are retained.

[Install](#quick-start) · [What's included](#whats-included) · [DCP, ACP and KCP](#dcp-acp-and-kcp) · [Configuration](#configuration) · [Limits](#limits-worth-understanding) · [Credits](#credits-and-licence)

## What's included

### The DCP foundation

DCP already lets the AI choose finished work to summarise. KCP keeps its range mode, which summarises a stretch of conversation, and its experimental message mode, which selects individual messages. It also keeps DCP's summaries within summaries, protection for selected tool results/files, cleanup of repeated calls and old error inputs, manual controls and settings. **These features come from DCP**, not from KCP inventing them again.

### What KCP adds

- **Shorten an older summary when it is safe to do so.** In OpenCode V2 range mode, the AI can ask to replace an existing summary with a smaller one. KCP refuses if it cannot check the original text and required protections, or if the replacement is not smaller.
- **Keep verified protected results.** Text that must be kept, including verified results from helper agents, stays unchanged in a rewritten summary. A newer result or a cached copy cannot replace missing original evidence.
- **Apply the whole rewrite or none of it.** If any entry in a proposed rewrite batch fails its checks, KCP does not partly save that batch.
- **Ask for summaries that help work continue.** The instructions stress what the user wants now, decisions and permissions, who owns unfinished work, outstanding problems and the evidence needed next—not a diary of every step.
- **Avoid sending the same summary twice.** Once a completed compression's summary is accounted for in the current summaries or a clearly tracked replacement, KCP can omit its repeated submitted text from the copy sent to the AI. The saved original tool arguments stay unchanged. If KCP cannot verify that connection, it keeps the original input.
- **Count without freezing OpenCode.** Tokens are the small pieces of text an AI processes. KCP runs the Anthropic token counter in a separate process with time and queue limits. If it cannot finish a count, it reports an error rather than guessing.
- **Optionally point out a small reduction.** After an ordinary V2 range compression, KCP can compare OpenCode's prompt-usage counts with the immediately next completed response, only when the agent/model/settings match. It skips missing or changed data rather than looking further ahead. This can produce one reminder, makes no extra AI request, and is not a controlled test of billing savings.

The download has separate server and terminal-panel parts and a small set of patched libraries needed to run it. It works with the standard OpenCode version tested above, not just a custom build.

The public download is the **same full-featured KCP package intended for our own use**. There is no enhanced private KCP engine or reduced public edition. Separate custom OpenCode features are not part of this plugin.

## DCP, ACP and KCP

These projects share code or ideas. This table explains their approaches; it does **not rank their speed or savings**.

| Project                                                                     | Approach                                                                                                                                                         | OpenCode support described here                                                                                                                                              |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [DCP](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)     | Lets the AI choose what to summarise, with automatic cleanup, protected content and manual controls. KCP starts from this code.                                  | Shared code for V1/V2, with separate server and terminal-panel parts.                                                                                                        |
| [ACP — Active Context Pruning](https://github.com/ranxianglei/opencode-acp) | Adds tools to summarise, restore and search older content. Its T1/T2/T3 stages repeatedly shorten summaries; a last-resort cleanup runs when the window is full. | Its README supports **V1**, not V2, and recommends [billion-context](https://github.com/ranxianglei/billion-context) for V2. ACP is not being described as abandoned.        |
| **KCP**                                                                     | Builds on DCP with the summary-rewrite checks and other changes above.                                                                                           | Keeps V1/V2 code; the real server and terminal panel were checked with standard **2.1.4**. This is not a claim to support every version or an unlimited conversation window. |

Comparison checked **26 October 2026** against DCP **3.2.0** ([source](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning/tree/f8232fde1e63c2251687e4d9634bd53ce11568cb)) and ACP **1.18.5** ([README](https://github.com/ranxianglei/opencode-acp/blob/98a16d5b43f640abc2e2eac7903553786baaf37b/README.md)). Both projects may evolve; consult their current documentation. Their benchmarks, papers and marketing claims are not KCP benchmarks or guarantees.

The AI gets **one KCP tool: `compress`**. KCP does **not** include ACP's separate
`decompress`, `search_context` or `acp_status` AI tools, its T1/T2/T3 system or
its full-window cleanup (GC) fallback. KCP keeps user controls for restoring and
reapplying summaries where supported, but these are not ACP's complete toolset.
The same public/own KCP package does not mean every historical ACP feature is included.

## Quick start

Use the **ready-to-install download from GitHub Releases**. Do not install an npm package name or a Git source URL in its place: the download includes the built files OpenCode needs. The package keeps `private: true` to prevent accidental publication to npm; local installation of the downloaded `.tgz` still works.

### 1. Download, verify and install

The following Linux shell example installs **v0.1.1** under your home directory. It stops if a download, checksum or installation fails, without changing your terminal's settings. It does not edit your OpenCode configuration.

```bash
(
    set -eu
    mkdir -p "$HOME/.cache/opencode-kcp/v0.1.1"
    cd "$HOME/.cache/opencode-kcp/v0.1.1"
    curl --fail --location --remote-name \
        https://github.com/kernel-oops/opencode-kcp/releases/download/v0.1.1/opencode-kcp-0.1.1.tgz
    curl --fail --location --remote-name \
        https://github.com/kernel-oops/opencode-kcp/releases/download/v0.1.1/SHA256SUMS
    sha256sum --check SHA256SUMS
    npm install --prefix "$HOME/.local/share/opencode-kcp" --ignore-scripts \
        "$PWD/opencode-kcp-0.1.1.tgz"
    printf '%s\n' "$HOME/.local/share/opencode-kcp/node_modules/opencode-kcp"
)
```

Keep the full directory path printed at the end. We tested installing the downloaded `.tgz` with npm and then loading that directory in OpenCode. We did not test OpenCode downloading KCP from a package registry. Tests used Node **24.22.0** and npm **11.19.1**. `--ignore-scripts` deliberately stops packages from running their installation scripts.

### 2. Configure the server

Back up your existing configuration and plugin state first. In the server's `opencode.jsonc`, merge KCP into the existing `plugins` array:

```jsonc
{
    "$schema": "https://opencode.ai/config.json",
    "plugins": ["/absolute/path/printed/above"],
}
```

Replace the example with the **actual installed directory**, not the archive or `dist/index.js`. Do not assume `~` or `$HOME` expands inside JSON strings. Preserve unrelated plugins and settings. For server/global/project configuration locations, see the [OpenCode plugin guide](https://opencode.ai/v2/docs/build/plugins).

### 3. Configure each terminal client separately

The terminal client is the OpenCode app you use in your terminal; its panel is sometimes called the TUI. To get KCP's panel and manual-mode controls, add the package directory installed on that client to its **global** `~/.config/opencode/cli.json` (or `$XDG_CONFIG_HOME/opencode/cli.json`):

```jsonc
{
    "$schema": "https://opencode.ai/v2/cli.json",
    "plugins": ["/absolute/path/on/this/client/to/node_modules/opencode-kcp"],
}
```

Server settings and terminal-client settings are separate. With a remote server, install the same download on each client that needs the panel. A server's file path will not normally exist on another machine. See [CLI settings](https://opencode.ai/v2/docs/cli/config). OpenCode loads the package's `./tui` part to draw the panel; running it directly in Node will not draw it.

**Run one context-management engine at a time.** Remove old DCP/ACP/KCP declarations from the relevant server and CLI plugin lists, and check automatically discovered plugin directories too. Back up and move an old engine outside discovery rather than deleting its state. A leftover auto-discovered copy can still load after its explicit configuration entry is removed.

### Updating or migrating

Download and check the release you want, then install that exact file in your chosen directory. Keep the server and clients on the intended version. **KCP does not automatically update itself.** The inherited updater does nothing for this package name; it will not silently replace KCP with DCP or look for an unpublished npm release.

Names such as `opencode-dcp`, `/dcp` and `dcp.jsonc`, the `dcp` RPC name used for server/client calls, and existing storage locations are kept for compatibility. They are not signs that you should also load the old engine. Back up configuration and state before switching. Do not blindly copy ACP state, delete old state, or expect KCP to recover material another engine or OpenCode's compaction has already discarded.

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

These numbers tell KCP **when to remind the AI to summarise**. The code calls these reminders "nudges". They do not put a hard limit on the final request. Choose values that leave room for the model's reply, tools and other material added to each request. KCP does not turn off OpenCode's own compaction, even in manual mode.

<details>
<summary><strong>Defaults and advanced controls</strong></summary>

The complete option reference is [dcp.schema.json](dcp.schema.json); implementation defaults remain in [lib/config.ts](lib/config.ts).

- Default compression is `range`; `message` remains experimental. Default permission mode is `allow`. On V2, `ask` currently refuses compression rather than opening an approval dialogue; it is not treated as permission to continue.
- Default lower/upper nudge thresholds are **50,000 / 100,000**; nudge frequency is **5**, iteration threshold **15**, and nudge force `strong`. Explicit `soft` remains available, but appends nudges to assistant messages and can increase copying of those nudges into replies.
- `summaryBuffer` defaults to `true`: tokens used by current summaries can extend the point at which KCP reminds the AI. `modelSummaryBuffer`, `modelMinLimits` and `modelMaxLimits` let you set this by provider/model. These settings do not enlarge the model's window or guarantee that a request fits.
- Use `compress.protectedTools`, `protectedFilePatterns`, optional `protectTags` and `protectUserMessages` to control retained material. Built-in protected-tool handling is inherited from DCP. Do not remove protection merely to make a rewrite succeed.
- Manual-mode `automaticStrategies` defaults to `true`. Deduplication and purge-errors strategies default to enabled; purge-errors uses four turns. Notifications, turn protection and command controls retain their existing options.
- `experimental.customPrompts` defaults to `false`. When enabled, the existing `dcp-prompts` defaults/overrides support `system`, `compress-range`, `compress-message`, `context-limit-nudge`, `turn-nudge` and `iteration-nudge`. Keep host ID, placeholder, protection and fidelity instructions intact when customising them.

</details>

### Everyday controls

- `/dcp` opens the panel with context/statistics and manual-mode controls.
- `/dcp-compress [focus]` asks the model to run a compression pass, optionally focused on named work.
- You can still restore earlier text and reapply summaries where OpenCode provides those controls. `/dcp recompress` reapplies summaries you previously expanded; it does **not** ask for a new, shorter summary.

Shortening an existing summary is a **V2 range-mode** feature. Each entry must set `rewrite: true` and name the same current summary at both ends. That summary must be visible in the current main conversation sent to the AI. Every entry in the batch must request a rewrite: mixing modes, uncertain originals, replacement placeholders or a result that is not strictly smaller makes KCP reject the whole batch. V1 and message mode reject the field, even `false`. Ordinary range compression still uses placeholders to include earlier summaries.

## Limits worth understanding

- **A summary can miss something important.** Checking that protected text is unchanged does not prove the AI's other words are complete or correct. Review important decisions and keep separate backups.
- **This is not a permanent archive.** KCP refuses a rewrite if it cannot verify the original/protected text, including older summaries with incomplete helper-result records. OpenCode's own compaction can stop making older material available. Restoring a summary only works while the needed originals and records still exist.
- **Smaller requests do not always mean lower bills.** Changing earlier text can reduce a provider's cache hits. KCP uses the Anthropic tokenizer, which need not match every provider's counting or billing. Its small-reduction advice is an observation, not proof of savings caused by KCP.
- **Counting takes time.** A slow count reports an error when its deadline is reached. After you interrupt work, its separate counting process may continue until it finishes or reaches that deadline. Counting does not by itself guarantee a request fits.
- **Copied markers can appear in replies.** The legacy V1 completed-text hook removes copied reminders and standalone trailing compact tags. The public V2 session hooks do not expose a completed-text editing hook, so KCP cannot clean V2 output or streaming text this way; it does not intercept transport streams or edit historical messages through APIs.
- **Other OpenCode features are separate.** KCP does not include custom hard request budgets, saved controller state, peer/FYI messages, management of separate build/review sessions, or changes for steering a running agent. It does not require or automatically enable them, and needs no custom Core build.
- **We tested specific versions, not every setup.** Checks covered Linux x64, standard OpenCode **2.1.4 / its Bun 1.4.4**, and Node **24.22.0**/npm **11.19.1**. V1 and V2 code remains, but that does not mean a fresh full V1 test or tests on all platforms. Older V1 hosts with an older Zod converter may leave bounds/descriptions out of the hints sent to the AI; actual input validation still runs, and the tested 2.1.4 converter is unaffected.

## Verification and development

The 0.1.0 release passed **417 source tests + 8 logger tests**, TypeScript checks, package/privacy checks, fresh Node loading and token-count checks in Node and standard OpenCode's Bun. Tests with the real OpenCode V2 server covered summarising work, shortening an older summary and removing repeated summary arguments from the copy sent to the AI, without changing saved conversation records. Server/client calls, permissions and a real terminal panel/manual switch were also checked. These historical results do not establish fresh real-host testing of 0.1.1.

Security checks of a normal installation reported **zero findings** when tested. Checks of all development dependencies reported **12 moderate findings and zero high/critical**. Reports can change as new problems are discovered; the checks still refuse high-severity findings rather than ignoring them.

```bash
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
npm run format:check
npm run verify:package
npm pack --ignore-scripts
```

Build before making a package: `npm pack` does not run `prepublishOnly`. Developers need the real OpenCode SDKs and panel libraries for TypeScript checking; these are not all installed with the ready-to-run download. The published TypeScript declarations also need the appropriate SDK definitions rather than standing alone. Dependency overrides in this source checkout do not apply to people installing the package. An old-SDK compatibility test setup is not shipped or recommended as a safe dependency setup merely because its type checks pass.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for development and the optional sandbox tools. GitHub's automated checks passed for the published v0.1.0 code: installation, types/build/tests/format, package privacy and fresh-install/counting/security checks. The real OpenCode server/panel tests were separate local tests, not run by GitHub. There is no automatic npm publishing workflow.

## Credits and licence

**0.1.1 change history:** Default nudge force is now `strong`; the V1 completed-text hook also cleans copied reminders and standalone trailing compact tags. Thanks to the DCP upstream issue reporters, including the reporter of [DCP #608](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning/issues/608), for reporting copied tags.

**DCP made this possible.** Thank you to **tarquinen and every DCP contributor** for the original project, design, compression tools, protection checks and code that KCP builds on. Please visit [DCP](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning); its [upstream Ko-fi page](https://ko-fi.com/dansmolsky) supports the upstream author, not KCP fundraising or a claim of affiliation.

**ACP deserves a substantial hat tip too.** Thank you to **ranxianglei and ACP's contributors** for exploring how the AI can manage a long conversation, shorten summaries in stages and restore older content. See [Active Context Pruning](https://github.com/ranxianglei/opencode-acp) and its separately documented [V2 successor](https://github.com/ranxianglei/billion-context). KCP does not claim their results, all their features or their endorsement.

Thanks also to the OpenCode, OpenTUI, Solid, Zod and tokenizer communities whose work provides the host and supporting libraries.

KCP is distributed under **[AGPL-3.0-or-later](LICENSE)** with original authorship/notices retained. See the source and dependency licences for their respective terms. Questions and reproducible issues belong in [kernel-oops/opencode-kcp](https://github.com/kernel-oops/opencode-kcp/issues).

KCP is based on AGPL-licensed DCP. We cannot simply choose a different licence for someone else's work without their permission. The licence text and copyright notices are unchanged; this explanation is not legal advice.
