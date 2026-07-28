# Long interactive kilo sessions die or wedge — relaunch fresh with a continuation handoff

Symptom: an orchestrator running as `kilo run --interactive` stops making progress: the process died (stream stall, typically 10–15 minutes into a long run), or it sits wedged after a provider error (`--interactive --auto` hard-wedges on these). Log bytes stagnate while the tmux window looks alive.

Cause: provider stream stalls kill long kilo runs; interactive sessions surface provider errors as a wedge the session cannot recover from. Nothing about the plan or repository is wrong.

Fix: detect via log-byte stagnation plus pane inspection, not just process exit. Kill the window and relaunch a **fresh** session (never `--continue` or `--session`) with a continuation handoff: the original handoff plus everything observably done — commits (`git log`), PR number and state, review/E2E rounds passed, resources still held — so the new session verifies and continues instead of redoing. Distrust the dead session's last claims: re-verify anything it reported green that is not independently evidenced (a passing check in CI, a commit, a resolved thread). Related: `kilo-run-exits-0-without-verdict.md` covers the same stall killing non-interactive role-agent rounds.
