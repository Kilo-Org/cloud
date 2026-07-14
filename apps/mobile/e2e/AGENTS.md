# Mobile E2E Runbook

Use this runbook for interactive verification against a local backend. Commands run from the repository root unless a step says otherwise. The repository dev runner keeps long-lived services in a worktree-specific tmux session; use it instead of loose background processes.

## Fresh Worktree Quickstart

If dependencies or local env files are missing, run this once:

```bash
node --version # must be v24; activate the root .nvmrc first if needed
pnpm dev:worktree:prepare
```

Record pre-existing state so you clean up only resources you create:

```bash
pnpm dev:status --json
tmux ls
xcrun simctl list devices booted
```

Reuse a complete stack already running for this worktree. Do not start a competing stack or stop an unrelated `kilo-dev-*` session.

When this worktree has no stack, start the complete mobile flow with worktree-safe ports:

```bash
export KILO_PORT_OFFSET=auto
pnpm dev:env -y cloudflare-session-ingest
pnpm dev:start --no-attach mobile cloud-agent-next kiloclaw event-service
pnpm drizzle migrate
pnpm dev:env:mobile
pnpm dev:restart nextjs
pnpm dev:restart mobile
sleep 3
pnpm dev:status --json
```

`dev:env:mobile` writes this stack's LAN URLs. Restart Next.js for native auth callbacks and Metro for bundled Expo env values. The session-ingest env step creates the JWT Secrets Store binding; without it the worker can appear healthy while rejecting every session request. `event-service` is required for presence and notification behavior.

Confirm `mobile`, `nextjs`, `cloudflare-session-ingest`, `cloud-agent-next`, `kiloclaw`, and `event-service` are `up`. Restarts are asynchronous; if `mobile` is still starting, inspect its log and rerun status instead of restarting the stack. Use reported ports; never assume defaults in a secondary worktree.

## Logs and tmux

Prefer the stable log files:

```bash
pnpm dev:status --json
tail -n 200 dev/logs/<service>.log
```

Use tmux when you need live pane state or an interactive process:

```bash
tmux ls
tmux list-windows -t <dev-session>
tmux capture-pane -p -t <dev-session>:<service> -S -200
```

Put any extra long-lived CLI, recorder, or log follower in a clearly named `kilo-e2e-*` tmux session so it is visible and easy to remove.

## iOS Simulator

Reuse a booted simulator when possible, but always replace any installed Kilo app when validating a fresh worktree. This avoids stale native builds, most app data, and saved Metro URLs. iOS Keychain credentials can survive uninstall; the login helper handles an existing session. Otherwise boot one explicitly:

```bash
xcrun simctl list devices available
xcrun simctl boot <udid>
open -a Simulator
xcrun simctl bootstatus <udid> -b
```

Uninstall Kilo, then build from this worktree in a dedicated tmux session. A fresh checkout generates the gitignored `ios/` directory and installs pods, so the first build takes a few minutes and is noisy:

```bash
xcrun simctl uninstall <udid> com.kilocode.kiloapp 2>/dev/null || true
IOS_BUILD_SESSION="kilo-e2e-ios-$(basename "$PWD")"
tmux new-session -d -s "$IOS_BUILD_SESSION" -c "$PWD/apps/mobile"
tmux set-option -t "$IOS_BUILD_SESSION" remain-on-exit on
tmux respawn-pane -k -t "$IOS_BUILD_SESSION":0.0 \
  "npx expo run:ios --device <udid> --no-bundler"
tmux capture-pane -p -t "$IOS_BUILD_SESSION" -S -80
tmux display-message -p -t "$IOS_BUILD_SESSION" '#{pane_dead} #{pane_dead_status}'
```

Poll the bounded pane tail until `pane_dead` is `1` and `pane_dead_status` is `0`; do not stream the full native build into agent context. Then connect to the Metro URL shown by this worktree's `mobile` pane. `expo run:ios --no-bundler` may still open port 8081 instead of the worktree-safe port:

```bash
xcrun simctl openurl <udid> \
  "exp+kilo-app://expo-development-client/?url=http%3A%2F%2F<lan-ip>%3A<metro-port>"
```

Before testing, capture the `mobile` pane and verify `Starting project at <this-worktree>/apps/mobile` plus a fresh `iOS Bundled` line. Seeing the Kilo login screen alone does not prove bundle provenance. The login helper dismisses the clean-install tracking alert and Expo dev-menu introduction when present.

## Sign In and Out

Backend and Metro must be running. These idempotent wrappers leave the app in a known state:

```bash
apps/mobile/e2e/login.sh <udid> [email]  # default: e2e-mobile@example.com
apps/mobile/e2e/logout.sh <udid>
```

Login requests an email OTP, reads it from `dev/logs/emails/`, verifies it, and accepts first-account consent. Re-run login if a dev-build cold launch loses the session.

Maestro can emit a large interactive transcript. For agent-driven runs, keep successful output out of context and show only a bounded failure tail:

```bash
LOGIN_LOG=$(mktemp /tmp/kilo-login.XXXXXX)
apps/mobile/e2e/login.sh <udid> >"$LOGIN_LOG" 2>&1 || \
  { tail -n 100 "$LOGIN_LOG"; false; }
```

When editing the flows, preserve these device-tested constraints:

- Tap the Kilo home-screen icon; Maestro `launchApp` can bounce the Expo dev client to SpringBoard.
- Pass `EMAIL` and `OTP` with `-e`; flow-level defaults override them in the installed Maestro version.
- Target the email field by `you@example.com`, and tap `Verify code` without trying to dismiss the number pad.
- The native sign-out confirmation is the first case-insensitive `Sign Out` match (`index: 0`).

Seed only when needed:

```bash
pnpm dev:seed app:user-id <email>
pnpm dev:seed app:add-credits <user-id> <usd>
```

## Maestro

One-time machine setup:

```bash
brew install maestro
```

For MCP use stdio command `maestro mcp`, then restart the agent session so its tools appear. Inspect the screen before selecting elements and re-inspect after UI changes. Flows use `appId: com.kilocode.kiloapp`; accessibility labels match with `text:`, not `id:`.

CLI fallback:

```bash
maestro --device <udid|emulator-5554> test -e KEY=VALUE <flow.yaml>
xcrun simctl io <udid> screenshot <path>      # iOS
adb exec-out screencap -p > <path>            # Android
```

Attach a screenshot of the changed flow to the PR when it helps review. For transitions, prefer a short screenshot loop over `simctl io recordVideo`, which can produce one-frame recordings.

## Remote CLI Session Flows

Use this only when testing session discovery, mirroring, or mobile-to-CLI messaging. Install the CLI in a disposable directory, never globally:

```bash
CLI_SCRATCH=$(mktemp -d /tmp/kilo-cli.XXXXXX)
npm install --prefix "$CLI_SCRATCH" @kilocode/cli
E2E_EMAIL=${E2E_EMAIL:-e2e-mobile@example.com}
USER_ID=$(pnpm -s dev:seed app:user-id "$E2E_EMAIL" --json | jq -r .userId)
TOKEN=$(NEXTAUTH_SECRET=$(grep '^NEXTAUTH_SECRET=' .env.local | cut -d= -f2- | tr -d '"') \
  USER_ID="$USER_ID" node -e '
const crypto = require("crypto");
const b64 = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const header = b64({ alg: "HS256", typ: "JWT" });
const payload = b64({ kiloUserId: process.env.USER_ID, apiTokenPepper: null, version: 3 });
const signature = crypto.createHmac("sha256", process.env.NEXTAUTH_SECRET)
  .update(`${header}.${payload}`).digest("base64url");
process.stdout.write(`${header}.${payload}.${signature}`);
')
```

Do not print or log the token. Read the actual Next.js and session-ingest ports from `pnpm dev:status --json`, then run the CLI in its own tmux session:

```bash
CLI_SESSION="kilo-e2e-$(basename "$PWD")"
tmux new-session -d -s "$CLI_SESSION" -c "$PWD"
tmux set-environment -t "$CLI_SESSION" KILO_API_URL http://localhost:<nextjs-port>
tmux set-environment -t "$CLI_SESSION" KILO_SESSION_INGEST_URL http://localhost:<session-ingest-port>
tmux set-environment -t "$CLI_SESSION" KILO_AUTH_CONTENT \
  "$(printf '{"kilo":{"type":"api","key":"%s"}}' "$TOKEN")"
tmux set-environment -t "$CLI_SESSION" KILO_REMOTE 1
tmux set-environment -t "$CLI_SESSION" KILO_CLI_BIN "$CLI_SCRATCH/node_modules/.bin/kilo"
tmux new-window -t "$CLI_SESSION" -n cli -c "$PWD" '"$KILO_CLI_BIN"'
tmux capture-pane -p -t "$CLI_SESSION":cli -S -100
```

The mobile list updates after the CLI WebSocket connects and its first heartbeat (usually about 12 seconds). Use `tmux send-keys` for automation; slash commands need one Enter for autocomplete and another to submit.

## Android Emulator

Follow the [Expo environment guide](https://docs.expo.dev/get-started/set-up-your-environment/) for the one-time Android SDK/JDK setup. This project needs JDK 17. With an AVD already created, keep the emulator in its own tmux session:

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
ANDROID_SESSION="kilo-e2e-android-$(basename "$PWD")"
tmux new-session -d -s "$ANDROID_SESSION" \
  "JAVA_HOME=$JAVA_HOME emulator -avd <avd-name> -no-snapshot-save -no-boot-anim -gpu swiftshader_indirect"
adb wait-for-device
adb reverse tcp:<nextjs-port> tcp:<nextjs-port>
adb reverse tcp:<metro-port> tcp:<metro-port>
cd apps/mobile
npx expo run:android --no-install --no-bundler
```

Android's `localhost` is the emulator, so restore both `adb reverse` mappings after clearing app data. The dev-client scheme is `exp+kilo-app`. `adb shell pm clear com.kilocode.kiloapp` also forgets the Metro URL, so re-open the dev-client URL afterward.

## Cleanup

Clean up only resources you started:

```bash
tmux kill-session -t "$CLI_SESSION"       # if created
tmux kill-session -t "$IOS_BUILD_SESSION" # if created
tmux kill-session -t "$ANDROID_SESSION"   # if created
rm -rf "$CLI_SCRATCH"                     # if created
rm -f "$LOGIN_LOG"                        # if created
pnpm dev:stop                              # only if you started this worktree's stack
xcrun simctl shutdown <udid>               # only if you booted it
```

Also stop recorders, log followers, and emulator processes you created. Never use `tmux kill-server`, kill unrelated `kilo-dev-*` sessions, stop a simulator that was already booted, or use `pnpm dev:stop --force` while sibling worktrees are active.

Verify cleanup:

```bash
pnpm dev:status --json
tmux ls
xcrun simctl list devices booted
```
