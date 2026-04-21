# Instance Feature Flags

KiloClaw uses per-instance feature flags to gate behavior that should only apply to newly provisioned instances. This avoids breaking existing users whose agents may depend on default paths or conventions.

## How it works

Feature flags are owned by the Durable Object and stored in its SQLite state (`instanceFeatures` array). On first provision (`isNew = true`), the DO populates the current default set from `DEFAULT_INSTANCE_FEATURES`. On subsequent provisions and reboots, existing features are preserved.

Features flow to the Fly machine as environment variables through the `buildEnvVars()` pipeline. Each feature maps to a `KILOCLAW_*` env var (defined in `FEATURE_TO_ENV_VAR` in `gateway/env.ts`). The controller's bootstrap reads these env vars and conditionally enables behavior.

```
DO (source of truth) → buildEnvVars() → config.env → Fly machine → controller bootstrap
```

### Why the DO owns this

- Single source of truth — no filesystem state to drift or audit
- Uses the existing env var pipeline — same as every other config value
- Observable — feature set is in DO SQLite, queryable via admin APIs
- Legacy instances get an empty array by default (Zod schema `.default([])`)

## Current flags

| Feature name        | Env var                      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm-global-prefix` | `KILOCLAW_NPM_GLOBAL_PREFIX` | Redirects `npm install -g` to `/root/.npm-global` (persistent volume) instead of `/usr/local` (image layer, lost on restart). Both `NPM_CONFIG_PREFIX` and `PATH` are set conditionally in `bootstrap.ts`.                                                                                                                                                                                                                                 |
| `pip-global-prefix` | `KILOCLAW_PIP_GLOBAL_PREFIX` | Redirects `pip install --user` to `/root/.pip-global` (persistent volume) via `PYTHONUSERBASE`. PATH is appended conditionally in `bootstrap.ts`.                                                                                                                                                                                                                                                                                          |
| `uv-global-prefix`  | `KILOCLAW_UV_GLOBAL_PREFIX`  | Configures `uv` tool/cache directories on the persistent volume (`/root/.uv`). Sets `UV_TOOL_DIR`, `UV_TOOL_BIN_DIR`, and `UV_CACHE_DIR`. PATH is appended conditionally in `bootstrap.ts`.                                                                                                                                                                                                                                                |
| `kilo-cli`          | `KILOCLAW_KILO_CLI`          | Enables auto-configuration of the Kilo CLI (`kilo`). On fresh install, seeds `/root/.config/kilo/kilo.json` with permissions and exports `KILO_API_KEY` from `KILOCODE_API_KEY`. On every boot, migrates legacy `/root/.config/kilo/opencode.json` to `/root/.config/kilo/kilo.json` when needed and patches base URL if `KILOCODE_API_BASE_URL` is set. The `kilo` binary is always in the image; this flag controls config writing only. |

## Adding a new flag

1. Add the feature name to `DEFAULT_INSTANCE_FEATURES` in `kiloclaw-instance.ts`
2. Add the feature-to-env-var mapping in `FEATURE_TO_ENV_VAR` in `gateway/env.ts`
3. Add a conditional block in `controller/src/bootstrap.ts` `applyFeatureFlags()` that reads the env var
4. If PATH changes are needed, add them inside the conditional block in `applyFeatureFlags()`
5. Update the table above

## Existing instances

Features are set once at first provision and preserved on re-provision. New features added to `DEFAULT_INSTANCE_FEATURES` only apply to newly provisioned instances — existing instances keep their original set. This is by design to avoid breaking existing users.

To get the latest feature set, a user must destroy and re-provision their instance.

## Key files

- `src/durable-objects/kiloclaw-instance.ts` — `DEFAULT_INSTANCE_FEATURES`, provision logic
- `src/schemas/instance-config.ts` — `instanceFeatures` in `PersistedStateSchema`
- `src/gateway/env.ts` — `FEATURE_TO_ENV_VAR`, maps features to env vars
- `controller/src/bootstrap.ts` — reads env vars, applies runtime configuration (including PATH)
