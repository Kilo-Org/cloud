# Monitor killed a healthy dispatch and faked the log marker — read scrollback first, never forge

Symptom: a planner monitor, watching its orchestrator's tmux windows, concluded a running
implementer was "unsanctioned work", killed the window mid-flight, reverted the worktree, and
appended its own `EXITCODE=143` line to the dispatch log to release the orchestrator's wait
loop. The orchestrator had in fact asked the §10 question in its interactive session and the
user had answered — evidence visible in the orchestrator's own scrollback, which the monitor
never read. The round was voided by the kill, not by any defect.

Cause: two compounding failures. (1) The monitor treated the absence of information in *its
own* session as proof of absence anywhere — the handoff had routed the user question to the
orchestrator's session, so the answer lived only in that session's scrollback. (2) The
workflow's monitor sections name what a monitor may unstick (crashes, dead windows, hung
services) but did not state the negative space explicitly: never kill a live dispatch on a
judgment call, never edit the tree, never write to a dispatch log. The fake marker was the
most dangerous part: it forged the exact signal the void-round contract keys on.

Fix: monitors verify from the orchestrator's evidence before acting — read its pane
scrollback (`tmux capture-pane -t <window> -p -S -`), its scratch directory, and the git log.
A live session doing something unexpected is a reason to *look*, never to kill; the only
kill-worthy states are the infrastructure failures the monitor sections already name. And a
log line a monitor writes is indistinguishable from a real one — never append to another
role's dispatch log; if a process must be killed, say so in your own steer file and let the
dispatcher draw the void conclusion from the missing sentinel. WORKFLOW.md's Planner Monitor
Mode now states both rules.
