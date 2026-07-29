# mobile: a simulator claim killed mid-boot reclaims as alreadyOwned but leaves the device Shutdown (build then fails code=405)

Symptom: `pnpm dev:mobile:simulator claim` is interrupted (e.g. the invoking shell's own
command timeout kills it) after it wrote the claim lock but before the boot finished.
(A fresh claim boots before it renames, so the `Kilo E2E - <worktree>` label may or may
not have been applied yet at the moment of the kill.) A later
`pnpm dev:mobile:simulator claim` returns instantly with `alreadyOwned: true` and does
**not** boot the device. `pnpm dev:mobile:ios build <udid>` then fails:

```
An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):
Unable to lookup in current state: Shutdown
```

Cause: the reclaim path (`alreadyOwned`) returns before the boot step entirely; only a
fresh claim boots. The device is left Shutdown with the claim lock in place (the reclaim
reapplies the label if the killed attempt never got to it).

Fix (no re-claim needed, claim is idempotent):

```bash
xcrun simctl boot <udid>
xcrun simctl bootstatus <udid> -b   # wait for readiness
pnpm dev:mobile:ios build <udid>    # now installs
```

Prevention: run `pnpm dev:mobile:simulator claim` with a generous timeout (>= 10 min) —
booting an iPhone under parallel-workflow load exceeds 3 minutes on this machine, and the
default 2–3 minute shell timeouts kill the claim at exactly the wrong moment.
