# Steering a running interactive kilo session rarely works — deliver scope before launch

Symptom: a scope change or steering message sent to a running `kilo run --interactive` session (orchestrator) never takes effect: the pane shows the text but nothing happens, or it sits queued forever while the session loops.

Cause: two independent traps. (1) `tmux send-keys` with a long message delivers it as a bracketed paste that sits UNSENT in the input box — the trailing Enter is consumed by the paste, so the message is never submitted. (2) Even a submitted message only enters kilo's interactive queue, which flushes at a turn boundary; a session busy in a long loop may not reach one for a long time, and Escape does not force a flush.

Fix: put everything the session needs in its launch message and handoff — deliver scope changes before launch whenever possible. When steering a live session is unavoidable: send ONE consolidated, self-contained message (not a drip of corrections), send the Enter as a separate `tmux send-keys -t <win> Enter` after the text, then capture the pane and verify the message shows as queued/submitted. If it must take effect now and the session is mid-loop, kill and relaunch fresh with an updated handoff instead of waiting.
