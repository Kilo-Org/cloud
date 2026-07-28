# kilo run exits 0 without a verdict — void round, never a pass

Symptom: a dispatched role agent's `kilo run` exits with `EXITCODE=0` after some tool calls, but the log ends mid-sentence — often on an ordinary progress line — with no findings list and no `No findings.` The tmux window is gone and a bare exit code reads as success, so the round silently counts as a pass.

Cause: kilo provider stream stall — long runs die 10–15 minutes in and the CLI ends the session without emitting the final assistant message. Unrelated to the agent definition, the plan, or permission denials.

Fix: a round that produced no explicit verdict line is void, never a pass. Detect completion by requiring the role's sentinel line itself (reviewers: `No findings.`, a findings list, or `STOPPED EARLY.`; implementer: `SLICE COMPLETE.`/`STOPPED EARLY.`; verifier: `VERIFICATION PASSED./FAILED./BLOCKED.`, `REPRODUCED.`, `CANNOT REPRODUCE.`, or `STOPPED EARLY.`), never by exit code alone. Discard the void round and dispatch a fresh session — review gates want a fresh session per round anyway. Monitor the log for byte-size stagnation as well as process exit so a stall is distinguishable from work in progress. If several consecutive rounds die at the same point, shrink the handoff rather than retrying unchanged.
