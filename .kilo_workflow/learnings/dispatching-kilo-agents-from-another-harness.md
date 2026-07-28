# Dispatching kilo role agents from a non-kilo harness (timeouts, exit codes, wait loops)

Symptom: a `kilo run --agent <role>` dispatched from a harness whose shell tool has a command timeout (Claude Code: 10 minutes) gets killed mid-run. Worse, a piped run (`kilo run ... | tee log`) records the exit status of `tee`, not of kilo, so a crashed agent reports `EXITCODE=0` and reads as a clean pass. Separately, an `until grep -q EXITCODE= "$LOG"` wait loop can false-trigger mid-run when the agent read a document (this one included) that mentions the marker, echoing it into the log.

Cause: three independent traps — the harness command timeout, `$?` after a pipeline referring to the last stage, and a wait marker that is not unique to the wrapper's final append.

Fix: run the dispatch inside a tmux window, redirect rather than pipe, and append the exit code after the redirected command:

```bash
cd "$WORKTREE"
kilo run "$(cat msg.txt)" --model kilo/x-ai/grok-4.5 --variant high \
  --agent plan-reviewer --file "$PLAN" > "$LOG" 2>&1
echo "EXITCODE=$?" >> "$LOG"
```

Keep the message positional **before** the flags: `--file` takes multiple values and swallows a trailing message as a path (`File not found`). Treat the run as done only when the tmux window is gone **or** the marker is the last line: `tail -1 "$LOG" | grep -q '^EXITCODE=[0-9]'`.
