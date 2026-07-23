# Mobile E2E Runbook

Use this runbook for interactive verification against a local backend. Run commands from the repository root unless a step says otherwise. The repository dev runner keeps long-lived services in a worktree-specific tmux session; use it instead of loose background processes.

## Fresh Worktree Quickstart

If dependencies or local env files are missing, run this once. It authorizes both worktree `.envrc` files and copies local env files from the primary checkout:

```bash
node --version # must be v24; activate the root .nvmrc first if needed
pnpm dev:worktree:prepare
```

Record pre-existing state so you later clean up only resources you created:

```bash
pnpm dev:status --json
tmux ls
xcrun simctl list devices booted
```

Reuse a complete stack already running for this worktree. Do not start a competing stack or stop an unrelated `kilo-dev-*` session.

Port `23750` is the sole intentional host-wide exception: the repository-managed `kiloclaw-docker-tcp` service is a stateless loopback proxy to the shared Docker socket, and the runner reuses it when the port is occupied. Never kill a `socat` process owned by another worktree to free this port.

When this worktree has no stack, start the complete mobile flow. Secondary worktrees automatically receive an isolated port offset, and mobile startup generates and injects this worktree's LAN URLs before Metro starts. Do not export `KILO_PORT_OFFSET` or source `apps/mobile/.env`; stale parent-shell values must not select the bundle endpoints:

```bash
pnpm dev:env -y cloudflare-session-ingest
pnpm dev:start --no-attach mobile cloud-agent-next kiloclaw event-service
pnpm drizzle migrate
pnpm dev:status --json
```

Notes:

- The `dev:env` step creates the JWT Secrets Store binding. Without it the session-ingest worker looks healthy while rejecting every session request.
- `event-service` is required for presence and notification behavior.
- Secrets Store state is local to each Worker directory. `dev:start` syncs env for its service graph and refreshes every source-backed secret before launching Workers; a secret creation failure is fatal.
- Never run bare `wrangler secrets-store` commands. Use `pnpm dev:env -y <group>` from the repository root so values come from the canonical local source and Wrangler gets a complete non-interactive prompt.
- Confirm `mobile`, `nextjs`, `cloudflare-session-ingest`, `cloud-agent-next`, `kiloclaw`, and `event-service` are `up`. Restarts are asynchronous: if `mobile` is still starting, inspect its log and rerun status instead of restarting the stack.
- Use the ports reported by `dev:status`; never assume defaults in a secondary worktree.

### Host Networking Safety

- Never map port `8081` or any other shared host port to a worktree Metro port.
- Except for the `23750` proxy above, never create ad hoc proxies, redirects, tunnels, NAT rules, or listeners to repair stale Expo state.
- If an exact development-client URL reconnect fails, perform at most one supported recovery through the existing preflight and launch flow. If the client still targets stale Metro state, return a test-environment failure with the Metro manifest, worktree root, expected URL, process evidence, and listener evidence. Do not route around bundle-provenance validation.
- If an unexpected listener exists, report its PID, parent PID, command, bind address, and port. Stop it only when you can prove the current invocation created it; otherwise return the ownership evidence to the orchestrator.

## Logs and tmux

Prefer the stable log files, and let the runner locate a service pane wherever the dashboard moved it:

```bash
pnpm dev:status --json
tail -n 200 dev/logs/<service>.log
pnpm dev:capture mobile
```

- Never guess a tmux window from `tmux ls` or address `<session>:<service>` directly; a service pane may be joined into the dashboard with no same-named window. Use `pnpm dev:capture <service>` for inspection.
- Use raw tmux only for an interactive process, after reading the exact `session` from `pnpm dev:status --json` and resolving the pane with `tmux list-panes -a`.
- Put any extra long-lived CLI, recorder, or log follower in a clearly named `kilo-e2e-*` tmux session so it is visible and easy to remove.
- E2E fixtures must never be committed. Create generated fixtures in a temporary directory (`mktemp -d`), run the flow against it, and delete it before finishing.

## iOS Simulator

Never share a simulator with another worktree. Claim one before any build, install, login, Maestro, or MCP action; the claim command prefers an unclaimed shutdown iPhone and boots it. A prewarm verifier uses `--phase prewarm`; the fresh acceptance verifier reclaims the same worktree-owned device with `--phase verify`:

```bash
pnpm dev:mobile:simulator claim [udid] --phase prewarm
pnpm dev:mobile:simulator claim [udid] --phase verify
```

The wrapper visibly renames a claimed device to `Kilo E2E - <sanitized-worktree-basename> - <phase>` and restores the original simulator name on release. Never call `xcrun simctl rename` directly.

Install a validated cached native build. A compatible fingerprint skips rebuilding; a cache miss is serialized through the host-wide native compiler semaphore. Do not consume an arbitrary DerivedData app or run a separate Expo native build:

```bash
pnpm dev:mobile:ios build <udid>
```

Connect the app to the Metro URL shown by this worktree's `mobile` pane:

```bash
xcrun simctl openurl <udid> \
  "exp+kilo-app://expo-development-client/?url=http%3A%2F%2F<lan-ip>%3A<metro-port>"
```

Prefer `xcrun simctl openurl` for scheme reconnection: it avoids Safari's external-app confirmation. When an acceptance flow intentionally goes through Safari or a WebView, inspect the hierarchy for the exact message `Open this page in "Kilo"?` and tap the exact `Open` accessibility action. This is one bounded optional prompt inside the existing five-second optional-prompt budget, not permission to add another fixed wait.

Before testing, capture the `mobile` pane and verify `Starting project at <this-worktree>/apps/mobile` plus a fresh `iOS Bundled` line. Seeing the Kilo login screen does not prove bundle provenance. The login preflight additionally reads Metro's development manifest and checks `expoConfig.extra.apiBaseUrl` and `_internal.projectRoot` against this worktree. A dev client gets these extras from the Metro manifest, so after env changes: regenerate env, restart Metro, reconnect the dev client to the exact Metro URL, and reload. Rebuild only when native config or plugins changed.

The shared launch flows dismiss the clean-install tracking alert, accept the Expo dev-menu introduction with `Continue`, and close the full Expo/React Native developer menu (the one containing Fast Refresh and Element Inspector) with its `Close` accessibility action.

## Sign In and Out

Backend and Metro must be running. These idempotent wrappers verify simulator ownership, required services, the generated API port, and Metro project provenance, then reconnect the dev client to this worktree's exact Metro URL before Maestro runs. Never bypass their preflight or call the YAML login steps directly:

```bash
apps/mobile/e2e/login.sh <udid> [email]  # default: e2e-mobile+<worktree-basename>@example.com
apps/mobile/e2e/logout.sh <udid>
```

The default email is unique per worktree (`e2e-mobile+<worktree-basename>@example.com`), so concurrent worktrees sign into distinct backend users and never cross-pollute each other's sessions. Pass an explicit email only when a test needs a specific account.

Login requests an email OTP, waits up to 30 seconds for the worktree-local outbox, verifies the code, accepts first-account consent, and asserts Home. It retries only the known dev-client launch/request boundary once. The wrappers open the exact dev-client URL via preflight, then `flows/settle-app.yaml` handles late tracking and Expo developer-menu prompts without restarting the app. `flows/open-app.yaml` is the standalone cold-launch flow.

Native prompts are states in the flow, not errors to tap through blindly:

- The shared launch flow answers the iOS tracking prompt (`Allow “Kilo” to track your activity across other companies’ apps and websites?`) with `Ask App Not to Track`.
- Login handles the notification permission after authentication.
- Handle feature-triggered prompts (speech recognition, microphone) only when the acceptance flow reaches that feature: inspect the hierarchy, copy the exact button accessibility text (`Allow` or `Don’t Allow`), and choose the state the test requires.
- Never use a generic `tapOn: 'Allow'` before identifying which prompt is visible.

Maestro can emit a large interactive transcript. For agent-driven runs, keep successful output out of context and show only a bounded failure tail:

```bash
LOGIN_LOG=$(mktemp /tmp/kilo-login.XXXXXX)
apps/mobile/e2e/login.sh <udid> >"$LOGIN_LOG" 2>&1 || \
  { tail -n 100 "$LOGIN_LOG"; false; }
```

When editing the flows, preserve these device-tested constraints:

- Tap the Kilo home-screen icon; Maestro `launchApp` can bounce the Expo dev client to SpringBoard.
- Pass `EMAIL` and `OTP` with `-e`; flow-level defaults override `-e` values in the installed Maestro version.
- Target the email field by its placeholder `you@example.com`, and tap `Verify code` without trying to dismiss the number pad.
- The native sign-out confirmation is the first case-insensitive `Sign Out` match (`index: 0`).

Seed only when needed. Run `pnpm dev:seed` with no arguments to list every available topic and its usage:

```bash
pnpm dev:seed                                    # list all seed topics
pnpm dev:seed app:user-id <email>                # resolve a user id
pnpm dev:seed app:create-user "<name>" <email>   # create a local user
pnpm dev:seed app:add-credits <user-id> <usd>    # grant credits
pnpm dev:seed app:api-token <email>              # mint a bearer token (used by remote-cli.sh)
```

## Maestro

One-time machine setup: `brew install maestro`. For MCP, use stdio command `maestro mcp`, then restart the agent session so its tools appear.

Rules:

- Use Maestro as the primary automation driver on both iOS and Android. Fall back to `xcrun simctl` (iOS) or repository-wrapped ADB (Android) only when Maestro cannot inspect or operate a native state, or when low-level device control is required. Setup still uses `simctl`/ADB for boot, install, dev-client URL reconnection, screenshots, shutdown, and cleanup.
- Inspect the screen before selecting elements and re-inspect after UI changes.
- Never guess a selector from a visible label or screenshot. Copy the exact `txt` or `a11y` value from `maestro_inspect_screen`, mapping `a11y` to Maestro `text:`. Maestro text matching is full-string regex, not substring matching.
- Tab buttons expose React Navigation's full accessibility labels, not the visible uppercase text. Current iOS labels: `Home, tab, 1 of 4`, `KiloClaw, tab, 2 of 4`, `Agents, tab, 3 of 4`, `Profile, tab, 4 of 4`. `tapOn: 'Agents'` is wrong. Inspect again before relying on these examples; tab count and labels can change.

CLI fallback:

```bash
maestro --device <udid|emulator-5554> test -e KEY=VALUE <flow.yaml>
xcrun simctl io <udid> screenshot <path>      # iOS
adb exec-out screencap -p > <path>            # Android
```

Attach a screenshot of the changed flow to the PR when it helps review. For transitions, prefer a short screenshot loop over `simctl io recordVideo`, which can produce one-frame recordings.

## Remote CLI Session Flows

Use this only when testing session discovery, mirroring, or mobile-to-CLI messaging. The orchestrator prepares the CLI with a single helper; role agents must not read environment files, mint or accept a bearer token, install the CLI, or run `wrangler` commands.

The orchestrator starts a local CLI as a remote session for this worktree:

```bash
apps/mobile/e2e/remote-cli.sh start [email]
```

The helper resolves this worktree's stack ports from `pnpm dev:status --json`, mints a token for the given user (defaulting to the per-worktree login account, `e2e-mobile+<worktree-slug>@example.com`), installs the CLI into a disposable per-worktree directory, and launches it in a `kilo-e2e-cli-<worktree-slug>` tmux session already pointed at the local API, session-ingest, and event-service. Pass the account the app is signed in as when it differs from the default. Manage it with `remote-cli.sh status` and `remote-cli.sh stop`.

Run any one-off CLI command against the same prepared stack (reusing the token and URLs) with `exec`, instead of the interactive TUI:

```bash
apps/mobile/e2e/remote-cli.sh exec remote              # enable the real-time relay
apps/mobile/e2e/remote-cli.sh exec session list --pure # inspect sessions
apps/mobile/e2e/remote-cli.sh exec run "say hello"     # non-interactive run
```

Role agents reuse the orchestrator-prepared session and verify discovery and mirroring by inspecting its pane and the mobile list:

```bash
CLI_SESSION="kilo-e2e-cli-$(basename "$PWD")"
tmux ls
tmux capture-pane -p -t "$CLI_SESSION" -S -100
```

Drive the session with `tmux send-keys`; slash commands need one Enter for autocomplete and another to submit. Type a prompt to create a session; the mobile list updates after the CLI WebSocket connects and its first heartbeat (about 12 seconds). If no session is prepared for this worktree, stop and ask the orchestrator to run `remote-cli.sh start`.

## Android Emulator

Do not conclude Android is unavailable from `command -v adb` or the inherited `PATH`. The repository resolves the SDK and JDK 17 from `ANDROID_HOME`, `~/Library/Android/sdk`, and standard Homebrew locations. Run the doctor first; it prints resolved absolute paths and available AVDs:

```bash
pnpm dev:mobile:android doctor
```

Use the wrappers for all Android tooling, including the Expo/Gradle build, so the resolved SDK/JDK environment is applied:

```bash
ANDROID_SESSION="kilo-e2e-android-$(basename "$PWD")"
tmux new-session -d -s "$ANDROID_SESSION" -c "$PWD" \
  "pnpm dev:mobile:android emulator -avd <avd-name> -no-snapshot-save -no-boot-anim -gpu swiftshader_indirect"
pnpm dev:mobile:android adb wait-for-device
pnpm dev:mobile:android claim <serial>
pnpm dev:mobile:android adb reverse tcp:<nextjs-port> tcp:<nextjs-port>
pnpm dev:mobile:android adb reverse tcp:<metro-port> tcp:<metro-port>
pnpm dev:mobile:android build <serial>
```

The build command installs a validated cached APK when the Android native fingerprint and toolchain match. Do not install an APK from another output path or invoke Gradle directly.

ADB fallback commands (Maestro remains the primary driver, as above):

```bash
pnpm dev:mobile:android adb devices -l
pnpm dev:mobile:android adb -s <serial> shell uiautomator dump /sdcard/window.xml
pnpm dev:mobile:android adb -s <serial> shell cat /sdcard/window.xml
pnpm dev:mobile:android adb -s <serial> exec-out screencap -p > /tmp/kilo-android.png
pnpm dev:mobile:android adb -s <serial> shell input tap <x> <y>
pnpm dev:mobile:android adb -s <serial> shell input text '<text>'
pnpm dev:mobile:android adb -s <serial> shell input keyevent KEYCODE_BACK
```

Android specifics:

- Derive tap coordinates from the current `uiautomator` bounds, never from screenshots or remembered positions. Re-dump after every navigation or prompt.
- Android's `localhost` is the emulator itself, so restore both `adb reverse` mappings after clearing app data.
- The dev-client scheme is `exp+kilo-app`. `adb shell pm clear com.kilocode.kiloapp` also forgets the Metro URL; re-open the dev-client URL afterward with `adb shell am start`.
- The login/logout helpers accept either an iOS simulator UDID or an Android ADB serial; their shared preflight applies platform-specific ownership checks and reconnects the dev client to this worktree.

## Cleanup

Clean up only resources you started. The remote CLI session and its disposable install belong to the orchestrator; do not kill `kilo-e2e-cli-*` sessions or remove CLI scratch directories you did not create.

```bash
tmux kill-session -t "$ANDROID_SESSION"      # if created
rm -f "$LOGIN_LOG"                           # if created
pnpm dev:stop                                # only if you started this worktree's stack
xcrun simctl shutdown <udid>                 # only if you booted it
pnpm dev:mobile:simulator release <udid>     # release every simulator you claimed
pnpm dev:mobile:android release <serial>     # release every Android device you claimed
```

Also stop recorders, log followers, and emulator processes you created. Never use `tmux kill-server`, kill an unrelated `kilo-dev-*` session, shut down a simulator that was already booted, or use `pnpm dev:stop --force` while sibling worktrees are active.

Verify cleanup, and confirm no generated E2E fixtures remain tracked or untracked:

```bash
pnpm dev:status --json
tmux ls
xcrun simctl list devices booted
git status --short
```
