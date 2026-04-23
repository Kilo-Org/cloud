# KiloClaw: Store KiloCode API key as a SecretRef in auth-profiles.json

## Problem

The controller writes `KILOCODE_API_KEY` into the gateway process env, and on rotation it updates `process.env.KILOCODE_API_KEY` and signals `SIGUSR1`. However, `openclaw onboard` (run on first boot) writes the literal key into
`/root/.openclaw/agents/<agentId>/agent/auth-profiles.json` under `profiles.kilocode:default.key`.

OpenClaw's auth resolver prefers the configured auth-profile over the env var (`src/agents/model-auth.ts:479-548`), so after rotation the gateway keeps authenticating with the **stale** plaintext key from disk. The env var fallback never fires, and `SIGUSR1` (which is a full restart) re-reads the stale file on reboot.

## Fix

1. **New instances**: onboard with `--secret-input-mode ref`. OpenClaw then stores `keyRef: { source: "env", provider: "default", id: "KILOCODE_API_KEY" }` instead of a plaintext key. The profile resolves the env var live on every reload.
2. **Existing instances**: controller-side migration that rewrites any existing plaintext `key` into a `keyRef` on boot (and defensively on rotation). Idempotent, safe to re-run.
3. **Rotation**: replace SIGUSR1 with `openclaw secrets reload` — an RPC that atomically swaps the in-memory secret snapshot without restarting. Keep SIGUSR1 as a fallback when reload fails.

`openclaw secrets reload` (from openclaw research):

- CLI → WebSocket RPC `secrets.reload` to the gateway on `ws://127.0.0.1:3001` (auth via `OPENCLAW_GATEWAY_TOKEN`).
- Server re-resolves SecretRefs against live env, atomically swaps snapshot; keeps last-known-good on failure.
- Returns `{ ok, warningCount }`. Zero-cost: no in-flight work is aborted (unlike SIGUSR1 which tears down channels, subagents, watchers).

With `keyRef: { source: "env", provider: "default", id: "KILOCODE_API_KEY" }`, rotation is: (a) update `process.env.KILOCODE_API_KEY`, (b) call `openclaw secrets reload`.

## Scope

All changes in `services/kiloclaw/controller/`. No openclaw changes. No worker changes.

## Changes

### 1. `config-writer.ts`: onboard with SecretRef mode

Add `--secret-input-mode ref` to `ONBOARD_FLAGS`. Keep the `--kilocode-api-key` flag passthrough — OpenClaw's `resolveNonInteractiveApiKey` (openclaw `src/commands/onboard-non-interactive/api-keys.ts:78-92`) accepts both flag + env together in ref mode and writes the env-backed `keyRef`.

### 2. New module: `auth-profiles-migration.ts`

Exports `migrateKilocodeAuthProfilesToKeyRef(rootDir, deps)`:

- Globs `<rootDir>/agents/*/agent/auth-profiles.json`.
- For each file, parses JSON; for each `profiles[id]` where `type === "api_key"` and `provider === "kilocode"` and `key` is a non-empty string AND `keyRef` is absent:
  - Delete `key`, set `keyRef = { source: "env", provider: "default", id: "KILOCODE_API_KEY" }`.
- If any profile changed, atomic-write the file back with mode `0o600`.
- Returns `{ filesScanned, filesModified, profilesMigrated }` for logging.
- Swallows per-file parse errors with a warn log; doesn't abort the migration.
- Deps-injected (readFileSync, readdirSync, statSync, writeFileSync, renameSync, unlinkSync, chmodSync, existsSync) so we can unit test without a real filesystem.

### 3. New module: `gateway-rpc.ts`

Exports `reloadGatewaySecrets({ token, port, timeoutMs }, deps)`:

- Shells out to `openclaw secrets reload --url ws://127.0.0.1:<port> --token <token>` via `execFileSync` with a short timeout (default 10s).
- Returns `{ ok: boolean, stderr?: string }`. Never throws.
- Deps-injected `execFileSync` for testability.

### 4. `bootstrap.ts`: run migration after onboard/doctor

In `runOnboardOrDoctor()`, after the onboard or doctor branch completes and the config has been patched, call `migrateKilocodeAuthProfilesToKeyRef('/root/.openclaw', deps)`. Log the result. A failure is non-fatal.

### 5. `routes/env.ts`: use `secrets reload` for rotation

`POST /_kilo/env/patch` now:

1. Updates `process.env[key]` as today.
2. Runs `migrateKilocodeAuthProfilesToKeyRef` (defensive; no-op after first boot).
3. Calls `reloadGatewaySecrets`.
4. If reload fails (gateway not running, degraded, etc.), falls back to `supervisor.signal('SIGUSR1')` — existing behavior preserved.
5. Returns `{ ok, reloaded: boolean, signaled: boolean, migrated: number }`.

The gateway token and port are already known to the route (`expectedToken` + `KILOCLAW_GATEWAY_ARGS` contains `--port 3001`; simpler to hardcode 3001 in the route like the rest of the controller).

### 6. Tests

- `auth-profiles-migration.test.ts`:
  - Migrates a file with plaintext kilocode key → keyRef.
  - Leaves already-keyRef profiles untouched (idempotent).
  - Leaves non-kilocode profiles untouched.
  - Leaves OAuth profiles untouched (different `type`).
  - Handles multiple agent directories.
  - Skips corrupt JSON with a warn.
  - Writes with mode 0o600.
- `gateway-rpc.test.ts`:
  - Calls `openclaw secrets reload` with correct args.
  - Returns `{ ok: true }` on success.
  - Returns `{ ok: false, stderr }` on failure.
- `config-writer.test.ts`: assert onboard invocation includes `--secret-input-mode ref`.
- `routes/env.test.ts`: assert migration runs, `secrets reload` is attempted, SIGUSR1 is fallback only.

## Rollout

- Ship controller update; existing instances migrate their auth-profiles.json at next boot and at next rotation. No data migration needed — migration runs in each instance independently.
- No worker or DB changes; this is entirely controller-local.

## Out of scope

- `openclaw.json` scrubbing (`secrets configure`/`secrets apply`). Our `openclaw.json` does not hold the kilocode key — the key is only in `auth-profiles.json` and process env. No change needed.
- Moving to `gateway.auth.token` as a SecretRef. Current token handling works and is out of scope for this change.
