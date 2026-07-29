# E2E slot acquired under a shared/long-lived tmux session name leaks the slot

Symptom: an E2E slot stays held for tens of minutes with no verifier running; `e2e-slot.sh status`
shows the holder as a long-lived session name (e.g. the planner/starter session) while other
sections starve on a 3-slot machine. The slot is never auto-reclaimed because the holding session
never dies.

Cause: an orchestrator (not a verifier) ran `e2e-slot.sh acquire` itself, under its window's shared
tmux session name instead of a dedicated per-round verifier session. Slot reclamation keys on the
holder's tmux session being gone; a shared session outlives every round, so the hold is effectively
permanent until someone releases it by hand.

Fix: only the e2e-verifier acquires a slot, always under its own dedicated session name
(`<section>-e2e-verifier-<label>`), and releases it the moment its device phase ends (release also
stops the stack — a slot and a dev stack are the same resource since #4826). The orchestrator never
acquires slots, never starts dev stacks "for" a verifier, and checks `e2e-slot.sh status` before
declaring starvation; a blocked `acquire` from a real holder is correct behaviour, not a wedge.
