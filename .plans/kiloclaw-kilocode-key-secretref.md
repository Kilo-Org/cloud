# KiloClaw: Store KiloCode API key as a SecretRef in auth-profiles.json

## Problem

The controller writes `KILOCODE_API_KEY` into the gateway process env, and on rotation it updates `process.env.KILOCODE_API_KEY` and signals SIGUSR1. There are two compounding bugs:

1. **Plaintext on disk shadows env.** `openclaw onboard` (run on first boot) writes the literal key into `/root/.openclaw/agents/<agentId>/agent/auth-profiles.json` under `profiles.kilocode:default.key`. OpenClaw's auth resolver prefers the configured auth-profile over the env var, so after rotation the gateway keeps authenticating with the **stale** plaintext key from disk.
2. **The gateway child process cannot see controller env changes.** Even if the plaintext were removed, the controller spawns the gateway with `env: process.env` at spawn time (`supervisor.ts:188`). Subsequent `process.env.KILOCODE_API_KEY = <new>` in the controller does not reach the gateway's env. So `openclaw secrets reload` re-resolves env SecretRefs from the gateway's **frozen** env snapshot and returns the old key; and SIGUSR1 takes the in-process restart branch (because bootstrap sets `OPENCLAW_NO_RESPAWN=1`), which keeps the process alive and re-initializes against the same frozen env.

Together: rotation silently no-ops, gateway keeps using the old key, user sees 401s until the next image redeploy (fresh spawn).

## Fix

Three parts, all in the controller:

1. **New instances — onboard with `--secret-input-mode ref`.** `openclaw onboard` stores `keyRef: { source: "env", provider: "default", id: "KILOCODE_API_KEY" }` instead of a plaintext key. No plaintext on disk.
2. **Legacy instances — migrate `auth-profiles.json` on boot.** Idempotent rewrite of any plaintext kilocode `key` to the same env-backed `keyRef`. Runs at the end of `runOnboardOrDoctor` so the gateway's first read already sees `keyRef`. Also runs on rotation as defense-in-depth.
3. **Rotation — `supervisor.restart()`, not a signal or RPC.** `POST /_kilo/env/patch`:
   1. Updates `process.env.KILOCODE_API_KEY` in the controller.
   2. Runs the auth-profiles migration (defensive; no-op after boot).
   3. Calls `supervisor.restart()`, which sends SIGTERM → gateway exits cleanly → the controller supervisor respawns with `env: process.env` — the controller's **current** env with the new key. The respawned gateway reads the (now migrated) `auth-profiles.json`, resolves the `keyRef` against its fresh env, and authenticates with the new key.

### Why NOT `openclaw secrets reload`

`secrets reload` is attractive (atomic snapshot swap, no restart) but doesn't work in our architecture. The openclaw server-side handler calls `prepareSecretsRuntimeSnapshot` without an env override, which falls back to `process.env` of the gateway process — frozen at spawn time. Re-resolving returns the same old value and the call "succeeds" while achieving nothing. Would require one of:

- Switching to `keyRef: { source: "file", ... }` with a controller-owned `/root/.openclaw/secrets/<name>` file the controller updates on rotation. File sources re-read live on each resolve. More code, more invariants.
- Removing `OPENCLAW_NO_RESPAWN=1` from bootstrap so SIGUSR1 takes the supervised-exit path. Unclear blast radius on other flows that rely on in-process restart.

Both are viable follow-ups; out of scope for this PR.

### Why NOT `supervisor.signal('SIGUSR1')`

With `OPENCLAW_NO_RESPAWN=1` set in `bootstrap.ts:188`, openclaw's `restartGatewayProcessWithFreshPid()` short-circuits to `{ mode: "disabled" }` (`openclaw/src/infra/process-respawn.ts:27-29`). The run loop then takes the in-process restart branch (`run-loop.ts:98-106`). The gateway process stays alive, re-initializes internal state, and re-reads everything against the same frozen env. Env rotation silently fails.

`supervisor.restart()` bypasses this: it sends SIGTERM (which openclaw treats as "stop", not "restart"), the gateway exits, and the controller supervisor respawns the child process with fresh env. The cost is no in-flight drain — acceptable for key rotation.

## Scope

All changes in `services/kiloclaw/controller/`. No openclaw changes. No worker changes.

## Changes

### 1. `config-writer.ts`: onboard with SecretRef mode

Add `--secret-input-mode ref` to `ONBOARD_FLAGS`. Keeps the `--kilocode-api-key` flag passthrough — OpenClaw's `resolveNonInteractiveApiKey` accepts flag + env together in ref mode and writes the env-backed `keyRef`.

### 2. `auth-profiles-migration.ts`

Exports `migrateKilocodeAuthProfilesToKeyRef(rootDir, deps)`:

- Scans `<rootDir>/agents/*/agent/auth-profiles.json`.
- For each profile where `type === "api_key"`, `provider === "kilocode"`, has non-empty plaintext `key`, and no `keyRef`: delete `key`, set `keyRef = { source: "env", provider: "default", id: "KILOCODE_API_KEY" }`.
- Atomic-write with mode `0o600`.
- Returns `{ filesScanned, filesModified, profilesMigrated }`. Logs migrated profile ids.
- Swallows per-file parse/IO errors with a warn log; never throws.
- Deps-injected fs primitives for testability.

### 3. `bootstrap.ts`: run migration after onboard/doctor

In `runOnboardOrDoctor`, after the onboard or doctor branch completes and before writing workspace files, call `migrateKilocodeAuthProfilesToKeyRef(CONFIG_DIR, deps)`. Bootstrap is guaranteed to run before `supervisor.start()`, so the gateway's first read of `auth-profiles.json` already sees `keyRef`. Also adds `statSync` to `BootstrapDeps`.

### 4. `routes/env.ts`: restart on rotation

`POST /_kilo/env/patch` sequence:

1. Validate + update `process.env[key]`.
2. Run `migrateKilocodeAuthProfilesToKeyRef` (idempotent; protects against legacy files that appeared after boot).
3. If `supervisor.getState() === 'running'`, fire-and-forget `supervisor.restart()` so the HTTP request returns promptly (matches old SIGUSR1 semantics). Log failures; the supervisor reaches a terminal state on its own.
4. Respond `{ ok, restarted, migratedProfiles }`.

### 5. Tests

- `auth-profiles-migration.test.ts`: plaintext → keyRef; idempotent; non-kilocode untouched; OAuth profiles untouched; multi-agent; malformed JSON skipped; writes 0o600; preserves unrelated profile fields.
- `config-writer.test.ts`: asserts onboard invocation includes `--secret-input-mode ref`.
- `bootstrap.test.ts`: integration test that `runOnboardOrDoctor` rewrites a seeded plaintext `auth-profiles.json` to `keyRef` form.
- `routes/env.test.ts`: input validation; migration runs; `supervisor.restart()` called when running; no restart when stopped; fire-and-forget errors are logged, not thrown.

## Rollout

- Ship controller update. Existing instances migrate their `auth-profiles.json` on next controller boot (which also restarts the gateway, picking up the migrated file). No coordinated data migration needed.
- No worker or DB changes.

## Out of scope

- Zero-downtime rotation via `{ source: "file", ... }` SecretRef. Requires a controller-owned secret file plus the live file read path. Revisit if restart-driven rotation proves too disruptive.
- Removing `OPENCLAW_NO_RESPAWN=1` from bootstrap so SIGUSR1 triggers a clean exit path. Would allow graceful drain before respawn during rotation. Needs a careful audit of the other SIGUSR1 code paths in openclaw.
- `openclaw.json` scrubbing. The kilocode key is only in `auth-profiles.json` and process env; no `openclaw.json` change needed.
- Moving `gateway.auth.token` to a SecretRef. Current token handling is fine.
