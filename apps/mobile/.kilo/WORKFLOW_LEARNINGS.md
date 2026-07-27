# Workflow Learnings

Environment blockers and their fixes, recorded by the planner or orchestrator for the role that hit them. The full contract — when to read, when to write, entry shape, deduplication — is in [MOBILE_WORKFLOW.md](MOBILE_WORKFLOW.md).

## Planner

### Role-agent round exits 0 with no verdict (kilo stream stall)

Symptom: a dispatched role agent's `kilo run` exits with `EXITCODE=0` after some tool calls, but
the log ends mid-sentence with no findings list and no `No findings.` A bare exit code reads as
success, so the round silently counts as a pass.

Cause: kilo/grok stream stall — the CLI ends the session without emitting the final assistant
message. Unrelated to the agent definition or to permission denials.

Fix: treat "exit 0 without the required verdict string" as a void round, discard it, and
re-dispatch a fresh session. Detect it by grepping the log for the verdict, never by exit code
alone. Monitor the log for byte-size stagnation as well as for process exit, so a stall is
distinguishable from work in progress.

### Reviewer wastes steps on auto-rejected `.env` reads

Symptom: a reviewer logs `permission requested: read (apps/mobile/.env); auto-rejecting` and burns
steps retrying env files it can never read.

Cause: the role definitions' secrets rule correctly blocks `.env` reads, but a handoff that cites
`.env` facts invites the attempt.

Fix: state every sanitized env value inline in the handoff and tell the agent explicitly that it
is not permitted to read `.env` / `.env.local.example` and should treat the handoff table as
authoritative.

### `kilo run --interactive` dies when stdout is piped

Symptom: launching the orchestrator as `kilo run ... --interactive ... | tee log` exits immediately
with `Error: --interactive requires a TTY stdout`.

Cause: piping stdout replaces the TTY that `--interactive` requires. Affects any attempt to tee an
interactive kilo session's output to a file.

Fix: launch the interactive session as the tmux window command with no pipe, then attach logging
separately with `tmux pipe-pane -t <session>:<window> -o "cat >> <logfile>"`. Read live state with
`tmux capture-pane -p -t <session>:<window>`. Non-interactive role-agent dispatches are unaffected and
can still be teed.

### Dispatching role agents from a non-kilo harness (tmux, exit codes, void rounds)

**Symptom.** A `kilo run --agent <role>` dispatched from a harness whose Bash tool has a 10-minute timeout gets killed mid-review. Worse, a run that is piped (`kilo run ... | tee log`) records the exit status of `tee`, not of kilo, so a crashed agent reports `EXITCODE=0` and reads as a clean pass.

**Cause.** Two independent traps: the harness command timeout, and `$?` after a pipeline referring to the last stage.

**Fix.** Run the agent inside a tmux window from a small wrapper script, redirect rather than pipe, and append the exit code of the redirected command:

```bash
cd "$WORKTREE/apps/mobile"   # .kilo/agent/ must be discoverable from the cwd
kilo run "$(cat msg.txt)" --model kilo/x-ai/grok-4.5 --variant high \
  --agent mobile-plan-reviewer --file "$PLAN" > "$LOG" 2>&1
echo "EXITCODE=$?" >> "$LOG"
```

Then wait event-driven with an `until grep -q EXITCODE= "$LOG"` loop that also breaks when the tmux session disappears. Keep the message positional **before** the flags: `--file` takes multiple values and swallows a trailing message as a path.

### A kilo role agent can exit mid-run with no verdict — treat it as a void round

**Symptom.** The agent's log ends on an ordinary progress line ("Checking how decider scores are assigned…"), the tmux window is gone, and no findings list was ever printed. With a piped exit code this is indistinguishable from a pass.

**Cause.** Long kilo runs die on provider stream stalls, typically 10–15 minutes in. Nothing about the plan or the repository is wrong.

**Fix.** A round that produced no explicit verdict line is **void, never a pass**. Re-dispatch a fresh agent — the review gate wants a fresh session per round anyway, so nothing is lost. Detect it by requiring the verdict text itself (`No findings.` or a numbered list), not by exit code. If several consecutive rounds die at the same point, shrink the handoff rather than retrying unchanged.

## Orchestrator

### Waiting on the EXITCODE marker false-triggers mid-run

**Symptom.** An `until grep -q EXITCODE= "$LOG"` wait loop (Planner section, first entry) reports the role agent finished while it is still running: the string `EXITCODE=` already appears in the log because the agent read `WORKFLOW_LEARNINGS.md` or a handoff that documents the pattern, and the TUI echoes it into the capture.

**Cause.** The wait pattern greps for a marker that is no longer unique to the wrapper's final append.

**Fix.** Treat the run as done only when the tmux session is gone **or** the marker is the last line of the log (`tail -1 "$LOG" | grep -q '^EXITCODE=[0-9]'`). The plain `grep -q EXITCODE=` form is only safe if neither the handoff nor anything the agent is likely to read mentions the pattern — which this file does, so prefer the last-line check.

### Reading Kilobot's no-findings state (post #4765)

**Symptom.** The completion gate wants "Kilobot has reviewed the latest head", but the review no longer arrives as inline threads: with the bot skip/permit config (#4765) on main, a clean review produces a green `Kilo Code Review` check plus exactly one issue comment from `kilo-code-bot[bot]` headed `Status: No Issues Found | Recommendation: Merge`.

**Fix.** That combination — green check on the current head, the no-issues summary comment, zero review threads (`gh api repos/.../pulls/<n>/comments` empty) — *is* the reviewed-with-no-findings state. There is nothing to reply to or resolve; the gate is met. A `BLOCKED`/`REVIEW_REQUIRED` merge state at that point only means the requested human review is pending.
