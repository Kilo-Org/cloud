# Mobile E2E Runbook

Interactive verification against a local backend. Run commands from the repository root unless a step says otherwise. Long-lived services live in a worktree-specific tmux session owned by the repository dev runner; use it, never loose background processes.

## Fresh Worktree Quickstart

If dependencies or local env files are missing, run once (authorizes both worktree `.envrc` files and copies local env files from the primary checkout):

```bash
node --version   # must be v24; activate the root .nvmrc first if needed
pnpm dev:worktree:prepare
```

Record pre-existing state so you later clean up only resources you created:

```bash
pnpm dev:status --json
tmux ls
xcrun simctl list devices booted
```

If a complete stack is already running for this worktree, reuse it. Never start a competing stack or stop an unrelated `kilo-dev-*` session.

When other workflows may be running on this machine, acquire a device slot before starting a stack, simulator, or native build, and release it when the device phase ends: `apps/mobile/.kilo/e2e-slot.sh acquire|release <tmux-session>` (see the Local Tooling section of [.kilo/MOBILE_WORKFLOW.md](../.kilo/MOBILE_WORKFLOW.md)).

If this worktree has no stack, start the complete mobile flow:

```bash
pnpm dev:env -y cloudflare-session-ingest
pnpm dev:start --no-attach mobile cloud-agent-next kiloclaw event-service
pnpm drizzle migrate
pnpm dev:status --json
```

Rules:

- Do not export `KILO_PORT_OFFSET` or source `apps/mobile/.env`; stale shell values select the wrong bundle endpoints. Secondary worktrees get an isolated port offset automatically, and startup injects this worktree's LAN URLs before Metro starts.
- The `dev:env` step creates the JWT Secrets Store binding. Without it, session-ingest looks healthy but rejects every session request.
- Secrets Store state is local to each Worker directory. `dev:start` refreshes every source-backed secret for its service graph before launching Workers; a secret-creation failure is fatal, not something to retry past.
- `event-service` is required for presence and notification behavior.
- Never run bare `wrangler secrets-store` commands. Use `pnpm dev:env -y <group>` from the repository root so values come from the canonical local source.
- Confirm `mobile`, `nextjs`, `cloudflare-session-ingest`, `cloud-agent-next`, `kiloclaw`, and `event-service` are `up`. Restarts are asynchronous: if `mobile` is still starting, read its log and rerun status instead of restarting the stack.
- Use the ports reported by `dev:status`. Never assume defaults in a secondary worktree.
- Port `23750` is the only host-wide exception: `kiloclaw-docker-tcp` is a stateless loopback proxy to the shared Docker socket, and the runner reuses it when the port is occupied. Never kill a `socat` process owned by another worktree.

### Host Networking Safety

- Never map port `8081` or any other shared host port to a worktree Metro port.
- Except for the `23750` proxy above, never create proxies, redirects, tunnels, NAT rules, or listeners to repair stale Expo state.
- If reconnecting to the exact dev-client URL fails, perform at most one supported recovery through the existing preflight and launch flow. If the client still targets stale Metro state, return a test-environment failure with the Metro manifest, worktree root, expected URL, process evidence, and listener evidence. Do not route around bundle-provenance validation.
- If an unexpected listener exists, report its PID, parent PID, command, bind address, and port. Stop it only when you can prove your invocation created it; otherwise return the ownership evidence to the orchestrator.

## Logs and tmux

```bash
pnpm dev:status --json
tail -n 200 dev/logs/<service>.log
pnpm dev:capture mobile
```

- Never guess a tmux window from `tmux ls` or address `<session>:<service>` directly; a service pane may be joined into the dashboard with no same-named window. Use `pnpm dev:capture <service>`.
- Use raw tmux only for an interactive process, after reading the exact `session` from `pnpm dev:status --json` and resolving the pane with `tmux list-panes -a`.
- Put any extra long-lived CLI, recorder, or log follower in a clearly named `kilo-e2e-*` tmux session so it is visible and easy to remove.
- Never commit E2E fixtures. Generate them in a temporary directory (`mktemp -d`) and delete it before finishing. Committed harness code under `e2e/` (this directory's `login.sh`, `preflight.sh`, `remote-cli.sh`, and `github-api-stub/`) is not a generated fixture; the rule targets per-run generated data only.

## Hermetic PR-review GitHub stub

PR-review E2E needs a local GitHub API instead of `api.github.com`. Three steps, all reversible:

1. Set `GITHUB_API_BASE_URL` in the **worktree root** `.env.local` to the stub's base URL (for example `http://127.0.0.1:<port>`). Next.js reads it via `apps/web/src/lib/github-pr-review/client.ts` (the web `dev` script symlinks root `.env.local` into `apps/web/` when that file is missing). Remove the variable after the run.
2. Seed a GitHub user token with the dev-only tRPC mutation `githubApps.devSeedUserGithubToken`. Any non-empty token string works. Use the stable fake `githubUserId` `999001` so the upsert matches across worktrees; a `false` upsert result means a sibling already seeded it, not failure.
3. Start the stub in a `kilo-e2e-*` tmux session, for example:
   `tmux new-session -d -s "kilo-e2e-github-stub-$(basename "$PWD")" -c "$PWD/apps/mobile/e2e/github-api-stub" "node server.mjs <port>"`.
   Stop that session when finished. Request logs go to `GITHUB_STUB_LOG` or `./github-api-stub-requests.log` under the process cwd — keep them out of the tree (temp dir) and delete them after the run.

Pinned surface only: REST pull/repo/check-runs/statuses plus GraphQL ops `PrReviewDecision`, `PrReviewThreads`, `PrReviewThreadComments`, `PrReviewConversationComments`. Fixture identities: `kilo-stub/discussion-mixed#1`, `kilo-stub/discussion-conversation-only#2`, `kilo-stub/discussion-empty#3`.

## iOS Simulator

Never share a simulator with another worktree. Claim one before any build, install, login, Maestro, or MCP action; the claim command prefers an unclaimed shutdown iPhone and boots it:

```bash
pnpm dev:mobile:simulator claim [udid] --phase prewarm   # prewarm verifier
pnpm dev:mobile:simulator claim [udid] --phase verify    # fresh acceptance verifier reclaims the same device
```

The wrapper renames the claimed device to `Kilo E2E - <sanitized-worktree-basename> - <phase>` and restores the original name on release. Never call `xcrun simctl rename` yourself.

Install a validated cached native build. A compatible fingerprint skips rebuilding; a cache miss serializes through the host-wide native compiler semaphore. Never install an arbitrary DerivedData app or run a separate Expo native build:

```bash
pnpm dev:mobile:ios build <udid>
```

Connect the app to the Metro URL shown by this worktree's `mobile` pane:

```bash
xcrun simctl openurl <udid> \
  "exp+kilo-app://expo-development-client/?url=http%3A%2F%2F<lan-ip>%3A<metro-port>"
```

- Prefer `simctl openurl` for scheme reconnection; it skips Safari's external-app confirmation. When a flow intentionally goes through Safari or a WebView, look for the exact message `Open this page in "Kilo"?` and tap the exact `Open` accessibility action — one bounded optional prompt inside the existing five-second optional-prompt budget, never a new fixed wait.
- Before testing, capture the `mobile` pane and verify `Starting project at <this-worktree>/apps/mobile` plus a fresh `iOS Bundled` line. Seeing the Kilo login screen does not prove the bundle came from this worktree.
- The dev client reads `expoConfig.extra.apiBaseUrl` and `_internal.projectRoot` from Metro's manifest; the login preflight checks both against this worktree. After env changes: regenerate env, restart Metro, reconnect the dev client to the exact Metro URL, and reload. Rebuild only when native config or plugins changed.
- The shared launch flows dismiss the clean-install tracking alert, accept the Expo dev-menu introduction with `Continue`, and close the full developer menu (Fast Refresh / Element Inspector) with its `Close` accessibility action.

## Sign In and Out

Backend and Metro must be running. These idempotent wrappers verify simulator ownership, required services, the generated API port, and Metro project provenance, then reconnect the dev client to this worktree's exact Metro URL before Maestro runs. Never bypass their preflight or call the login YAML flows directly:

```bash
apps/mobile/e2e/login.sh <udid> [email]   # default: e2e-mobile-<worktree-basename>@example.com
apps/mobile/e2e/logout.sh <udid>
```

The default email is `e2e-mobile-<worktree-basename>@example.com`, derived deterministically from the worktree directory name. Hyphens are preserved by `normalizeEmail`, so each worktree signs into a distinct backend user. Pass an explicit email only when a test needs a specific account.

Login requests an email OTP, waits up to 30 seconds for the worktree-local outbox, verifies the code, accepts first-account consent, and asserts Home. It retries the known dev-client launch boundary once. `flows/settle-app.yaml` handles late tracking and Expo developer-menu prompts without restarting the app; `flows/open-app.yaml` is the standalone cold-launch flow.

Native prompts are states in the flow, not errors to tap through blindly:

- The shared launch flow answers the iOS tracking prompt with `Ask App Not to Track`.
- Login handles the notification permission after authentication.
- Feature-triggered prompts (speech recognition, microphone): handle only when the flow reaches that feature. Inspect the hierarchy, copy the exact button accessibility text (`Allow` or `Don’t Allow`), and choose the state the test requires.
- Never use a generic `tapOn: 'Allow'` before identifying which prompt is visible.

Maestro can emit a large interactive transcript. Keep successful output out of context; show only a bounded failure tail:

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

Seed only when needed. `pnpm dev:seed` with no arguments lists every topic and its usage:

```bash
pnpm dev:seed app:user-id <email>                # resolve a user id
pnpm dev:seed app:create-user "<name>" <email>   # create a local user
pnpm dev:seed app:add-credits <user-id> <usd>    # grant credits
pnpm dev:seed app:api-token <email>              # mint a bearer token (used by remote-cli.sh)
```

## Maestro

One-time machine setup: `brew install maestro`. For MCP, use stdio command `maestro mcp`, then restart the agent session so its tools appear.

- Maestro is the primary automation driver on both iOS and Android. Fall back to `xcrun simctl` (iOS) or repository-wrapped ADB (Android) only when Maestro cannot inspect or operate a native state, or when low-level device control is required. Setup still uses `simctl`/ADB for boot, install, dev-client URL reconnection, screenshots, shutdown, and cleanup.
- Inspect the screen before selecting elements; re-inspect after UI changes.
- Never guess a selector from a visible label or screenshot. Copy the exact `txt` or `a11y` value from `maestro_inspect_screen` (`a11y` maps to Maestro `text:`). Maestro text matching is full-string regex, not substring.
- Tab buttons expose React Navigation's full accessibility labels, not the visible uppercase text. Current iOS labels: `Home, tab, 1 of 4`, `KiloClaw, tab, 2 of 4`, `Agents, tab, 3 of 4`, `Profile, tab, 4 of 4`. `tapOn: 'Agents'` is wrong. Inspect again before relying on these examples; the count and labels can change.

CLI fallback:

```bash
maestro --device <udid|emulator-5554> test -e KEY=VALUE <flow.yaml>
xcrun simctl io <udid> screenshot <path>      # iOS
adb exec-out screencap -p > <path>            # Android
```

Attach a screenshot of a changed flow to the PR when it helps review. For transitions, prefer a short screenshot loop over `simctl io recordVideo`, which can produce one-frame recordings.

## Remote CLI Session Flows

Use this only when testing session discovery, mirroring, or mobile-to-CLI messaging. The orchestrator prepares the CLI; role agents never read environment files, mint or accept a bearer token, install the CLI, or run `wrangler` commands.

The orchestrator starts a local CLI as a remote session for this worktree:

```bash
apps/mobile/e2e/remote-cli.sh start [email]
```

The helper resolves this worktree's stack ports, mints a token for the given user (default: the per-worktree login account, `e2e-mobile-<worktree-slug>@example.com`), installs the CLI into a disposable per-worktree directory, and launches it in a `kilo-e2e-cli-<worktree-slug>` tmux session already pointed at the local API, session-ingest, and event-service. Pass the account the app is signed in as when it differs from the default. Manage it with `remote-cli.sh status` and `remote-cli.sh stop`.

Run any one-off CLI command against the same prepared stack with `exec` instead of the interactive TUI:

```bash
apps/mobile/e2e/remote-cli.sh exec remote              # enable the real-time relay
apps/mobile/e2e/remote-cli.sh exec session list --pure # inspect sessions
apps/mobile/e2e/remote-cli.sh exec run "say hello"     # non-interactive run
```

Role agents reuse the orchestrator-prepared session and verify discovery and mirroring by inspecting its pane and the mobile list:

```bash
CLI_SESSION="kilo-e2e-cli-$(basename "$PWD")"
tmux capture-pane -p -t "$CLI_SESSION" -S -100
```

Drive the session with `tmux send-keys`; slash commands need one Enter for autocomplete and another to submit. Type a prompt to create a session; the mobile list updates after the CLI WebSocket connects and its first heartbeat (about 12 seconds). If no session is prepared for this worktree, stop and ask the orchestrator to run `remote-cli.sh start`.

## Android Emulator

Do not conclude Android is unavailable from `command -v adb` or the inherited `PATH`. The repository resolves the SDK and JDK 17 from `ANDROID_HOME`, `~/Library/Android/sdk`, and standard Homebrew locations. Run the doctor first; it prints resolved absolute paths and available AVDs:

```bash
pnpm dev:mobile:android doctor
```

Use the wrappers for all Android tooling, including the Expo/Gradle build, so the resolved SDK/JDK environment is applied. Ordered glue: acquire e2e slot → launch emulator → bounded boot wait (serial discovered at visibility) → `claim` → `build` → `login.sh`. Never unbounded `adb wait-for-device`. Never put manual `adb reverse` or dev-client `am start` on the primary path — `login.sh` preflight does both.

### Launch and GPU policy

Two launch attempts total, then a test-environment blocker with the tail of `$EMULATOR_LOG`. Attempt 1 uses `-gpu host` (Mac GPU; fastest; software rendering competes for the CPU under parallel-workflow load). Keep `-no-snapshot-save -no-boot-anim` on every launch. Attempt 2 switches GPU only on an observed process-death signal (`pgrep -f "qemu.*<avd-name>"` empty, or the log shows the emulator exiting/erroring — the pane mirrors it live but dies with the session) → `-gpu swiftshader_indirect`. If the process is still alive but the boot envelope expired → repeat `-gpu host`. Never a third launch.

```bash
# After e2e-slot acquire (see Fresh Worktree Quickstart)
ANDROID_SESSION="kilo-e2e-android-$(basename "$PWD")"
EMULATOR_LOG="/tmp/${ANDROID_SESSION}.log"
GPU_FLAG=host   # attempt 2: swiftshader_indirect only after process death; else host again
tmux new-session -d -s "$ANDROID_SESSION" -c "$PWD" \
  "pnpm dev:mobile:android emulator -avd <avd-name> -no-snapshot-save -no-boot-anim -gpu $GPU_FLAG 2>&1 | tee \"$EMULATOR_LOG\""
```

### Bounded boot wait

From the moment of launch, poll about every 15 s until the envelope expires. Cold boot on an idle host ≈ 1–3 minutes; under parallel-workflow load allow up to 8 minutes before declaring the attempt failed (relaunch-rule bounds, not SLAs). Each poll, check in order:

1. **Liveness** — `pgrep -f "qemu.*<avd-name>"` still prints a PID. If empty, the attempt failed with the process-death signal.
2. **Visibility** — device appears with state `device` in `pnpm dev:mobile:android adb devices -l` (this is where the serial is discovered; a single local emulator is `emulator-5554`).
3. **Readiness** — once visible, `pnpm dev:mobile:android adb -s <serial> shell getprop sys.boot_completed` prints `1`.

Device visibility is not readiness. Never gate on `adb devices` output alone, and never wait on any one stage without the liveness check.

### Failed attempt → kill hard → relaunch once

On failure: `tmux kill-session -t "$ANDROID_SESSION" 2>/dev/null` (session may already be gone if the emulator exited), then confirm the emulator process is actually gone — `pgrep -f "qemu.*<avd-name>"` prints nothing. If it survives: with a known serial, `pnpm dev:mobile:android adb -s <serial> emu kill`; with no serial yet (process died or never became visible to adb), `pkill -f "qemu.*<avd-name>"`. Re-check `pgrep` either way — a surviving emulator holds the AVD lock and dooms any relaunch. Then relaunch once per the GPU policy with the same envelope. If the second attempt also fails to boot, stop and return a test-environment blocker with the tail of `$EMULATOR_LOG` (survives session death; never a third launch, never an early give-up).

### Claim, build, login

```bash
pnpm dev:mobile:android claim <serial>
pnpm dev:mobile:android build <serial>   # validated cached APK only
apps/mobile/e2e/login.sh <serial>
```

`build` installs a validated cached APK when the Android native fingerprint and toolchain match. Never install an APK from another output path or invoke Gradle directly. Reinstall via `build <serial>` only when the native fingerprint changed, never to reset app state.

`login.sh` and `logout.sh` accept an iOS simulator UDID or an Android ADB serial. On Android, `login.sh`'s shared preflight verifies the claim, applies both `adb reverse` mappings (the `nextjs` service's API port and the `mobile` service's Metro port, both from `pnpm dev:status --json` — there is no service named `metro`), and opens the dev-client deep link itself. On the primary path no manual reverse or `am start` is needed.

### Mid-test recovery

`pnpm dev:mobile:android adb -s <serial> shell pm clear com.kilocode.kiloapp` resets app state and forgets the saved Metro URL. Afterwards, either rerun `apps/mobile/e2e/login.sh <serial>` (restores claim check, both reverses, and the deep link), or manually restore both reverses and re-open the dev client:

```bash
# Ports from pnpm dev:status --json: nextjs = API, mobile = Metro (not a service named metro)
pnpm dev:mobile:android adb -s <serial> reverse tcp:<nextjs-port> tcp:<nextjs-port>
pnpm dev:mobile:android adb -s <serial> reverse tcp:<metro-port> tcp:<metro-port>
pnpm dev:mobile:android adb -s <serial> shell am start -a android.intent.action.VIEW \
  -d "exp+kilo-app://expo-development-client/?url=<url-encoded-metro-url>"
```

Use the exact Metro URL from the `mobile` pane. Android's `localhost` is the emulator itself — reverses are required for host reachability.

### App Links

```bash
pnpm dev:mobile:android adb -s <serial> shell am start -a android.intent.action.VIEW -d "https://<host>/<path>"
```

Drives a real App Link through Android intent resolution.

### ADB fallback (Maestro stays primary)

Derive tap coordinates from the current `uiautomator` bounds, never from screenshots or remembered positions. Re-dump after every navigation or prompt.

```bash
pnpm dev:mobile:android adb devices -l
pnpm dev:mobile:android adb -s <serial> shell uiautomator dump /sdcard/window.xml
pnpm dev:mobile:android adb -s <serial> shell cat /sdcard/window.xml
pnpm dev:mobile:android adb -s <serial> exec-out screencap -p > /tmp/kilo-android.png
pnpm dev:mobile:android adb -s <serial> shell input tap <x> <y>
pnpm dev:mobile:android adb -s <serial> shell input text '<text>'
pnpm dev:mobile:android adb -s <serial> shell input keyevent KEYCODE_BACK
```

## Cleanup

Clean up only resources you started. The remote CLI session and its disposable install belong to the orchestrator; never kill `kilo-e2e-cli-*` sessions or remove CLI scratch directories you did not create.

```bash
tmux kill-session -t "$ANDROID_SESSION"      # if created
rm -f "$LOGIN_LOG"                           # if created
rm -f "$EMULATOR_LOG"                        # if created
pnpm dev:stop                                # only if you started this worktree's stack
xcrun simctl shutdown <udid>                 # only if you booted it
pnpm dev:mobile:simulator release <udid>     # every simulator you claimed
pnpm dev:mobile:android release <serial>     # every Android device you claimed
apps/mobile/.kilo/e2e-slot.sh release <tmux-session>   # if you acquired a device slot
```

Also stop recorders, log followers, and emulator processes you created. Never use `tmux kill-server`, kill an unrelated `kilo-dev-*` session, shut down a simulator that was already booted, or use `pnpm dev:stop --force` while sibling worktrees are active.

Verify cleanup, and confirm no generated E2E fixtures remain tracked or untracked:

```bash
pnpm dev:status --json
tmux ls
xcrun simctl list devices booted
git status --short
```
