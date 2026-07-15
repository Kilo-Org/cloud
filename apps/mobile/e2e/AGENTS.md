# Mobile E2E Runbook

Use this runbook for interactive verification against a local backend. Commands run from the repository root unless a step says otherwise. The repository dev runner keeps long-lived services in a worktree-specific tmux session; use it instead of loose background processes.

## Fresh Worktree Quickstart

If dependencies or local env files are missing, run this once. This also authorizes both worktree `.envrc` files and copies local env files from the primary checkout:

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

`kiloclaw-docker-tcp` on port 23750 is the sole intentional host-wide exception: it is a stateless loopback proxy to the same Docker socket. The runner reuses an occupied proxy. Never kill a `socat` process owned by another worktree to free this port.

When this worktree has no stack, start the complete mobile flow. Secondary worktrees automatically receive an isolated port offset, and mobile startup generates and explicitly injects this worktree's LAN URLs before Metro starts. Do not export `KILO_PORT_OFFSET` or source `apps/mobile/.env`; stale parent-shell values must not select the bundle endpoints:

```bash
pnpm dev:env -y cloudflare-session-ingest
pnpm dev:start --no-attach mobile cloud-agent-next kiloclaw event-service
pnpm drizzle migrate
pnpm dev:status --json
```

The session-ingest env step creates the JWT Secrets Store binding; without it the worker can appear healthy while rejecting every session request. `event-service` is required for presence and notification behavior.

Secrets Store state is local to each Worker directory. `dev:start` runs env sync for its selected service graph and refreshes every source-backed secret before launching Workers; secret creation failures are fatal. Do not run bare `wrangler secrets-store` commands: use `pnpm dev:env -y <group>` from the repository root so values come from the canonical local source and Wrangler receives a complete non-interactive prompt.

Confirm `mobile`, `nextjs`, `cloudflare-session-ingest`, `cloud-agent-next`, `kiloclaw`, and `event-service` are `up`. Restarts are asynchronous; if `mobile` is still starting, inspect its log and rerun status instead of restarting the stack. Use reported ports; never assume defaults in a secondary worktree.

## Logs and tmux

Prefer the stable log files. When pane output is required, let the runner find the service wherever the dashboard moved it:

```bash
pnpm dev:status --json
tail -n 200 dev/logs/<service>.log
pnpm dev:capture mobile
```

Do not guess a tmux window from `tmux ls` or use `<session>:<service>` directly; a service pane can be joined into the dashboard and no longer have a same-named window. Use `pnpm dev:capture <service>` for inspection. Use raw tmux only for an interactive process after reading the exact `session` from `pnpm dev:status --json` and resolving the pane with `tmux list-panes -a`.

```bash
tmux ls
tmux list-windows -t <dev-session>
```

Put any extra long-lived CLI, recorder, or log follower in a clearly named `kilo-e2e-*` tmux session so it is visible and easy to remove.

E2E fixtures must never be committed. When a flow needs generated fixture files, create them in a temporary directory such as one returned by `mktemp -d`, run the flow against that directory, and ensure the fixtures and temporary directory are cleaned up before finishing.

## iOS Simulator

Never share a simulator with another worktree. Claim one before any build, install, login, Maestro, or MCP action; the command prefers an unclaimed shutdown device and boots it. Pass a UDID only when intentionally claiming that device:

```bash
pnpm dev:mobile:simulator claim [udid]
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

Before testing, capture the `mobile` pane and verify `Starting project at <this-worktree>/apps/mobile` plus a fresh `iOS Bundled` line. Seeing the Kilo login screen alone does not prove bundle provenance. The login preflight also reads Metro's development manifest and verifies `expoConfig.extra.apiBaseUrl` and `_internal.projectRoot` against this worktree. These endpoint extras come from the Metro manifest in a dev client; after env changes, regenerate env, restart Metro, reconnect the dev client to the exact Metro URL, and reload. Rebuild only when native config/plugins changed. The shared launch flows dismiss the clean-install tracking alert, accept the Expo dev-menu introduction with `Continue`, and then close the full Expo/React Native developer menu containing Fast Refresh and Element Inspector with its `Close` accessibility action.

## Sign In and Out

Backend and Metro must be running. These idempotent wrappers first verify simulator ownership, this worktree's required services, generated API port, and Metro project provenance, then reconnect the dev client to that exact Metro URL before launch. Do not bypass their preflight or call the YAML login steps directly:

```bash
apps/mobile/e2e/login.sh <udid> [email]  # default: e2e-mobile@example.com
apps/mobile/e2e/logout.sh <udid>
```

Login requests an email OTP, waits up to 30 seconds for the worktree-local outbox, verifies it, accepts first-account consent, and asserts Home. It retries only the known dev-client launch/request boundary once. The wrappers use preflight to open the exact dev-client URL, then `flows/settle-app.yaml` handles late tracking and Expo developer-menu prompts without restarting the app. `flows/open-app.yaml` remains the standalone cold-launch flow.

Native prompts are states in the flow, not errors to tap through blindly. The shared launch flow recognizes the iOS tracking prompt (`Allow “Kilo” to track your activity across other companies’ apps and websites?`) and chooses `Ask App Not to Track`; login handles notification permission after authentication. Feature-triggered prompts such as speech recognition and microphone access must be handled only when the acceptance flow reaches that feature: inspect the hierarchy, copy the exact button accessibility text (`Allow` or `Don’t Allow`), and choose the state required by the test. Never use a generic `tapOn: 'Allow'` before identifying which prompt is visible.

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

For MCP use stdio command `maestro mcp`, then restart the agent session so its tools appear. Inspect the screen before selecting elements and re-inspect after UI changes. Never guess a selector from the visible label or screenshot: copy the exact `txt` or `a11y` value from `maestro_inspect_screen`, mapping `a11y` to Maestro `text:`. Maestro text matching is full-string regex, not substring matching.

Use Maestro as the primary iOS automation driver. Fall back to `xcrun simctl` only when Maestro cannot inspect or operate a native state, or when low-level simulator control is required. iOS setup still uses `simctl` for boot, install/uninstall, dev-client URL reconnection, screenshots, shutdown, and cleanup.

Tab buttons are exposed through React Navigation's full accessibility labels, not the visible uppercase text. Current iOS labels are `Home, tab, 1 of 4`, `KiloClaw, tab, 2 of 4`, `Agents, tab, 3 of 4`, and `Profile, tab, 4 of 4`. `tapOn: 'Agents'` is wrong. Inspect again before using these examples because tab count or labels can change.

CLI fallback:

```bash
maestro --device <udid|emulator-5554> test -e KEY=VALUE <flow.yaml>
xcrun simctl io <udid> screenshot <path>      # iOS
adb exec-out screencap -p > <path>            # Android
```

Attach a screenshot of the changed flow to the PR when it helps review. For transitions, prefer a short screenshot loop over `simctl io recordVideo`, which can produce one-frame recordings.

## Remote CLI Session Flows

Use this only when testing session discovery, mirroring, or mobile-to-CLI messaging. The orchestrator mints the user's local auth token, installs the CLI in a disposable directory, and starts it in a `kilo-e2e-cli-$(basename "$PWD")` tmux session with the required API URLs and bearer-token environment already set. Role agents must not read environment files, accept a bearer token, install the CLI, or run `wrangler` commands. Reuse the orchestrator-prepared session and verify session discovery and mirroring by inspecting its pane and the mobile list:

```bash
CLI_SESSION="kilo-e2e-cli-$(basename "$PWD")"
tmux ls
tmux list-windows -t "$CLI_SESSION"
tmux capture-pane -p -t "$CLI_SESSION":cli -S -100
```

Drive the orchestrator-prepared session with `tmux send-keys`; slash commands need one Enter for autocomplete and another to submit. The mobile list updates after the CLI WebSocket connects and its first heartbeat (usually about 12 seconds). If the orchestrator has not prepared a session for this worktree, stop and ask the orchestrator to install the CLI, mint a token, and start the session before exercising CLI flows.

## Android Emulator

Do not conclude that Android is unavailable from `command -v adb` or the agent's inherited `PATH`. The repository resolves the SDK and JDK 17 from `ANDROID_HOME`, `~/Library/Android/sdk`, and standard Homebrew locations. Run the doctor first; it prints resolved absolute paths and available AVDs:

```bash
pnpm dev:mobile:android doctor
```

Use the wrappers for all Android tooling so the resolved SDK/JDK environment is applied, including the Expo/Gradle build:

```bash
ANDROID_SESSION="kilo-e2e-android-$(basename "$PWD")"
tmux new-session -d -s "$ANDROID_SESSION" -c "$PWD" \
  "pnpm dev:mobile:android emulator -avd <avd-name> -no-snapshot-save -no-boot-anim -gpu swiftshader_indirect"
pnpm dev:mobile:android adb wait-for-device
pnpm dev:mobile:android claim <serial>
pnpm dev:mobile:android adb reverse tcp:<nextjs-port> tcp:<nextjs-port>
pnpm dev:mobile:android adb reverse tcp:<metro-port> tcp:<metro-port>
cd apps/mobile
pnpm -w dev:mobile:android build
```

Use Maestro as the primary Android automation driver, matching iOS. Fall back to repository-wrapped ADB when Maestro cannot inspect or operate a native prompt, when direct intent/process control is required, or when diagnosing the emulator itself. Android setup still uses ADB for readiness and port reversal. Use the repository wrapper rather than bare `adb`:

```bash
pnpm dev:mobile:android adb devices -l
pnpm dev:mobile:android adb -s <serial> shell uiautomator dump /sdcard/window.xml
pnpm dev:mobile:android adb -s <serial> shell cat /sdcard/window.xml
pnpm dev:mobile:android adb -s <serial> exec-out screencap -p > /tmp/kilo-android.png
pnpm dev:mobile:android adb -s <serial> shell input tap <x> <y>
pnpm dev:mobile:android adb -s <serial> shell input text '<text>'
pnpm dev:mobile:android adb -s <serial> shell input keyevent KEYCODE_BACK
```

Derive tap coordinates from the current `uiautomator` bounds, not screenshots or remembered positions. Re-dump after every navigation or prompt. Android's `localhost` is the emulator, so restore both `adb reverse` mappings after clearing app data. The dev-client scheme is `exp+kilo-app`. `adb shell pm clear com.kilocode.kiloapp` also forgets the Metro URL, so re-open the dev-client URL afterward with `adb shell am start`.

The existing login/logout helpers accept either an iOS simulator UDID or an Android ADB serial. Their shared preflight applies platform-specific device ownership and reconnects the dev client to this worktree before Maestro runs.

## Cleanup

Clean up only resources you started. The remote CLI session and its disposable install are owned by the orchestrator; do not kill `kilo-e2e-cli-*` sessions or remove CLI scratch directories you did not create:

```bash
tmux kill-session -t "$IOS_BUILD_SESSION" # if created
tmux kill-session -t "$ANDROID_SESSION"   # if created
rm -f "$LOGIN_LOG"                        # if created
pnpm dev:stop                              # only if you started this worktree's stack
xcrun simctl shutdown <udid>               # only if you booted it
pnpm dev:mobile:simulator release <udid>    # release every simulator you claimed
pnpm dev:mobile:android release <serial>     # release every Android device you claimed
```

Also stop recorders, log followers, and emulator processes you created. Never use `tmux kill-server`, kill unrelated `kilo-dev-*` sessions, stop a simulator that was already booted, or use `pnpm dev:stop --force` while sibling worktrees are active.

Verify cleanup:

```bash
pnpm dev:status --json
tmux ls
xcrun simctl list devices booted
git status --short
```

Confirm no generated E2E fixtures remain tracked or untracked in the repository.
