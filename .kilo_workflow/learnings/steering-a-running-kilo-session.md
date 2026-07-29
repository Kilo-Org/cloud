# Steering a running interactive kilo session — use steer.sh, and `N queued` is not a wedge

Symptom: a steering message sent to a running `kilo run --interactive` session (planner, orchestrator) never takes effect. Either the pane shows the text but nothing happens, or the footer sits at `N queued` for a long time and the session gets declared wedged and relaunched, losing in-flight work.

Three separate causes, all reproduced against kilo 7.4.16:

1. **A trailing `Enter` in the same `send-keys` call is swallowed by long messages.** `tmux send-keys -t <t> "$MSG" Enter` submitted a 240-character message fine, but a 2.6k one landed in the composer **unsent** — kilo's composer reads a large chunk as a paste and the Enter becomes part of it. A separate `tmux send-keys -t <t> Enter` afterwards submits it.
2. **An unbracketed paste submits at every newline.** `tmux paste-buffer` of a three-line message produced **three** prompts (queue `0 → 3`), so the first fragment ran as its own turn before the rest arrived. `paste-buffer -p` (bracketed) delivered the same text as one prompt (queue `0 → 1`).
3. **`N queued` means delivered, not stuck.** Queued prompts drain one per turn boundary, in order — verified draining `4 queued` once a long bash turn ended. They do not drain between tool calls, so a session chaining tool calls holds the queue for as long as that takes, and `Escape` does not flush it.

Fix: steer with `.kilo_workflow/steer.sh <tmux-target> <message|->`. It sends Enter separately, uses bracketed paste, refuses panes not running the kilo CLI (a mistargeted steer otherwise **executes in a shell** — verified), and confirms delivery from the pane, printing `queued` or `running`. Never treat a queue count as a wedge; a wedge needs a frozen build timer, a stream or api error, or a dead process. When a change must land before the current turn ends, kill and relaunch fresh with an updated handoff instead of waiting — and prefer putting scope in the launch message and handoff so live steering stays the exception.
