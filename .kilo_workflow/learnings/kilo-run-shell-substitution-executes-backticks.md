# Inlining a handoff with "$(cat file)" executes backticks in the file

Symptom: a role agent dispatched with `kilo run "$(cat handoff.md)" ...` misbehaves — parts of the prompt are missing or garbled, or shell commands you never wrote have run. Handoffs are markdown and routinely contain backticks.

Cause: the dispatch usually travels through a second shell parse — a tmux window command string, an `sh -c`, a wrapper script. The outer shell expands `$(cat handoff.md)` and splices the file's raw content into the command string; the inner shell then re-parses that string, and backticks (and `$(...)`) inside the handoff execute as commands. A direct, single-parse invocation is safe, but the tmux-based dispatch pattern is not.

Fix: never inline file content into the message. The `kilo run` message is a short literal instruction; handoffs, plans, and diffs travel via `--file <path>` (repeatable, message positional before the flags).
