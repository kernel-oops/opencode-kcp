# Contributing to KCP

Thank you for helping improve KCP. It is built from Dynamic Context Pruning
(DCP). Keep the original authors' names, copyright and licence notices, and the
compatibility names explained in [README.md](README.md).

## Licence and contributions

KCP is **AGPL-3.0-or-later**. Contributions to KCP are made under the same
project licence. Keep applicable copyright and attribution notices with the
work. KCP does not require an additional CLA or a separate grant of proprietary
relicensing rights.

This contribution policy does not relicense upstream work, alter [LICENSE](LICENSE),
remove existing notices, or change historical agreements.

## Development setup

Development checks used Node **24.22.0** and npm **11.19.1**:

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
npm run format:check
npm run verify:package
npm audit --audit-level=high
```

Let npm check package versions normally; do not use flags that ignore conflicting
requirements. `--ignore-scripts` deliberately disables packages' installation
scripts. Run the build yourself. Build before tests so checks of the generated
files do not silently skip. The logger is for development and is not installed
as part of the package people run.

Use a feature branch and add a small test for a behaviour change. Explain what
changes for users and what might stop working. Prefer the smallest complete fix
over a new framework or an option nobody needs yet.

## What must keep working

- Keep both server imports (`.` and `./server`) and the directory's `server.js`.
  Keep `./tui`, which OpenCode loads to draw the terminal panel, the generated
  TypeScript declarations, and the separate token-counting scripts.
- Use the real public SDK type definitions that describe OpenCode's API. Do not
  replace missing types with invented declarations, weaken checks, ignore npm
  version conflicts or copy someone else's installed dependencies.
- Dependency overrides in this checkout do not apply to people installing its
  `.tgz`. Install the actual package in a new test directory with normal npm
  rules, then audit the packages that would run there.
- Preserve protected text, saved conversation records and permissions. A failed
  rewrite must apply none of that proposed batch, not half of it. Do not remove
  an assertion just to make a rewrite or test pass.
- Keep the V1 and V2 integrations. A type/schema test is not a real V1 host test;
  an imitation V2 context is not a test with the real OpenCode server or panel.

Source tests use a special loader to work around the JSONC parser's source-import
problem. The built package must load in plain Node without that loader. Existing
`DCP_PACKAGE_ENTRY` tests check rewriting and protection using an installed copy.
`scripts/consumer-smoke.mjs` checks its installed dependencies and token-counting
scripts. Give it the full path to a new test directory where the package is
already installed; Node runs it with this checkout's `--import tsx` test tooling.

Tests with standard OpenCode **2.1.4 / Bun 1.4.4** and a real terminal panel are
separate local checks. A PTY is a simulated terminal that lets the real terminal
client run and receive input. Use throwaway state and a clean environment. Limit
the network to loopback and put the processes in their own user cgroup with
4 GiB RAM, no swap and a 300-second limit. Stop and reap them on failure. Do not
use production credentials, configuration or conversation databases. GitHub
runners may not provide the user bus, cgroup controls and network isolation these
local checks need; passing GitHub checks is not a substitute for them.

## Local development loading

For normal installation, follow the tested download instructions in
[README.md](README.md). For development only, build first and merge the
checkout's **full directory path** into the V2 server `opencode.jsonc`:

```jsonc
{
    "$schema": "https://opencode.ai/config.json",
    "plugins": ["/absolute/path/to/opencode-kcp"],
}
```

The terminal client (CLI) has a **separate global** `cli.json`, not a file inside
each project:

```jsonc
{
    "$schema": "https://opencode.ai/v2/cli.json",
    "plugins": ["/absolute/path/on/this/client/to/opencode-kcp"],
}
```

These examples do not grant permissions or replace unrelated settings. Back up
configuration/state and check that an old context engine is not also loaded,
including from an automatically discovered plugin directory. A remote server's
file path will not normally exist on the client machine.

## Optional sandbox and lab tools from DCP

The repository keeps DCP's development tools. They are **not needed to install
KCP** and were not run as part of the release-preparation checks. Read their
source and options before choosing to run them:

- [scripts/sandbox.mjs](scripts/sandbox.mjs) and the [logger workspace](tests/logger/)
  provide a Docker sandbox. It can copy saved sign-in details into its separate
  profile and make AI provider calls. This is optional advanced tooling, not a
  KCP installation requirement or permission to use your saved credentials.
  Its `--dcp VERSION` option selects **upstream DCP's npm package**, not a KCP
  GitHub release. Old `--v1` sandbox configuration must not be copied into a
  V2 server or global CLI config.
- [scripts/lab.mjs](scripts/lab.mjs), [tests/lab/Dockerfile](tests/lab/Dockerfile)
  and [tests/lab/ui.py](tests/lab/ui.py) keep DCP's integration lab.
  Set `DCP_LAB_DIR` to a throwaway directory on disk before recording large logs.
  Live calls and copying sign-in details need separate permission; permission to
  run unit tests does not cover them. Downloading a newer OpenCode version for a
  lab run does not mean this release was tested with every version or transport.

No release requires disabling OpenCode's own compaction, modifying Core, copying ACP
state or deleting an old engine's history. GitHub validation is read-only test
automation; this repository has no npm publishing workflow.
