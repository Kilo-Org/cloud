# E2E Flow Testing (Maestro MCP)

This folder documents how an agent tests Kilo App flows end-to-end: local backend + app on a simulator, driven via the Maestro MCP. There is no test suite here and none is planned — the point is interactive flow verification (e.g. "start a CLI session, confirm it shows up in the app, open it, send a message").

All commands run from the **repo root** unless noted. Assumes a fresh checkout — complete the root [DEVELOPMENT.md](../../../DEVELOPMENT.md) setup first (Node via nvm, `pnpm install`, Docker Desktop, root `.env.local`, `pnpm dev:env`).

## 1. Local backend

```bash
pnpm dev:start --no-attach mobile cloud-agent-next kiloclaw
```

- Starts everything in a tmux session named `kilo-dev-<checkout-dir>`: Expo dev server (:8081), Next.js (:3000), Postgres (:5432), session-ingest (:8800), cloud-agent-next, kiloclaw (+ its tunnel and notifications). Dependencies start automatically.
- `--no-attach` skips the interactive tmux dashboard — required for agents.
- Verify with `pnpm dev:status`. Stop with `pnpm dev:stop`.
- Run DB migrations (`pnpm drizzle migrate` from the repo root) before testing. A local Postgres that's behind on migrations causes seemingly random 500s from the backend (e.g. every authenticated tRPC call failing with "column ... does not exist").
- Read a service's logs from its tmux window:

```bash
tmux ls                                            # find the kilo-dev-* session
tmux list-windows -t <session>
tmux capture-pane -p -t <session>:<window> -S -200
```

Before the first app launch, point the app at the local backend:

```bash
pnpm dev:env:mobile   # writes apps/mobile/.env.local with LAN-IP URLs for all local services
```

Restart the app (or reload from the Expo dev server) after this so Expo picks up the env file.

## 2. App on the simulator, signed in

- The app is the dev-build `com.kilocode.kiloapp` on an iOS simulator. Check booted simulators for it with `xcrun simctl listapps booted | grep kilocode`. If no simulator has the build, install one with `npx expo run:ios` from `apps/mobile/` (the `ios/` project is checked in).
- Sign in with **fake-login**: the local sign-in page (reached via the app's normal sign-in flow) has a "Test Account" form — enter any email (an account is created on first login, e.g. `e2e-mobile@example.com`); appending `?fakeUser=<email>` to the sign-in URL auto-submits.
- Seed data with `pnpm dev:seed` (topics in `dev/seed/`): `app:user-id <email>` to look up a user id, `app:add-credits <userId> <usd>` if completions return 402. Local Postgres is `postgres://postgres:postgres@localhost:5432/postgres`.

## 3. Kilo CLI against the local backend

Needed for flows involving remote CLI sessions (the session list, session mirroring, sending messages from the app).

**Install** in a scratch directory — never touch the global CLI:

```bash
mkdir -p /tmp/kilo-cli && cd /tmp/kilo-cli && npm i @kilocode/cli
```

**Mint a token** for the SAME user the app is signed in as (otherwise the app won't see the session). It's an HS256 JWT signed with `NEXTAUTH_SECRET` from the root `.env.local` — no deps needed:

```bash
NEXTAUTH_SECRET=$(grep '^NEXTAUTH_SECRET=' .env.local | cut -d= -f2- | tr -d '"') \
node -e '
const crypto = require("crypto");
const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
const h = b64({ alg: "HS256", typ: "JWT" });
const p = b64({ kiloUserId: process.argv[1], apiTokenPepper: null, version: 3 });
const sig = crypto.createHmac("sha256", process.env.NEXTAUTH_SECRET).update(h + "." + p).digest("base64url");
console.log(h + "." + p + "." + sig);
' "<kiloUserId>"
```

**Run** the CLI pointed at local services:

```bash
KILO_API_URL=http://localhost:3000 \
KILO_SESSION_INGEST_URL=http://localhost:8800 \
KILO_AUTH_CONTENT='{"kilo":{"type":"api","key":"<token>"}}' \
KILO_REMOTE=1 \
/tmp/kilo-cli/node_modules/.bin/kilo
```

- `KILO_REMOTE=1` enables remote at startup; mid-session, toggle via the TUI palette (ctrl+p → "Toggle remote").
- A session appears in the app's active list only after WS connect + first heartbeat (~12s after enabling remote). Heartbeats are every ~10s.
- Drive the TUI from tmux with `send-keys`; for slash commands the first Enter accepts autocomplete, the second submits.
- Debugging: `KILO_DEBUG_SESSION_INGEST=1` logs ingest flushes. To observe what the app sees: WS to `ws://localhost:8800/api/user/web?token=<jwt>`, send `{"type":"subscribe","sessionId":...}`; full session snapshot at `GET http://localhost:8800/api/session/<id>/export`.

## 4. Maestro MCP

The Maestro MCP drives the simulator (inspect screen, run YAML flows, screenshots).

**Setup** (once per machine):

```bash
brew install maestro   # or: curl -fsSL "https://get.maestro.mobile.dev" | bash
```

Then register the MCP server with your harness: stdio transport, command `maestro mcp` (e.g. `claude mcp add maestro -- maestro mcp` in Claude Code, or the equivalent MCP config entry in your harness). Restart the session after registering so the maestro tools appear.

**Usage**: `list_devices` → pick the booted simulator's device id → `inspect_screen` before targeting any element → `run` with inline YAML. Flows declare `appId: com.kilocode.kiloapp` and start with `launchApp`. Use `cheat_sheet` for unfamiliar Maestro commands.

Gotchas:

- Cold relaunch (`simctl terminate` + `launch`, or `launchApp` with `clearState: false`) restores navigation state — the app reopens on the last screen. Navigate back explicitly before testing a flow that assumes a starting screen.
- `simctl io recordVideo` is flaky (1-frame videos after first use). For capturing transitions, loop `simctl io screenshot` in the background (~7.5 fps) and assemble with ffmpeg.
- Re-inspect the screen after every UI change; element ids/text from a stale inspect will miss.

## 5. Cleaning up

When the e2e test is done, clean up everything you started: kill any CLI sessions and tmux windows/sessions you created, stop background log streams or screenshot loops, and remove scratch installs (e.g. `/tmp/kilo-cli`). Leave the user's own dev services (`kilo-dev-*` session) running — only tear down what you started yourself.
