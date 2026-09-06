# Claude Code — enforced

Nothing lives in this directory. The Claude Code integration is the plugin one
level up, at `plugin/`, and it is the only one of the four that the model cannot
forget to use.

```bash
claude plugin marketplace add Piyush-sahoo/spacetime-hacks
claude plugin install map-room@map-room
# restart Claude Code — hooks are read at session start
```

| Event | Script | Enforced by |
|---|---|---|
| `PostToolUse` on `Read\|Edit\|Write\|Grep\|Glob\|Bash` | `scripts/post_tool_use.py` | the harness |
| `UserPromptSubmit` | `scripts/user_prompt_submit.py` | the harness |
| `Stop` | `scripts/stop.py` | the harness |
| `SessionEnd` | `scripts/session_end.py` | the harness |
| `SubagentStop` | `scripts/subagent_stop.py` | the harness |

The hook is a command Claude Code itself runs after every matching tool call.
The model is not consulted and cannot opt out, which is what makes the coverage
number trustworthy: a file that is dark on the map was not read.

Docs: https://docs.claude.com/en/docs/claude-code/hooks

Full install notes, the binding rules and the failure modes are in
[`../README.md`](../../README.md).
