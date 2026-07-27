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

## Orchestrator
