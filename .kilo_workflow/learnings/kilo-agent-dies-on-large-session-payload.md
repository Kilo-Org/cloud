# kilo role agent dies silently when its session payload exceeds the pruning limit

Symptom: a dispatched `kilo run` role agent (observed with an E2E verifier) exits mid-task with no error and no final report; its transcript just stops, often right after a large tool output.

Cause: the agent's session payload grows past the pruning limit (`opencode.log` shows `payload still large after pruning ... size=3042931` at the kill time) and the harness terminates the run. E2E agents inflate the payload fast: full UI-hierarchy dumps (~80 KB), full service-pane captures with QR art, repeated echo of the same long command output, screenshots read into context.

Fix: enforce output discipline in the handoff (and it is baked into the `e2e-verifier` definition): every shell command ends in a hard cap (`| tail -c 1500` / `| tail -5`), hierarchies and captures go to files and only greps or counts are printed, screenshots are not re-read into context, docs are inlined in the handoff instead of re-read, and the final report has a line cap. Dispatches with these rules survive; dispatches without them died at 4–10 minutes.
