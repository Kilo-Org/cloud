# Nested kilo run inherits poisoned KILO_*/OPENCODE env

Symptom: a `kilo run` dispatched from inside another kilo session (orchestrator → role agent) misbehaves: wrong session attach, auth against the wrong stack, or silent misconfiguration that a directly launched run does not show.

Cause: the child inherits the parent's `KILO_*` and `OPENCODE*` environment variables. The tmux SERVER's global environment can also carry stale values into every new window (`tmux show-environment -g` to inspect), so even a fresh tmux window is not clean.

Fix: strip every `KILO_*`/`OPENCODE*` variable, not a fixed list — the harness also exports `KILO_RUN_ID`, `KILO_SERVER_*`, `KILO_PROCESS_ROLE`, and more, and partial stripping still poisons the child:

```bash
env $(env | grep -oE '^(KILO|OPENCODE)[A-Za-z0-9_]*' | sed 's/^/-u /') kilo run ...
```

If tmux global env is poisoned, clear it with `tmux set-environment -g -u <var>` before launching windows.
