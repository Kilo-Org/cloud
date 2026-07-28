# `e2e-slot.sh release` stopped a different section's dev stack

Symptom: releasing `file-preview-2975`'s slot printed
`Killed tmux session kilo-dev-hermes-mem-c716` and left
`kilo-dev-file-preview-2975` running. Another section's E2E verifier was
mid-round and carried on driving a device against a stack that no longer
existed, which surfaces as an inexplicable product failure in *that* section.

Cause: shell variable shadowing. `stop_stack` set `wt=$1`, computed
`sess=$(stack_session "$wt")`, then called `stack_is_covered "$sess"` — whose
loop reassigns the **same global** `wt` once per slot directory. On return `wt`
held the *last* slot's worktree, so the final `(cd "$wt" && pnpm dev:stop)`
stopped whichever section happened to sort last. `sess` stayed correct, so the
`tmux has-session` guard confirmed *our* stack was up and then stopped
*theirs*. `reap()` had the same exposure on its own `s` loop variable.

`dev:stop` is not at fault: it resolves its target purely from
`git rev-parse --show-toplevel` in the process cwd. It was handed the wrong cwd.

This was latent until the trailing-underscore fix (#4836). Before it,
`stack_session` returned a mangled name, `tmux has-session` always failed, and
`stop_stack` returned early — never reaching the `cd`. Fixing the name made the
guard pass and exposed the shadowing. A dormant bug behind a broken guard
becomes a live bug the moment the guard starts working; when repairing a
predicate, read what runs *after* it, not just the predicate.

Fix: declare `local` in every helper that a loop-bearing caller depends on —
`stack_is_covered`, `stop_stack`, `reap`. Bash functions share global scope by
default, so a helper called from inside a loop silently corrupts its caller's
iteration state.

Operational note: a slot must be acquired under the **verifier's own tmux
session name**. This incident began because the orchestrator acquired a slot in
a `slot-acq` window under a proxy `<section>-e2e-seed` session and parked a
`sleep` to hold it. That both violates the E2E-loop rule and creates a
self-deadlock: the verifier polls for a free slot that its own section's
sleeper holds, and neither side can progress.

Victim-side recovery (worked twice in hermes-mem-c716 r1, the section named in
the symptom): the kill is silent for the victim — `pnpm dev:status` just prints
"No dev session running" mid-round and the dev client loses Metro. While the
slot is still held, restart the stack in place: `pnpm dev:start --no-attach
mobile cloud-agent-next kiloclaw event-service` (the same ports return), restart
the CLI relay (`remote-cli.sh exec remote` → `Remote connection enabled.`),
re-prove `session list --pure`, re-anchor the dev client with the deep link, and
re-run only the iteration that was in flight — device-local measurements (e.g.
meminfo) from completed iterations stay valid. The companion `stack=none` shown
by `e2e-slot.sh status` even for live stacks was the #4836 name-mangling bug
(the same mangled session name made `has-session` always fail), already fixed.
