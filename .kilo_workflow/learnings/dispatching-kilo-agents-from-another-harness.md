# Dispatching kilo role agents from a non-kilo harness (timeouts, exit codes, wait loops)

Symptom: a `kilo run --agent <role>` dispatched from a harness whose shell tool has a command timeout (Claude Code: 10 minutes) gets killed mid-run. Worse, a piped run (`kilo run ... | tee log`) records the exit status of `tee`, not of kilo, so a crashed agent reports `EXITCODE=0` and reads as a clean pass. Separately, an `until grep -q EXITCODE= "$LOG"` wait loop can false-trigger mid-run when the agent read a document (this one included) that mentions the marker, echoing it into the log.

Cause: three independent traps — the harness command timeout, `$?` after a pipeline referring to the last stage, and a wait marker that is not unique to the wrapper's final append.

Fix: run the dispatch inside a tmux window, redirect rather than pipe, and append the exit code after the redirected command:

```bash
cd "$WORKTREE"
env $(env | grep -oE '^(KILO|OPENCODE)[A-Za-z0-9_]*' | sed 's/^/-u /') \
  kilo run "Review the attached plan per your role definition." \
  --agent plan-reviewer --file msg.txt --file "$PLAN" > "$LOG" 2>&1
echo "EXITCODE=$?" >> "$LOG"
```

The message stays a short literal; the handoff and plan travel via `--file` — see `kilo-run-shell-substitution-executes-backticks.md` for why `"$(cat ...)"` is forbidden.

Do not pass `--model`/`--variant` for role agents — their definitions in `.kilo/agent/` pin the model, and a flag that drifts from the definition silently disagrees with it.

Keep the message positional **before** the flags: `--file` takes multiple values and swallows a trailing message as a path (`File not found`). Treat the run as done only when the tmux window is gone **or** the marker is the last line: `tail -1 "$LOG" | grep -q '^EXITCODE=[0-9]'`.
