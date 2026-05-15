# KiloClaw Controller

## Status

Maintained — audited against `services/kiloclaw/controller/src` on
2026-05-14.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all
capitals, as shown here.

## Overview

The KiloClaw controller is the machine entrypoint process running inside
each Fly.io machine. It is the Dockerfile CMD entrypoint (`node
kiloclaw-controller.js`) and is responsible for:

1. Bootstrapping the machine environment (env decryption, openclaw
   onboarding/doctor, config patching, feature flags, integration
   metadata).
2. Serving an HTTP API on port 18789 for health probes, diagnostics,
   configuration management, and gateway lifecycle control.
3. Supervising the openclaw gateway process and auxiliary local
   processes such as Gmail watch delivery (automatic respawn on crash
   with exponential backoff).
4. Reverse-proxying HTTP and WebSocket traffic from the CF worker to
   the openclaw gateway on port 3001.
5. Bridging controller-mediated platform integrations: Kilo Chat,
   Google OAuth/Gmail, inbound email hooks, file import/write, doctor
   runs, Kilo CLI repair runs, and morning briefing control.

The controller owns the machine's entire lifecycle from boot to
shutdown. The CF worker communicates with it exclusively through the
HTTP API and WebSocket proxy.

## Startup Lifecycle

### Phased Startup

The controller starts in phases. Each phase depends on the previous
one succeeding, except where noted.

1. **HTTP server start.** The controller MUST start listening on port
   18789 before any other work. This ensures `/_kilo/health` is
   reachable from the moment the machine boots, even if bootstrap
   takes seconds or fails entirely.

2. **Critical bootstrap.** The controller MUST run the critical
   bootstrap steps (decryption, directories, feature flags, hooks token,
   gateway args) after the HTTP server is listening. Each major step updates
   the controller state so `/_kilo/health` reflects progress. If any
   critical step fails, the controller MUST enter degraded mode (see
   Degraded Mode) and MUST NOT proceed to subsequent phases.

3. **Runtime config load.** The controller MUST read the decrypted
   environment variables produced by bootstrap and construct the
   runtime configuration (gateway token, gateway args, WebSocket
   limits). This is not a separately observable health phase — it
   happens between `bootstrapping` and `starting` states. If this
   fails, the controller MUST enter degraded mode.

4. **Route registration.** The controller MUST register all Hono
   routes and activate the Hono app before attempting to start the
   gateway. This ensures that diagnostic and recovery endpoints
   (`/_kilo/version`, `/_kilo/config/*`, `/_kilo/env/*`,
   `/_kilo/gateway/*`) are available even if a later startup phase or
   the gateway itself fails.

5. **Non-critical bootstrap.** The controller MUST then run the
   non-critical bootstrap steps in order: GitHub config, Linear config,
   gateway-client device scope remediation, onboard/doctor with config
   patching, bounded `TOOLS.md` section updates, and mcporter config. If
   one of these steps fails, the controller MUST enter degraded mode but
   MUST keep the Hono app active so authenticated recovery endpoints
   remain available. The controller MUST NOT proceed to gateway start
   after a non-critical bootstrap failure.

6. **Pre-gateway setup.** The controller SHOULD attempt best-effort
   setup tasks (npm cache cleanup, Kilo CLI config, gog credentials,
   legacy Google credential migration, gog shim installation). Failures
   in this phase MUST be logged but MUST NOT prevent startup from
   continuing.

7. **Gateway start.** The controller MUST start the gateway supervisor
   as the final phase. It MUST then start the pairing cache, Gmail watch
   supervisor when configured, Gmail watch renewal, controller check-in,
   and delayed background Kilo CLI upgrade when enabled. If the gateway
   fails to start, the controller MUST enter degraded mode but MUST NOT
   tear down the Hono app — all `/_kilo/*` routes MUST remain functional.

### Event Loop Yields

Bootstrap steps use synchronous child process calls (`execFileSync`)
that block the Node event loop. The controller MUST yield to the
event loop (`setImmediate`) between bootstrap phases so the inline
health handler can process pending HTTP requests during bootstrap.

## Health Endpoint

### `/_kilo/health`

1. The endpoint MUST be unauthenticated — no bearer token or proxy
   token is required.
2. The endpoint MUST always return HTTP 200.
3. The response MUST always include `"status": "ok"`.
4. The response MUST include a `state` field reflecting the
   controller lifecycle state.
5. When `state` is `"bootstrapping"`, the response MUST include a
   `phase` field indicating the current bootstrap step.
6. When `state` is `"degraded"`, the response MUST include an
   `error` field. The error string MUST NOT contain raw exception
   messages, env var values, command argv, file paths, or any other
   potentially sensitive information. The error MUST be a generic
   stage label only (e.g., `"Startup failed during bootstrap"`).
7. The detailed error MUST be logged to stdout for operators (Docker
   logs / Fly log drain) but MUST NOT appear in any HTTP response.

### `/health`

1. The endpoint MUST be unauthenticated.
2. The endpoint MUST always return HTTP 200 with `{"status": "ok"}`.
3. The endpoint MUST NOT include state, phase, or error information.
   This is the bare endpoint for Fly health probes.

### State Values

| State           | Meaning                                          |
| --------------- | ------------------------------------------------ |
| `bootstrapping` | Bootstrap is in progress; `phase` indicates step |
| `starting`      | Bootstrap complete, gateway is starting          |
| `ready`         | Controller startup completed successfully        |
| `degraded`      | A startup phase failed; `error` explains which   |

Note: `ready` means the controller startup sequence completed and the
gateway was started. It does NOT mean the gateway is currently healthy.
The gateway may crash and be respawned by the supervisor while the
controller remains in `ready` state. To check whether the gateway
process is currently running, use the auth-gated `/_kilo/gateway/status`
endpoint.

### Bootstrap Phases

The `phase` field during `bootstrapping` progresses through:

| Phase                          | What is happening                                 |
| ------------------------------ | ------------------------------------------------- |
| `init`                         | HTTP server started, bootstrap not yet begun      |
| `decrypting`                   | Decrypting `KILOCLAW_ENC_*` env vars              |
| `directories`                  | Creating config/workspace dirs, setting env vars  |
| `feature-flags`                | Applying instance feature flags                   |
| `github`                       | Configuring GitHub access (best-effort)           |
| `linear`                       | Configuring Linear MCP availability               |
| `gateway-client-device-scopes` | Remediating gateway-client device approval scopes |
| `onboard`                      | Running `openclaw onboard` (first boot)           |
| `doctor`                       | Running `openclaw doctor --fix` (subsequent boot) |
| `tools-md`                     | Synchronizing managed `TOOLS.md` sections         |
| `mcporter`                     | Writing managed MCP server config                 |

### Endpoint Availability by Phase

| Phase                          | `/_kilo/health`                 | `/_kilo/*` routes | User traffic (proxy)    | WebSocket               |
| ------------------------------ | ------------------------------- | ----------------- | ----------------------- | ----------------------- |
| Critical bootstrap running     | Inline: `bootstrapping` + phase | 503               | 503                     | 503 reject              |
| Critical bootstrap failed      | Inline: `degraded`              | 503               | 503                     | 503 reject              |
| Runtime config failed          | Inline: `degraded`              | 503               | 503                     | 503 reject              |
| Routes registered              | Hono: `bootstrapping` + phase   | Auth-gated        | 503 "Gateway not ready" | 503 reject              |
| Non-critical bootstrap failed  | Hono: `degraded`                | Auth-gated        | 503 "Gateway not ready" | 503 reject              |
| Routes registered, gw starting | Hono: `starting`                | Auth-gated        | 503 "Gateway not ready" | Auth-gated              |
| Gateway start failed           | Hono: `degraded`                | Auth-gated        | 503 "Gateway not ready" | Auth-gated              |
| Fully operational              | Hono: `ready`                   | Auth-gated        | Proxied to gateway      | Proxied to gateway      |
| Gateway crashes at runtime     | Hono: `ready` (unchanged)       | Auth-gated        | 503 "Gateway not ready" | 503 "Gateway not ready" |

The first observable state over HTTP is `bootstrapping` with phase
`init`. There is no separately observable "HTTP server starting" state
— by the time a request is processed, the server is already listening.

The "gateway crashes at runtime" row shows that `/_kilo/health` remains
`ready` because controller state is only set during startup. The
gateway supervisor handles crash recovery independently. Use
`/_kilo/gateway/status` to check the current gateway process state.

## Gateway Status Endpoint

### `GET /_kilo/gateway/status`

1. The endpoint MUST require bearer token authentication.
2. The response MUST include the following fields:

| Field      | Type           | Description                                                 |
| ---------- | -------------- | ----------------------------------------------------------- |
| `state`    | string         | Supervisor state (see below)                                |
| `pid`      | number \| null | OS process ID of the gateway, null if not running           |
| `uptime`   | number         | Seconds since the current process started, 0 if not running |
| `restarts` | number         | Total restart count since controller boot                   |
| `lastExit` | object \| null | Last exit information, null if never exited                 |

3. The `lastExit` object, when present, MUST include:

| Field    | Type           | Description                                            |
| -------- | -------------- | ------------------------------------------------------ |
| `code`   | number \| null | Exit code, null if killed by signal                    |
| `signal` | string \| null | Signal name (e.g., `SIGTERM`), null if exited normally |
| `at`     | string         | ISO 8601 timestamp of the exit                         |

### Supervisor States

| State           | Meaning                                                 |
| --------------- | ------------------------------------------------------- |
| `stopped`       | Gateway is not running (manual stop or not yet started) |
| `starting`      | Gateway process is spawning                             |
| `running`       | Gateway process has been spawned and has not exited     |
| `stopping`      | SIGTERM sent, waiting for exit                          |
| `crashed`       | Gateway exited unexpectedly, restart pending            |
| `shutting_down` | Controller is shutting down, gateway being terminated   |

### Gateway Lifecycle Endpoints

1. `POST /_kilo/gateway/start` MUST require bearer token
   authentication. It MUST return 409 if the gateway is already
   running or starting.
2. `POST /_kilo/gateway/stop` MUST require bearer token
   authentication. It MUST send SIGTERM to the gateway and wait for
   exit.
3. `POST /_kilo/gateway/restart` MUST require bearer token
   authentication. It MUST stop the gateway, then start it. It MUST
   return 409 if the controller is shutting down.

## Degraded Mode

1. When the controller enters degraded mode, the HTTP server MUST
   remain alive. The process MUST NOT exit.
2. The controller MUST NOT expose raw error messages on any
   unauthenticated endpoint. All degraded error strings MUST be
   generic stage labels.
3. When critical bootstrap or runtime config load fails, only the inline
   health handler is active. All non-health HTTP requests MUST
   receive 503. WebSocket upgrades MUST receive a 503 response and
   the socket MUST be destroyed.
4. When non-critical bootstrap fails after routes are registered, all
   `/_kilo/*` endpoints required for recovery MUST remain functional.
   The catch-all proxy MUST return 503 with `"Gateway not ready"` for
   user traffic.
5. When the gateway fails to start (after routes are registered), all
   `/_kilo/*` endpoints MUST remain functional. The catch-all proxy
   MUST return 503 with `"Gateway not ready"` for user traffic.

## Bootstrap

### Env Var Decryption

1. The controller MUST decrypt all `KILOCLAW_ENC_*` environment
   variables using the `KILOCLAW_ENV_KEY` (AES-256-GCM).
2. If `KILOCLAW_ENC_*` variables are present but `KILOCLAW_ENV_KEY`
   is not set, the controller MUST fail closed and abort bootstrap.
3. If no `KILOCLAW_ENC_*` variables are present, decryption MUST be
   a no-op.
4. Each encrypted value MUST have the format `enc:v1:{base64}` where
   the base64 payload contains `iv (12 bytes) || ciphertext || auth
tag (16 bytes)`.
5. The stripped env var name (after removing the `KILOCLAW_ENC_`
   prefix) MUST be a valid shell identifier matching
   `^[A-Za-z_][A-Za-z0-9_]*$`. Invalid names MUST abort bootstrap.
6. After decryption, the controller MUST validate that
   `KILOCODE_API_KEY` and `OPENCLAW_GATEWAY_TOKEN` are present. If
   either is missing, bootstrap MUST abort. This check MUST apply
   regardless of whether decryption was performed.
7. After decryption and validation, the controller MUST delete
   `KILOCLAW_ENV_KEY` and all `KILOCLAW_ENC_*` keys from the process
   environment. Key material MUST NOT be available to the gateway
   child process.

### Directory Setup

1. The controller MUST create `/root/.openclaw` (mode 700),
   `/root/clawd`, and `/var/tmp/openclaw-compile-cache` if they do
   not exist.
2. The controller MUST set the working directory to `/root/clawd`.
3. The controller MUST set the following environment variables:
   - `OPENCLAW_NO_RESPAWN=1` — prevent the gateway from
     self-respawning (the supervisor handles this).
   - `NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache` — enable
     Node module compile cache.
   - `INVOCATION_ID=1` — tell the gateway it is running under a
     supervisor.
   - `GOG_KEYRING_PASSWORD=kiloclaw` — required for the gog keyring
     backend (not a secret; see gog-credentials.ts).
   - `OPENCLAW_PLUGIN_STAGE_DIR=/usr/local/share/openclaw-plugin-runtime-deps`
     when unset — keep bundled OpenClaw plugin runtime dependencies in
     the image-baked stage directory instead of mutating `/root` or each
     bundled plugin directory during doctor/gateway startup.
   - `KILO_API_URL` to the origin of `KILOCODE_API_BASE_URL` when the
     API base URL override is set.

### Feature Flags

1. Feature flags are passed as `KILOCLAW_*` environment variables by
   the CF worker via the Fly machine config.
2. When `KILOCLAW_NPM_GLOBAL_PREFIX=true`, the controller MUST
   create `/root/.npm-global/bin`, set `NPM_CONFIG_PREFIX`, and
   extend `PATH`. If directory creation fails, the controller MUST
   log a warning and MUST NOT set the env vars.
3. When `KILOCLAW_PIP_GLOBAL_PREFIX=true`, the controller MUST
   create `/root/.pip-global/bin`, set `PYTHONUSERBASE`, and extend
   `PATH`. Same failure behavior as npm.
4. When `KILOCLAW_UV_GLOBAL_PREFIX=true`, the controller MUST create
   `/root/.uv/{tools,bin,cache}`, set `UV_TOOL_DIR`,
   `UV_TOOL_BIN_DIR`, `UV_CACHE_DIR`, and extend `PATH`. Same
   failure behavior.
5. When `KILOCLAW_KILO_CLI=true` and `KILOCODE_API_KEY` is set, the
   controller MUST set `KILO_API_KEY` to the value of
   `KILOCODE_API_KEY`.

### GitHub Configuration

1. GitHub configuration is best-effort. Failures MUST be logged but
   MUST NOT abort bootstrap.
2. When `GITHUB_TOKEN` is set, the controller SHOULD run
   `gh auth login --with-token` and `gh auth setup-git`.
3. When `GITHUB_USERNAME` is set, the controller SHOULD run
   `git config --global user.name`. When `GITHUB_EMAIL` is set, the
   controller SHOULD run `git config --global user.email`. Failures
   MUST be logged but MUST NOT abort bootstrap.
4. When `GITHUB_TOKEN` is not set, the controller SHOULD clean up
   any previously stored credentials (`gh auth logout`,
   `git config --global --unset user.name/email`). Cleanup failures
   MUST be silently ignored.

### Linear and MCPorter Configuration

1. Linear configuration is managed through mcporter, not by writing
   OpenClaw MCP config directly.
2. When `LINEAR_API_KEY` is present, the controller MUST preserve it for
   the gateway environment and MUST configure the `linear` MCP server in
   `/root/.openclaw/workspace/config/mcporter.json` with URL
   `https://mcp.linear.app/mcp` and authorization header
   `Bearer ${LINEAR_API_KEY}`.
3. When `LINEAR_API_KEY` is absent, the controller MUST remove any
   managed `linear` entry from mcporter config and MUST remove any
   managed Linear section from `TOOLS.md`.
4. When `AGENTCARD_API_KEY` is present, the controller MUST configure
   the `agentcard` MCP server in mcporter with URL
   `https://mcp.agentcard.sh/mcp` and bearer authorization.
5. When `AGENTCARD_API_KEY` is absent, the controller MUST remove any
   managed `agentcard` entry from mcporter config.
6. mcporter config writes MUST preserve user-added server entries whose
   keys are not managed by the controller.

### Onboard vs Doctor

1. If `/root/.openclaw/openclaw.json` does not exist (first boot),
   the controller MUST generate a base config by running
   `openclaw onboard --non-interactive` against a temporary
   `OPENCLAW_CONFIG_PATH`, patching the temp config, chmodding it to
   `0600`, and atomically renaming it into place.
2. The onboard invocation MUST include the flags: `--accept-risk`,
   `--mode local`, `--gateway-port 3001`, `--gateway-bind loopback`,
   `--skip-channels`, `--skip-skills`, `--skip-health`,
   `--secret-input-mode ref`, and `--kilocode-api-key`.
3. If the config file exists (subsequent boot), the controller MUST
   run `openclaw doctor --fix --non-interactive`.
4. On first boot, the controller MUST seed
   `/root/.openclaw/workspace/TOOLS.md` from the image-baked copy at
   `/usr/local/share/kiloclaw/TOOLS.md`.
5. After onboard or doctor, the controller MUST seed
   `/root/.openclaw/exec-approvals.json` defaults to match the configured
   exec policy.
6. After onboard or doctor, the controller MUST migrate legacy plaintext
   KiloCode auth profile keys to env-backed key references.
7. The controller MUST seed `/root/.openclaw/workspace/IDENTITY.md` if
   it does not already exist, using `KILOCLAW_BOT_NAME`,
   `KILOCLAW_BOT_NATURE`, `KILOCLAW_BOT_VIBE`, and
   `KILOCLAW_BOT_EMOJI` when present and defaults otherwise. It MUST
   remove legacy `/root/.openclaw/workspace/BOOTSTRAP.md`.
8. When `KILOCLAW_USER_TIMEZONE` or `KILOCLAW_USER_LOCATION` is set,
   the controller MUST create or update `/root/.openclaw/workspace/USER.md`
   so the corresponding `Timezone` or `Location` field is present.
9. When `KILOCLAW_USER_LOCATION` is set, the controller SHOULD install
   the image-baked weather skill into `/root/clawd/skills/weather/SKILL.md`.

### TOOLS.md Sections

1. The controller MUST manage bounded sections in
   `/root/.openclaw/workspace/TOOLS.md` using begin/end markers so edits
   outside managed sections are preserved.
2. The controller MUST always enable the Kilo CLI, KiloClaw mitigations,
   plugin install guidance, and process model sections.
3. The controller MUST enable the Google Workspace section when
   `KILOCLAW_GOOGLE_WORKSPACE_ENABLED=true` or
   `KILOCLAW_GOG_CONFIG_TARBALL` is present; otherwise it MUST remove the
   managed section.
4. The controller MUST enable the 1Password section when
   `OP_SERVICE_ACCOUNT_TOKEN` is present; otherwise it MUST remove the
   managed section.
5. The controller MUST enable the Linear section when `LINEAR_API_KEY` is
   present; otherwise it MUST remove the managed section.

### Config Patching

After onboard or doctor, the controller MUST apply env-var-derived
patches to `openclaw.json`. The patches MUST include:

1. Gateway configuration: port 3001, mode `local`, bind `loopback`.
2. Gateway auth token from `OPENCLAW_GATEWAY_TOKEN`.
3. `allowInsecureAuth` when `AUTO_APPROVE_DEVICES=true`.
4. Allowed origins from `OPENCLAW_ALLOWED_ORIGINS`.
5. KiloCode provider entry MUST always be present at
   `models.providers.kilocode` with `baseUrl`
   `https://api.kilo.ai/api/gateway/`, `api` `openai-completions`, and
   `models` set to `[]`. The bundled openclaw kilocode plugin only loads
   when this entry is present; without it, live model discovery never
   runs and `kilo-auto/*` is unreachable. Stale entries written with
   the old `/api/openrouter/` base URL MUST be dropped before the entry
   is rebuilt.
6. KiloCode API base URL override from `KILOCODE_API_BASE_URL` (local
   dev tunnel).
7. Org-scoped KiloCode provider configuration from
   `KILOCODE_ORGANIZATION_ID`: MUST set the
   `X-KiloCode-OrganizationId` header on the kilocode provider entry.
   When `KILOCODE_ORGANIZATION_ID` is unset, the controller MUST
   remove any stale `X-KiloCode-OrganizationId` header from the entry.
8. Default model from `KILOCODE_DEFAULT_MODEL`.
9. Agent default user timezone from `KILOCLAW_USER_TIMEZONE`.
10. Remove `agents.defaults.models` allowlist (KiloClaw users see all
    models).
11. `tools.profile`: MUST be set to `full` on fresh install or config
    restore. MUST be preserved on subsequent boots.
12. Exec policy: host `gateway`, security from `KILOCLAW_EXEC_SECURITY`
    or default `allowlist`, ask from `KILOCLAW_EXEC_ASK` or default
    `on-miss`.
13. Update checks disabled (`update.checkOnStart=false`).
14. Browser: enabled, headless, noSandbox.
15. KiloClaw customizer plugin: load path and entry MUST be present;
    when `plugins.allow` exists, it MUST include `kiloclaw-customizer`.
    Web search MUST auto-enable the `kilo-exa` provider when
    `KILO_EXA_SEARCH_MODE=kilo-proxy`, or when the mode is unset and the
    user has not explicitly configured search; it MUST disable or defer to
    user/Brave configuration when `KILO_EXA_SEARCH_MODE=disabled` or any
    unrecognised value (unknown values MUST be logged and treated as `disabled`).
16. KiloClaw morning briefing plugin: load path and entry MUST be
    present; when `plugins.allow` exists, it MUST include
    `kiloclaw-morning-briefing`.
17. Channel configuration from `TELEGRAM_BOT_TOKEN`,
    `DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN`, with
    corresponding plugin enablement.
18. Session default DM scope MUST be `per-channel-peer` when unset.
19. Kilo Chat channel and plugin MUST be enabled. The channel MUST include
    `_configured=true` so OpenClaw treats it as meaningful configuration.
20. Hooks configuration from `KILOCLAW_HOOKS_TOKEN`: enabled, token,
    `/hooks` path, inbound email mapping, and allowed session key prefixes
    for `hook:` and `inbound-email:`. When Gmail credentials are present,
    the gmail preset MUST also be enabled. Legacy inbound-email `wake`
    mappings MUST be migrated to the current `agent` mapping form.
21. Vector memory: when `KILOCLAW_VECTOR_MEMORY_ENABLED=true`, configure
    `agents.defaults.memorySearch` to use the Kilo Gateway embeddings
    endpoint. When disabled and stale memory search config exists, mark it
    disabled and remove stale remote/provider/model fields.
22. Dreaming: when `KILOCLAW_DREAMING_ENABLED=true`, enable
    `plugins.entries.memory-core.config.dreaming`. When disabled and stale
    dreaming config exists, mark it disabled.
23. Custom secret path patching from `KILOCLAW_SECRET_CONFIG_PATHS`: for
    each env-var-to-config-path mapping, set the decrypted env value at the
    requested JSON dot-notation path unless the path contains a banned
    prototype-pollution segment.
24. Legacy Stream Chat channel/plugin config MUST be removed before the
    patched config is written.

### Hooks Token

1. The controller MUST generate a per-boot random hooks token (32 bytes,
   hex-encoded) and set it as `KILOCLAW_HOOKS_TOKEN`.
2. The hooks token MUST NOT be reused across boots.
3. External Workers MUST NOT receive `KILOCLAW_HOOKS_TOKEN`; they
   authenticate to controller endpoints with the gateway token, and the
   controller forwards to local OpenClaw hook endpoints with the hooks
   token.

### Google Workspace and Gmail

1. Google Workspace is configured from `KILOCLAW_GOG_CONFIG_TARBALL` and
   related metadata. The controller SHOULD extract credentials into the
   gog config directory, set `GOG_KEYRING_BACKEND=file`, set
   `GOG_KEYRING_PASSWORD=kiloclaw`, and set `GOG_ACCOUNT` when the
   Google account email is known.
2. When `KILOCLAW_GMAIL_LAST_HISTORY_ID` is present, the controller
   SHOULD patch the gog Gmail watch state so watch delivery resumes from
   the latest worker-observed history ID.
3. When Google credentials, account email, and hooks token are available,
   the controller SHOULD start a gog Gmail watch supervisor using
   `/usr/local/bin/gog.real gmail watch serve` bound to `127.0.0.1:3002`
   with path `/gmail-pubsub`, gateway-token authentication, hook URL
   `http://127.0.0.1:3001/hooks/gmail`, hook-token authentication, body
   inclusion, and bounded body bytes.
4. The controller SHOULD renew the Gmail watch periodically while the
   watch supervisor is running.
5. The controller SHOULD install the gog shim so normal `gog` invocations
   can use brokered OAuth tokens and legacy fallback behavior.
6. Legacy Google credential migration to the Kilo broker is best-effort.
   Migration failures MUST be logged and MUST NOT prevent gateway startup.

### Gateway Args

1. The controller MUST build the gateway CLI arguments array:
   `--port 3001 --verbose --allow-unconfigured --bind loopback`.
2. When `OPENCLAW_GATEWAY_TOKEN` is set, the controller MUST append
   `--token <value>` to the args.
3. The args MUST be serialized as a JSON array and set as
   `KILOCLAW_GATEWAY_ARGS` in the environment.

## Gateway Supervision

### Process Management

1. The supervisor MUST spawn the gateway as a child process using
   `openclaw gateway` with the constructed args.
2. The gateway's stdout and stderr MUST be piped to the controller's
   stdout and stderr.
3. The gateway MUST inherit the controller's `process.env`, which
   includes all decrypted env vars, feature flag settings, and
   runtime configuration.

### Crash Recovery

1. When the gateway exits with a non-zero code or is killed by a
   signal, the supervisor MUST automatically schedule a restart with
   exponential backoff.
2. Backoff MUST start at 1 second, multiply by 2 on each consecutive
   crash, and cap at 300 seconds (5 minutes).
3. When the gateway exits cleanly (code 0, no signal), the
   supervisor MUST respawn immediately without backoff. This is the
   SIGUSR1 restart path.
4. When the gateway runs for 30 seconds or longer before crashing,
   the supervisor MUST reset the backoff to the initial 1-second
   value.
5. When a manual stop has been requested, the supervisor MUST NOT
   schedule a restart.

### Shutdown

1. On SIGTERM or SIGINT, the controller MUST forward the received
   signal to the gateway (i.e., SIGTERM on SIGTERM, SIGINT on
   SIGINT).
2. If the gateway does not exit within 10 seconds of receiving the
   signal, the controller MUST send SIGKILL.
3. After the gateway exits (or is killed), the controller MUST close
   the HTTP server and exit the process.

## HTTP API

### Authentication Model

The controller uses three authentication mechanisms:

| Auth type    | Header                          | Used by                               |
| ------------ | ------------------------------- | ------------------------------------- |
| Bearer token | `Authorization: Bearer <token>` | All `/_kilo/*` routes except health   |
| Proxy token  | `x-kiloclaw-proxy-token`        | Catch-all HTTP proxy, WebSocket proxy |
| None         | —                               | `/health`, `/_kilo/health`            |

1. Bearer token comparisons MUST be timing-safe.
2. Proxy token enforcement is controlled by `REQUIRE_PROXY_TOKEN`.
   When enabled, requests without a valid proxy token MUST receive 401. The proxy token header MUST be stripped before forwarding to
   the gateway.

### Endpoint Catalog

#### Health (unauthenticated)

| Method | Path            | Description                                 |
| ------ | --------------- | ------------------------------------------- |
| GET    | `/health`       | Bare Fly probe — always `{"status":"ok"}`   |
| GET    | `/_kilo/health` | Controller lifecycle state with phase/error |

#### Version (bearer token)

| Method | Path             | Description                                                                   |
| ------ | ---------------- | ----------------------------------------------------------------------------- |
| GET    | `/_kilo/version` | Controller version, commit, openclaw version, gateway stats, controller state |

The response fields are:

| Field             | Type           | Required | Description                                                                        |
| ----------------- | -------------- | -------- | ---------------------------------------------------------------------------------- |
| `version`         | string         | Yes      | Controller version (calver)                                                        |
| `commit`          | string         | Yes      | Controller build commit hash                                                       |
| `openclawVersion` | string \| null | Yes      | Installed openclaw version                                                         |
| `openclawCommit`  | string \| null | Yes      | Installed openclaw commit hash                                                     |
| `gateway`         | object \| null | Yes      | Supervisor stats (same as `/_kilo/gateway/status`), null if supervisor not created |
| `controllerState` | object         | No       | Current controller lifecycle state, present when state ref is wired                |
| `kiloChatHealth`  | object         | No       | Kilo Chat health probe summary, present when Kilo Chat probing is active           |

#### Gateway (bearer token)

| Method | Path                     | Description                                |
| ------ | ------------------------ | ------------------------------------------ |
| GET    | `/_kilo/gateway/status`  | Gateway supervisor state and stats         |
| POST   | `/_kilo/gateway/start`   | Start the gateway (409 if running)         |
| POST   | `/_kilo/gateway/stop`    | Stop the gateway gracefully                |
| GET    | `/_kilo/gateway/ready`   | Proxy the gateway readiness endpoint       |
| POST   | `/_kilo/gateway/restart` | Restart the gateway (409 if shutting down) |

#### Config (bearer token)

| Method | Path                                      | Description                                                |
| ------ | ----------------------------------------- | ---------------------------------------------------------- |
| GET    | `/_kilo/config/read`                      | Read openclaw.json with MD5 etag                           |
| POST   | `/_kilo/config/restore/base`              | Regenerate config from env vars, signal gateway reload     |
| POST   | `/_kilo/config/replace`                   | Atomically replace openclaw.json (etag concurrency)        |
| POST   | `/_kilo/config/patch`                     | Deep-merge a JSON patch into openclaw.json                 |
| POST   | `/_kilo/config/tools-md/google-workspace` | Enable/disable managed Google Workspace `TOOLS.md` section |

The restore endpoint only accepts `base` as the version parameter.
Other values MUST return 400.

#### Environment (bearer token)

| Method | Path               | Description                                          |
| ------ | ------------------ | ---------------------------------------------------- |
| POST   | `/_kilo/env/patch` | Hot-patch allowed env vars and signal gateway reload |

#### Google OAuth (bearer token)

| Method | Path                         | Description                                      |
| ------ | ---------------------------- | ------------------------------------------------ |
| POST   | `/_kilo/google-oauth/token`  | Resolve a brokered Google OAuth access token     |
| POST   | `/_kilo/google-oauth/status` | Report broker/legacy Google credential readiness |

#### Pairing (bearer token)

| Method | Path                              | Description                              |
| ------ | --------------------------------- | ---------------------------------------- |
| GET    | `/_kilo/pairing/channels`         | Channel pairing state (optional refresh) |
| GET    | `/_kilo/pairing/devices`          | Device pairing state (optional refresh)  |
| POST   | `/_kilo/pairing/channels/approve` | Approve a channel pairing request        |
| POST   | `/_kilo/pairing/devices/approve`  | Approve a device pairing request         |

#### Gmail Push (bearer token)

| Method | Path                  | Description                                           |
| ------ | --------------------- | ----------------------------------------------------- |
| POST   | `/_kilo/gmail-pubsub` | Forward Google Pub/Sub push to gog watch on port 3002 |

The Gmail push endpoint MUST return 404 when Gmail watch is not
configured and 503 when the watch supervisor is configured but not
running. When forwarding, it MUST authenticate to gog with
`x-gog-token: <gateway token>`.

#### Inbound Hooks (bearer token)

| Method | Path                 | Description                                      |
| ------ | -------------------- | ------------------------------------------------ |
| POST   | `/_kilo/hooks/email` | Forward inbound email payloads to OpenClaw hooks |

#### Files and Profiles (bearer token)

| Method | Path                                     | Description                                   |
| ------ | ---------------------------------------- | --------------------------------------------- |
| POST   | `/_kilo/bot-identity`                    | Write bot identity metadata                   |
| POST   | `/_kilo/user-profile`                    | Write user profile metadata                   |
| GET    | `/_kilo/files/tree`                      | List the safe file tree under controller root |
| GET    | `/_kilo/files/read`                      | Read a safe file path                         |
| POST   | `/_kilo/files/import-openclaw-workspace` | Import OpenClaw workspace files               |
| POST   | `/_kilo/files/write`                     | Write a safe file path                        |

#### Doctor (bearer token)

| Method | Path                   | Description                          |
| ------ | ---------------------- | ------------------------------------ |
| POST   | `/_kilo/doctor/start`  | Start an async `openclaw doctor` run |
| GET    | `/_kilo/doctor/status` | Inspect current doctor run status    |
| POST   | `/_kilo/doctor/cancel` | Cancel the active doctor run         |

#### Kilo CLI Run (bearer token)

| Method | Path                    | Description                 |
| ------ | ----------------------- | --------------------------- |
| POST   | `/_kilo/cli-run/start`  | Start an async Kilo CLI run |
| GET    | `/_kilo/cli-run/status` | Inspect current run status  |
| POST   | `/_kilo/cli-run/cancel` | Cancel the active Kilo run  |

#### Morning Briefing (bearer token)

| Method | Path                                     | Description                           |
| ------ | ---------------------------------------- | ------------------------------------- |
| GET    | `/_kilo/morning-briefing/status`         | Proxy morning briefing plugin status  |
| POST   | `/_kilo/morning-briefing/enable`         | Enable the morning briefing schedule  |
| POST   | `/_kilo/morning-briefing/disable`        | Disable the morning briefing schedule |
| POST   | `/_kilo/morning-briefing/run`            | Run briefing generation immediately   |
| POST   | `/_kilo/morning-briefing/interests`      | Update briefing interest topics       |
| GET    | `/_kilo/morning-briefing/read/today`     | Read today's briefing markdown        |
| GET    | `/_kilo/morning-briefing/read/yesterday` | Read yesterday's briefing markdown    |

#### Kilo Chat (bearer token)

Kilo Chat routes are registered only when both `KILOCLAW_SANDBOX_ID` and
`KILOCHAT_BASE_URL` are set. When registered, the controller MUST relay
to `${KILOCHAT_BASE_URL}/bot/v1/sandboxes/:sandboxId` using the
per-sandbox gateway token.

| Method | Path                                                                                 | Description                     |
| ------ | ------------------------------------------------------------------------------------ | ------------------------------- |
| POST   | `/_kilo/kilo-chat/send`                                                              | Send a Kilo Chat message        |
| PATCH  | `/_kilo/kilo-chat/messages/:messageId`                                               | Edit a Kilo Chat message        |
| DELETE | `/_kilo/kilo-chat/messages/:messageId`                                               | Delete a Kilo Chat message      |
| POST   | `/_kilo/kilo-chat/messages/:messageId/reactions`                                     | Add a message reaction          |
| DELETE | `/_kilo/kilo-chat/messages/:messageId/reactions`                                     | Delete a message reaction       |
| POST   | `/_kilo/kilo-chat/typing`                                                            | Start typing indicator          |
| POST   | `/_kilo/kilo-chat/typing/stop`                                                       | Stop typing indicator           |
| GET    | `/_kilo/kilo-chat/conversations/:conversationId/messages`                            | List conversation messages      |
| PATCH  | `/_kilo/kilo-chat/conversations/:conversationId`                                     | Rename a conversation           |
| POST   | `/_kilo/kilo-chat/bot-status`                                                        | Set bot status                  |
| POST   | `/_kilo/kilo-chat/conversations/:conversationId/conversation-status`                 | Set conversation status         |
| POST   | `/_kilo/kilo-chat/conversations`                                                     | Create a conversation           |
| GET    | `/_kilo/kilo-chat/conversations`                                                     | List conversations              |
| GET    | `/_kilo/kilo-chat/conversations/:conversationId/members`                             | List conversation members       |
| POST   | `/_kilo/kilo-chat/conversations/:conversationId/messages/:messageId/delivery-failed` | Report message delivery failure |
| POST   | `/_kilo/kilo-chat/conversations/:conversationId/actions/:groupId/delivery-failed`    | Report action delivery failure  |

#### Catch-All Proxy (proxy token)

| Method | Path | Description                                |
| ------ | ---- | ------------------------------------------ |
| ALL    | `*`  | Reverse-proxy to gateway at 127.0.0.1:3001 |

1. The catch-all MUST be registered last so all `/_kilo/*` routes
   take priority.
2. When the gateway is not running, the proxy MUST return 503 with
   `"Gateway not ready"`.
3. When proxy token enforcement is enabled and a request to a
   `/_kilo/*` path fails token validation, the proxy MUST return 401
   with error code `controller_route_unavailable`. If the proxy token
   is valid (or enforcement is disabled) and the gateway is running,
   unmatched `/_kilo/*` paths are forwarded to the gateway like any
   other request. If the gateway is not running, they receive the
   standard 503 "Gateway not ready" response.
4. The proxy MUST strip `x-kiloclaw-proxy-token` and rewrite the
   `Host` header before forwarding to the gateway.

## WebSocket Proxy

1. WebSocket upgrade requests MUST be handled on the raw HTTP
   server's `upgrade` event, not through Hono.
2. During bootstrap or degraded mode (before the Hono app is
   activated), upgrade requests MUST receive a 503 Service
   Unavailable response and the socket MUST be destroyed.
3. After the Hono app is activated, upgrade requests MUST be proxied
   to the gateway at `127.0.0.1:3001`.
4. The proxy MUST enforce the proxy token when `REQUIRE_PROXY_TOKEN`
   is enabled.
5. The proxy MUST strip `x-kiloclaw-proxy-token`, `x-forwarded-for`,
   `x-real-ip`, and `x-forwarded-host` headers and rewrite `Host` to
   loopback before forwarding.
6. The proxy MUST enforce a maximum concurrent connection limit
   (default 100, configurable via `MAX_WS_CONNS`).
7. The proxy MUST enforce an idle timeout (default 600 seconds,
   configurable via `WS_IDLE_TIMEOUT_MS`). Connections with no data
   in either direction for the timeout period MUST be closed.
8. The proxy MUST enforce a handshake timeout (default 5 seconds,
   configurable via `WS_HANDSHAKE_TIMEOUT_MS`). If the gateway does
   not complete the WebSocket handshake within the timeout, the proxy
   MUST respond with 502 Bad Gateway and destroy the socket.

## Env Var Encryption

1. Sensitive env var values are AES-256-GCM encrypted by the CF
   worker before placement in the Fly machine `config.env`.
2. The per-user encryption key (`KILOCLAW_ENV_KEY`) is stored as a
   Fly app secret, injected at boot, and never in `config.env`.
3. Encrypted vars use the `KILOCLAW_ENC_` prefix with value format
   `enc:v1:{base64(iv || ciphertext || tag)}`.
4. The controller MUST fail closed: if `KILOCLAW_ENC_*` vars exist
   without `KILOCLAW_ENV_KEY`, startup MUST abort.
5. After decryption, the controller MUST delete key material from the
   process environment before spawning any child process.

## Shutdown

1. The controller MUST handle SIGTERM and SIGINT signals.
2. On receiving either signal, the controller MUST:
   a. Clean up the pairing cache.
   b. Stop the gmail watch renewal timer.
   c. Send the signal to the gateway supervisor and gmail watch
   supervisor (if running).
   d. Wait for both supervisors to shut down (with SIGKILL fallback
   after 10 seconds).
   e. Close the HTTP server.
   f. Exit the process with code 0.
3. Concurrent signals MUST be deduplicated — only the first signal
   triggers the shutdown sequence.
4. If the shutdown sequence itself fails, the controller MUST exit
   with code 1.

## Error Handling

1. All degraded-state error strings exposed on the unauthenticated
   `/_kilo/health` endpoint MUST use the `toPublicDegradedError(stage)`
   helper, which returns only a generic stage label. Raw exception
   messages, command argv, env var values, and file paths MUST NOT
   appear in unauthenticated responses. (`/health` is not affected —
   it always returns `{"status":"ok"}` with no error field.)
2. Authenticated endpoints (`/_kilo/config/*`, `/_kilo/env/*`, etc.)
   MAY include operational error details in responses since the
   caller has already proven identity via bearer token.
3. The full error MUST always be logged to stdout.
4. Best-effort steps (npm cache cleanup, Kilo CLI config, gog
   credentials, legacy Google credential migration, gog shim
   installation, GitHub configuration) MUST log failures but MUST NOT
   abort startup or enter degraded mode.
5. Feature flag directory creation failures MUST log a warning and
   skip the corresponding env var setup, matching the documented
   behavior of each flag.
6. The first-boot path MUST set `KILOCLAW_FRESH_INSTALL=true` before
   calling `writeBaseConfig` so `generateBaseConfig` forces
   `tools.profile=full`; config restore MUST also force
   `tools.profile=full` before atomically replacing `openclaw.json`.
