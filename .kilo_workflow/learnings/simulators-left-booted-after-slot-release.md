# Simulators stayed booted after the e2e slot was released

Symptom: agents that correctly ran `e2e-slot.sh release` still left their
simulator booted. Devices accumulated across sections until several
`Kilo E2E - <worktree>` simulators were running at once with no slot held
between them, burning CPU under every section that followed and making later
emulator boots and native builds look flaky.

Cause: teardown was split between the script and the agent's memory. `release`
stopped the worktree's dev stack automatically, but the device was a manual
runbook step — and a *conditional* one:

```
xcrun simctl shutdown <udid>              # only if you booted it
pnpm dev:mobile:simulator release <udid>  # every simulator you claimed
```

Two failure modes, both routine. Agents skipped the line outright, having
released the slot and considered teardown done. And the ones that did read it
had no reliable way to answer "did you boot it" several hours into a run, so
skipping was the safe choice — shutting down a peer worktree's device is far
worse than leaking one. `pnpm dev:mobile:simulator release <udid>` never
powered anything off either: it dropped the claim and restored the name, so
even a fully compliant agent that ran every listed command left the device
running unless it also remembered the `simctl shutdown`.

The information the decision needed existed and was thrown away. `bootSimulator`
returns early when `device.state === 'Booted'`, so claim time knows exactly
whether it started the device — and nothing recorded it.

Fix: the claim records `bootedByClaim`, release powers off only what its own
claim booted, and `e2e-slot.sh release` runs
`pnpm dev:mobile:simulator release-all` for the releasing worktree alongside
`pnpm dev:stop`. Devices now go back with the slot exactly like the stack does,
and the conditional `simctl shutdown` line is gone from the runbook. A device
already booted before the claim is still never shut down — that guarantee moved
from the agent's memory into the claim record.

General shape: a cleanup step that depends on an agent recalling what it did
hours earlier will be skipped, and correctly so when the wrong guess is
destructive. Record the fact at the moment it is known and let teardown read it.
Any resource acquired under a slot belongs to that slot — if release does not
hand it back, nothing will.
