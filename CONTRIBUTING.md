# Contributing to KCP

Thank you for helping improve KCP. This project is derived from Dynamic Context
Pruning (DCP); preserve upstream authorship, copyright and licence notices, and
keep the compatibility names described in [README.md](README.md).

## Licence and contributions

KCP is **AGPL-3.0-or-later**. Contributions to KCP are made under the same
project licence. Keep applicable copyright and attribution notices with the
work. KCP does not require an additional CLA or a separate grant of proprietary
relicensing rights.

This contribution policy does not relicense upstream work, alter [LICENSE](LICENSE),
remove existing notices, or change historical agreements.

## Development setup

The qualified source toolchain is Node **24.22.0** and npm **11.19.1**:

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
npm run format:check
npm run verify:package
npm audit --audit-level=high
```

Peer resolution is ordinary. Lifecycle scripts are deliberately disabled;
build explicitly rather than enabling every dependency's postinstall hook.
Build before tests so emitted-entry checks cannot silently skip. The logger is
a development workspace, not a runtime dependency.

Use a feature branch, add a focused regression for non-trivial changes, and
explain behaviour and compatibility impact in your pull request. Prefer the
smallest complete change over a new framework or speculative option.

## Package and compatibility boundaries

- Keep the real server exports (`.` and `./server`), directory `server.js`,
  source-loaded `./tui`, generated declarations and tokenizer sidecars intact.
- Keep public SDK contracts for type checking. Do not replace them with ambient
  shims, weakened types, legacy-peer flags or copied dependency trees.
- Source overrides do not propagate into tarball consumers. Test the actual
  packed archive with a fresh ordinary consumer and run its production audit.
- Preserve protected evidence, atomicity, native history and permission checks.
  Do not remove a safety assertion just to make a rewrite or test pass.
- Retain V1 and V2 adapters. A source/schema/type control is not proof of a real
  V1 host run; likewise, a mocked V2 context is not stock-host/TUI qualification.

The source CI command uses the existing JSONC source-test loader. Actual built
consumer imports must work in plain Node without it. Use the existing
`DCP_PACKAGE_ENTRY` fixtures for installed-entry rewrite/protection checks and
`scripts/consumer-smoke.mjs` for the installed closure and exact sidecar controls.
That smoke script takes the absolute directory of an already installed fresh
consumer; Node runs it with the source checkout's `--import tsx` test tooling.

Actual stock OpenCode **2.1.4 / Bun1.4.4** server and PTY qualification is a
separate local gate. Use disposable state, a clean environment, loopback-only
network isolation and a separate user cgroup capped at 4 GiB RAM, no swap and
300 seconds, with bounded process cleanup. Do not use production credentials,
configuration or session databases. Do not assume hosted runners provide the
same user-bus/cgroup/network-namespace facilities.

## Local development loading

For ordinary installation, follow the verified release-asset route in
[README.md](README.md). For development only, build first and merge the
checkout's **absolute directory** into the V2 server `opencode.jsonc`:

```jsonc
{
    "$schema": "https://opencode.ai/config.json",
    "plugins": ["/absolute/path/to/opencode-kcp"],
}
```

The CLI has a **separate global** `cli.json`, not a project-local CLI file:

```jsonc
{
    "$schema": "https://opencode.ai/v2/cli.json",
    "plugins": ["/absolute/path/on/this/client/to/opencode-kcp"],
}
```

These examples do not grant permissions or remove unrelated settings. Back up
existing configuration/state and ensure old declared or automatically discovered
context engines are not also loaded. A remote server path is not automatically
a valid path on a client machine.

## Optional inherited sandbox and lab tooling

The repository retains upstream development tools; they are **not the basic
installation route** and were not run as part of the release-preparation checks.
Read their source/options before opting in:

- [scripts/sandbox.mjs](scripts/sandbox.mjs) and the [logger workspace](tests/logger/)
  provide the inherited Docker sandbox. The sandbox can copy saved authentication
  into its isolated profile and can call providers. That credential-copying
  behaviour is optional advanced tooling, not a KCP installation requirement.
  Its `--dcp VERSION` option selects **upstream DCP's npm package**, not a KCP
  GitHub release. Legacy `--v1` sandbox configuration must not be copied into a
  V2 server or global CLI config.
- [scripts/lab.mjs](scripts/lab.mjs), [tests/lab/Dockerfile](tests/lab/Dockerfile)
  and [tests/lab/ui.py](tests/lab/ui.py) retain the upstream integration lab.
  Choose a durable disposable `DCP_LAB_DIR` before large captures. Live/auth-copy
  scenarios need their own explicit authorisation; do not infer it from running
  local unit tests. Lab defaults and a newer host download are not evidence that
  this KCP release has qualified every host version or transport.

No release requires disabling native compaction, modifying Core, copying ACP
state or deleting an old engine's history. GitHub validation is read-only test
automation; this repository has no npm publishing workflow.
