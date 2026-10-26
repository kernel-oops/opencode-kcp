# KCP prompt preview

This developer tool prints the instructions and reminders KCP gives the AI. Use
it to check your wording without starting a chat or making an AI request. It is
part of the source checkout, not the package people install from a release.

The command is still called `dcp` for compatibility. After installing the source
checkout's development dependencies as described in the main README, run:

```bash
npm run dcp -- --help
```

## Options

| Option              | What it prints                                                       |
| ------------------- | -------------------------------------------------------------------- |
| `--help` or `-h`    | Help and examples.                                                   |
| `--list`            | The available instruction/reminder names.                            |
| `--show <key>`      | The text for one of the names below.                                 |
| `--system`          | General instructions, with no manual-mode or helper-agent additions. |
| `--system-manual`   | General instructions plus the manual-mode addition.                  |
| `--system-subagent` | General instructions plus the helper-agent addition.                 |
| `--system-all`      | General instructions with both additions.                            |

With no option, it prints the general instructions. The available keys for
`--show` are:

- `system`: the general instructions.
- `compress-range`: how to summarise a stretch of conversation.
- `compress-message`: how to summarise selected individual messages.
- `context-limit-nudge`: a reminder to summarise when the conversation gets large.
- `turn-nudge`: a reminder associated with conversation turns.
- `iteration-nudge`: a reminder after enough work since the last user message.

The script creates `PromptStore` with custom prompts disabled. It prints the
bundled defaults, not any custom overrides a running OpenCode session may use.
It does not change that session or test whether the AI will follow the instructions.

## Examples

```bash
npm run dcp -- --list
npm run dcp -- --show compress-range
npm run dcp -- --system-all
```

Older documentation listed `--nudge`, `--compress-nudge`, `--context-tools`,
`--compress-context` and `--cooldown`. Those are not implemented by the current
script. Use `--list` and `--show <key>` instead; no script behaviour has changed.
