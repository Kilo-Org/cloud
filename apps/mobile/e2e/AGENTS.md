# Mobile E2E Runbook

Interactive verification against a local backend. Run commands from the repository root unless a step says otherwise. Long-lived services live in a worktree-specific tmux session owned by the repository dev runner; use it, never loose background processes.

## E2E Bundle: Required First Step

E2E device/stack work is owned by one process per round. That owner starts every
resource, records the platform scope and ready device identifiers, then stops
everything it started before leaving. Default platform scope is **iOS-only**;
run Android only when the change touches platform-specific paths or a prior
platform-specific defect exists, and record that rationale.

## Fresh Worktree Quickstart

If dependencies or local env files are missing, run once (authorizes both worktree `.envrc` files and copies local env files from the primary checkout):

```bash
node --version   # must be v24; activate the root .nvmrc first if needed
pnpm dev:worktree:prepare
```

Missing local env values: the human bootstrap is `pnpm dev:setup-env`. Test users, credits, and API tokens: `pnpm dev:seed` (no args lists topics).

Record pre-existing state so you later clean up only resources you own:

```bash
pnpm dev:status --json
tmux ls
xcrun simctl list devices booted
```

Reuse an existing stack only when it belongs to this worktree (same
`kilo-dev-<slug>` session). An unaccounted stack whose slug matches this
worktree's basename is yours: stop it with `pnpm dev:stop`, then start fresh. An
unaccounted stack from another worktree is not yours — leave it alone and never
stop an unrelated `kilo-dev-*` session.

If this worktree has no stack, the bundle owner starts the complete mobile flow:

```bash
pnpm dev:env -y cloudflare-session-ingest
pnpm dev:start --no-attach --reuse-running mobile cloud-agent-next kiloclaw event-service
pnpm drizzle migrate
```

Confirm services are up with `pnpm dev:status --json`. Refresh the session-ingest
Secrets Store binding before start when the worktree is fresh.

iOS claim+build (idempotent per worktree):

```bash
CLAIM=$(pnpm -s dev:mobile:simulator claim)
UDID=$(printf '%s' "$CLAIM" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).device.id)')
pnpm dev:mobile:ios build "$UDID"
```

Android (only with a recorded dual-platform rationale): start, claim, build via
`pnpm dev:mobile:android` (see Android section). Generated `apps/mobile/{ios,android}`
trees are gitignored; prebuild runs when missing.

Rules:

- Do not export `KILO_PORT_OFFSET` or source `apps/mobile/.env`; stale shell values select the wrong bundle endpoints. Secondary worktrees get an isolated port offset automatically, and startup injects this worktree's LAN URLs before Metro starts. When the automatic offset lands on occupied ports (AirPlay on 5000/7000, another worktree's stack), `dev:start` probes for a free offset itself and persists it before services launch; later `dev:restart`/`dev:env` reuse the persisted value, so no manual prefix is needed. A per-command `KILO_PORT_OFFSET=<n>` prefix still overrides everything when you must pin one — never `export` it.
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
2. Seed a GitHub user token with the dev-only tRPC mutation `githubApps.devSeedUserGithubToken` (the PR-review entry screen only shows the URL input once the user has a token row). Authenticate curl as the E2E user via next-auth fake-login with a cookie jar: `GET /api/auth/csrf`, then `POST /api/auth/callback/fake-login` with `csrfToken`, `email`, and `json=true`, then `POST /api/trpc/githubApps.devSeedUserGithubToken` with the jar. Any non-empty token string works. Use a FRESH random `githubUserId` (e.g. `9$(date +%s | tail -c 6)` — the stub never validates it): all worktrees share one postgres, `github_user_id` is unique, and the upsert's conflict target is `(kilo_user_id, github_app_type)`, so reusing a sibling's id errors with a raw drizzle duplicate-key insert instead of returning `false`. Relaunch the app afterwards so the connection query refetches.
3. Start the stub in a `kilo-e2e-*` tmux session, for example:
   `tmux new-session -d -s "kilo-e2e-github-stub-$(basename "$PWD")" -c "$PWD/apps/mobile/e2e/github-api-stub" "node server.mjs <port>"`.
   Stop that session when finished. Request logs go to `GITHUB_STUB_LOG` or `./github-api-stub-requests.log` under the process cwd — keep them out of the tree (temp dir) and delete them after the run.

If the app stalls on "GitHub connection expired" with nextjs logging repeated
`githubPrReview.getPullRequest 412` and the stub log shows only the first fetch,
git-token-service is missing its per-worktree Secrets Store binding:
`pnpm dev:env -y cloudflare-git-token-service && pnpm dev:restart cloudflare-git-token-service`.
Note nextjs reads `GIT_TOKEN_SERVICE_API_URL` from `apps/web/.env.development.local`, not root `.env.local`.

Pinned surface only: REST pull/repo/check-runs/statuses/`pulls/{n}/files` (paginated via `page`/`per_page`) plus GraphQL ops `PrReviewDecision`, `PrReviewThreads`, `PrReviewThreadComments`, `PrReviewConversationComments`. Fixture identities: `kilo-stub/discussion-mixed#1`, `kilo-stub/discussion-conversation-only#2`, `kilo-stub/discussion-empty#3`.

## iOS Simulator

The bundle owner claims and builds before dispatch. The start wrapper does both
in one command; never share a simulator with another worktree. The claim command
prefers an unclaimed shutdown iPhone and boots it:

```bash
pnpm dev:mobile:simulator claim [udid]   # claim (+ boot); then build
pnpm dev:mobile:ios build <udid>
pnpm dev:mobile:simulator release-all    # this worktree's claims; powers off what it booted
```

The wrapper renames the claimed device to `Kilo E2E - <sanitized-worktree-basename>` and restores the original name on release. Never call `xcrun simctl rename` yourself. The claim also records whether it was the thing that booted the device, which is what lets release power off only the devices it started — so never boot or shut down an E2E simulator with `xcrun simctl` behind the wrapper's back. A claim is stale — and silently reclaimable — once its owning worktree is deleted. A claim killed mid-boot boots the Shutdown device again on reclaim automatically; give claims a >=10-minute timeout under parallel-workflow load (booting is slow).

Install a validated cached native build. A compatible fingerprint skips
rebuilding; a cache miss serializes through the host-wide native compiler
semaphore. Never install an arbitrary DerivedData app or run a separate Expo
native build:

```bash
pnpm dev:mobile:ios build <udid>
```

Connect the app to the Metro URL shown by this worktree's `mobile` pane:

```bash
xcrun simctl openurl <udid> \
  "exp+kilo-app://expo-development-client/?url=http%3A%2F%2F<lan-ip>%3A<metro-port>"
```

Never append an app route to the dev-client `url` param — the dev client treats the whole param as the Metro packager root and the manifest fetch 404s. Connect with the BARE Metro URL, wait for `iOS Bundled`, then drive routes via `xcrun simctl openurl <udid> "kiloapp://<route>"` (app scheme `kiloapp`, no SpringBoard confirmation) — only after cold-boot finishes; a link fired during boot is dropped.

- Prefer `simctl openurl` for scheme reconnection; it skips Safari's external-app confirmation. Since universal links (`associatedDomains`) were configured, iOS may instead show a SpringBoard confirmation with the exact message `Open in "Kilo"?` (curly or straight quotes) — the shared launch flows match both wordings and tap `Open`. When a flow intentionally goes through Safari or a WebView, look for the exact message `Open this page in "Kilo"?` and tap the exact `Open` accessibility action — one bounded optional prompt inside the existing five-second optional-prompt budget, never a new fixed wait.
- Before testing, capture the `mobile` pane and verify `Starting project at <this-worktree>/apps/mobile` plus a fresh `iOS Bundled` line. Seeing the Kilo login screen does not prove the bundle came from this worktree.
- The dev client reads `expoConfig.extra.apiBaseUrl` and `_internal.projectRoot` from Metro's manifest; the login preflight checks both against this worktree. After env changes: regenerate env, restart Metro, reconnect the dev client to the exact Metro URL, and reload. Rebuild only when native config or plugins changed.
- The shared launch flows dismiss the clean-install tracking alert, accept the Expo dev-menu introduction with `Continue`, and close the full developer menu (Fast Refresh / Element Inspector) with its `Close` accessibility action.

## Sign In and Out

Backend and Metro must be running. These idempotent wrappers verify simulator ownership, required services, the generated API port, and Metro project provenance, then reconnect the dev client to this worktree's exact Metro URL before Appium runs. Never bypass their preflight or call the flow files directly:

```bash
apps/mobile/e2e/login.sh <udid> [email]   # default: e2e-mobile-<worktree>-<ios|android>@example.com
apps/mobile/e2e/logout.sh <udid>
```

The default email is `e2e-mobile-<worktree-basename>-<ios|android>@example.com`, derived from the worktree and device serial. Parallel platform shards therefore use separate backend users. Pass an explicit email only when a test needs a specific account.

Login requests an email OTP, waits up to 30 seconds for the worktree-local outbox, verifies the code, accepts first-account consent, and asserts Home. If the request half fails it cold-relaunches through `flows/open-app.js` and retries once — that clears both a half-started dev client and an email field left dirty by an earlier run — and if the retry fails too it says which half broke: no outbox email means the app never reached `POST /api/auth/native/otp`, a new outbox email means the request worked and only the code screen was never reached. `flows/settle-app.js` handles late tracking and Expo developer-menu prompts without restarting the app; `flows/open-app.js` is the standalone cold-launch flow.

Native prompts are states in the flow, not errors to tap through blindly:

- The shared launch flow answers the iOS tracking prompt with `Ask App Not to Track`.
- Login handles the notification permission after authentication.
- Feature-triggered prompts (speech recognition, microphone): handle only when the flow reaches that feature. Inspect the hierarchy, copy the exact button accessibility text (`Allow` or `Don’t Allow`), and choose the state the test requires.
- Never use a generic `tapOn: 'Allow'` before identifying which prompt is visible.

Appium can emit a large server and driver transcript. Keep successful output out of context; show only a bounded failure tail:

```bash
LOGIN_LOG=$(mktemp /tmp/kilo-login.XXXXXX)
apps/mobile/e2e/login.sh <udid> >"$LOGIN_LOG" 2>&1 || \
  { tail -n 100 "$LOGIN_LOG"; false; }
```

When editing the flows, preserve these device-tested constraints:

- Pass `EMAIL` and `OTP` with `-e`; the flows require them and fail fast when absent.
- Target the email field by its placeholder `you@example.com`, and tap `Verify code` without trying to dismiss the number pad.
- The email field is uncontrolled, so a login page left on screen by an earlier run still holds its address, and typing inserts at the caret the tap just dropped mid-string. Erase the field first and assert the typed address before submitting; without that, two attempts interleave into one malformed address and the flow dies 15s later on a missing `Verify code`.
- Keep every control a flow taps clear of the keyboard. Taps land on the element's centre, and iOS hands a touch inside `UIRemoteKeyboardWindow` to the keyboard while the driver still reports the tap delivered — a silent no-op. Verify with `e2e/appium.sh <udid> hierarchy`: the control's centre must be above the keyboard window's top bound. The same mechanism creates a dead zone under fixed header chrome; never read a swallowed tap as a product regression.
- The native sign-out confirmation is the first case-insensitive `Sign Out` match (`index: 0`, topmost by position).

Seed only when needed. `pnpm dev:seed` with no arguments lists every topic and its usage:

```bash
pnpm dev:seed app:user-id <email>                # resolve a user id
pnpm dev:seed app:create-user "<name>" <email>   # create a local user
pnpm dev:seed app:add-credits <user-id> <usd>    # grant credits
pnpm dev:seed app:api-token <email>              # mint a bearer token (used by remote-cli.sh)
```

## Foreign Data on Your Device

A hierarchy or screenshot that shows another worktree's data (rows, sessions, searches that cannot belong to the signed-in `e2e-mobile-*` account) is never a product defect on its own. Prove it against the backend first: row ownership in Postgres, this worktree's nextjs/ingest logs, and whether a pull-to-refresh reproduces it. Re-confirm the signed-in account (Profile tab) and Metro provenance before continuing. Backend evidence contradicting the capture means cross-device environment noise: re-run the affected check cleanly and report both.

## Appium + WebdriverIO

Setup is automatic: the repository install provides Appium and the webdriverio client, and the wrapper below installs the XCUITest / UiAutomator2 drivers into a machine-global `APPIUM_HOME` (`~/.cache/kilo-appium`, override with `KILO_APPIUM_HOME`) on first use. Never use MCP automation tools or a hand-rolled driver connection: they bypass the per-device lock; use the repository wrapper.

- Appium is the primary automation driver on both iOS and Android. Fall back to `xcrun simctl` (iOS) or repository-wrapped ADB (Android) only when Appium cannot inspect or operate a native state, or when low-level device control is required. Setup still uses `simctl`/ADB for boot, install, dev-client URL reconnection, and screenshots; the repository wrappers own shutdown and cleanup.
- With more than one device booted (parallel worktrees), always go through `e2e/appium.sh <udid> ...` — it serializes per device (one Appium server per device on a deterministic port, one session at a time), so taps can never silently land on another worktree's device.
- Inspect the screen before selecting elements; re-inspect after UI changes.
- Never guess a selector from a visible label or screenshot. Copy the exact text or accessibility value from `e2e/appium.sh <udid> hierarchy` (writes the XML page source; redirect to a file and grep it). Matching is full-string regex against the element label (iOS) or text / content-desc (Android), not substring.
- Tab buttons expose React Navigation's full accessibility labels, not the visible uppercase text. Current iOS labels: `Home, tab, 1 of 4`, `KiloClaw, tab, 2 of 4`, `Agents, tab, 3 of 4`, `Profile, tab, 4 of 4`. `tapOn('Agents')` is wrong. Inspect again before relying on these examples; the count and labels can change.
- Flows are plain node modules in `e2e/flows/*.js` using the helpers in `e2e/wdio/helpers.js` (`tapOn`, `assertVisible`, `waitVisible`, `inputText`, `eraseText`, `scrollUntilVisible`, `stopApp`/`launchApp`, `when`/`whenNot`). A failed helper throws and the process exit code is the verdict — no report files to inspect.

CLI usage — always through `e2e/appium.sh`, which serializes per device (two concurrent sessions against one UDID interleave taps and fail flows in ways that read as product defects):

```bash
apps/mobile/e2e/appium.sh <udid|emulator-5554> test -e KEY=VALUE <flow.js> [more-flows.js]
apps/mobile/e2e/appium.sh <udid> hierarchy > /tmp/hierarchy.xml
```

One `appium.sh <device> test` invocation accepts multiple flow files and runs them on **one** WebDriver session. Session startup is the dominant per-command cost, so a verifier plans its route and batches flows into as few invocations as possible. Batching applies to verifier-written flows; `login.sh` / `logout.sh` keep their per-call sessions. The Appium server per device already persists across invocations for the bundle's lifetime; stop it during bundle cleanup with `apps/mobile/e2e/appium.sh <udid> server stop`.

### Video-first evidence

Record each flow segment (not the whole route) with `record.sh`. Extract frames at the timestamps the flow hit — simctl videos are variable-frame-rate, so a static screen legitimately yields few frames. Android `screenrecord` caps at ~3 minutes (`--time-limit 170`); segment recordings, never one whole-route video. Keep screenshots for ad-hoc stills.

```bash
apps/mobile/e2e/record.sh <udid|serial> start <video-path>
apps/mobile/e2e/record.sh <udid|serial> stop
apps/mobile/e2e/record.sh frame <video-path> <hh:mm:ss> <out.png>
xcrun simctl io <udid> screenshot <path>      # iOS still
pnpm dev:mobile:android adb -s <serial> exec-out screencap -p > <path>  # Android still
```

`stop` is idempotent. The bundle owner runs `record.sh <device> stop` for every bundle device before `pnpm dev:mobile:simulator release-all` / `pnpm dev:mobile:android emulator-stop` (also reaps a recorder orphaned by a crashed verifier).

## Remote CLI Session Flows

Use this only when testing session discovery, mirroring, or mobile-to-CLI messaging. The orchestrator prepares the CLI; role agents never read environment files, mint or accept a bearer token, install the CLI, or run `wrangler` commands.

The orchestrator starts a local CLI as a remote session for this worktree:

```bash
apps/mobile/e2e/remote-cli.sh start <email>
```

The helper resolves this worktree's stack ports, mints a token for the given user, installs the CLI into a disposable per-worktree directory, and launches it in a `kilo-e2e-cli-<worktree-slug>` tmux session already pointed at the local API, session-ingest, and event-service. The email is required — pass the account the app is signed in as (`login.sh`'s default is `e2e-mobile-<worktree-slug>-<ios|android>@example.com`). Manage it with `remote-cli.sh status` and `remote-cli.sh stop`.

Run any one-off CLI command against the same prepared stack with `exec` instead of the interactive TUI:

```bash
apps/mobile/e2e/remote-cli.sh exec session list --pure # inspect sessions
apps/mobile/e2e/remote-cli.sh exec run "say hello"     # non-interactive run
```

The real-time relay (`remote`) blocks until SIGTERM — a one-shot `exec remote` exits and the relay dies with it. Run it persistently in its own `kilo-e2e-*` tmux window (or send `/remote` to the running TUI session) and keep it alive for the whole flow.

`-m` takes CLI provider/model ids, not in-app ids: use `kilo/kilo-auto/efficient`, never `kilo-auto/efficient` (that fails `ProviderModelNotFoundError` and leaves an empty `New session - <ts>` row — harmless, but do not confuse it with the content session). Run `remote-cli.sh exec models` and copy the exact id. A fresh E2E account has $0 credit — seed with `pnpm dev:seed app:add-credits <user-id> 10` first.

Role agents reuse the orchestrator-prepared session and verify discovery and mirroring by inspecting its pane and the mobile list:

```bash
CLI_SESSION="kilo-e2e-cli-$(basename "$PWD")"
tmux capture-pane -p -t "$CLI_SESSION" -S -100
```

Drive the session with `tmux send-keys`; slash commands need one Enter for autocomplete and another to submit. Type a prompt to create a session; the mobile list updates after the CLI WebSocket connects and its first heartbeat (about 12 seconds). If no session is prepared for this worktree, stop and ask the orchestrator to run `remote-cli.sh start <email>`.

## Android Emulator

Do not conclude Android is unavailable from `command -v adb` or the inherited `PATH`. The repository resolves the SDK and JDK 17 from `ANDROID_HOME`, `~/Library/Android/sdk`, and standard Homebrew locations. Run the doctor first; it prints resolved absolute paths and available AVDs:

```bash
pnpm dev:mobile:android doctor
```

The bundle owner uses the repository Android wrappers for emulator lifecycle
and the Expo/Gradle build before dispatch. `pnpm dev:mobile:android emulator-start`
starts the emulator and waits for `sys.boot_completed=1` (process-liveness
checked, 8-minute envelope) — device visibility is not readiness, and there is
no manual boot polling. The verifier starts with `login.sh`. Never use unbounded
`adb wait-for-device`, manual `adb reverse`, or dev-client `am start`; `login.sh`
preflight handles the last two.

### Launch and GPU policy

Two launch attempts total, then a test-environment blocker with the recorded log tail. Attempt 1 uses the Mac GPU. Attempt 2 switches to software rendering only when the recorded PID died; a live process that missed the boot envelope retries the Mac GPU. `emulator-start` atomically allocates the console port, creates the worktree session, and records its exact PID/session; never launch with raw `tmux`, `emulator`, or a hand-picked port.

```bash
EMULATOR=$(pnpm -s dev:mobile:android emulator-start <avd-name> --gpu host --wait)
SERIAL=$(jq -r .serial <<<"$EMULATOR")
EMULATOR_PID=$(jq -r .pid <<<"$EMULATOR")
EMULATOR_LOG=$(jq -r .log <<<"$EMULATOR")
pnpm -s dev:mobile:android claim "$SERIAL" >/dev/null
pnpm dev:mobile:android build "$SERIAL"
```

On success, record `SERIAL`, `EMULATOR_PID`, and `EMULATOR_LOG` in the round handoff. Never drive or kill a device claimed by another worktree, and never delete a foreign claim file.

### Failed attempt → stop exactly yours → relaunch once

With `--wait`, JSON is printed only **after** boot succeeds. On failure the command throws and stdout is empty — `$EMULATOR` / `$EMULATOR_LOG` / `$EMULATOR_PID` are unset. Before any teardown, decide attempt 2's GPU from the **error text** (not from whether a process is still alive after stop):

| Error text | Cause | Attempt 2 GPU |
|---|---|---|
| `… did not reach sys.boot_completed=1 within 8 minutes; see <log>` | process still live, boot envelope missed | `--gpu host` (retry Mac GPU) |
| `… died while booting; see <log>` | recorded PID died mid-boot | `--gpu swiftshader_indirect` |
| `… exited during launch; see <log>` | process died before console bind | `--gpu swiftshader_indirect` |
| `… did not bind console port … within 30s; see <log>` | launch hung before bind | `--gpu swiftshader_indirect` |
| `… does not own console port …` | foreign process on the port | `--gpu swiftshader_indirect` |
| `… did not record its PID` | launch failed before pid file | `--gpu swiftshader_indirect` |
| any other `emulator-start` failure | treat as died / unusable host GPU path | `--gpu swiftshader_indirect` |

Only the boot-envelope timeout retries the Mac GPU. Every pre-boot launch failure and mid-boot death switches to software rendering.

Log path for `tail -200` (not `$EMULATOR_LOG`):

- `$TMPDIR/kilo-e2e-android-<worktree-slug>.log` (slug = basename with non `[A-Za-z0-9_-]` → `_`), or
- the path after `see ` in the error text (when present).

The session record at `$TMPDIR/kilo-mobile-android-emulators/<worktree-slug>.json` only exists after a successful launch bind. Pre-boot launch failures delete it before rethrowing, so there is nothing to read — `emulator-stop` still reaps a stray tmux session. Boot-wait failures leave the record in place; read it before stopping only if you need the recorded PID/session for the handoff. Then run `pnpm dev:mobile:android emulator-stop` and `pnpm dev:mobile:android release-all` — stop kills any remaining PID and deletes the session record, so it cannot be used to re-derive the GPU policy afterward. Relaunch once with the GPU chosen above. If the second attempt also fails, stop and return a test-environment blocker with the log tail; never a third launch.

### Build and login

After emulator-start + claim + build (above), run login next:

```bash
apps/mobile/e2e/login.sh "$SERIAL"
```

`build` installs a validated cached APK when the Android native fingerprint and toolchain match. Never install an APK from another output path or invoke Gradle directly. Reinstall via `build <serial>` only when the native fingerprint changed, never to reset app state. For rebuilds only, the manual claim and build commands are:

```bash
pnpm dev:mobile:android claim <serial>   # idempotent
pnpm dev:mobile:android build <serial>   # validated cached APK only
```

`apps/mobile/android/` is git-ignored and a fresh worktree has none. The
wrapper runs `npx expo prebuild --platform android` when needed; that step is
codegen only, needs no wrapper, and the generated tree is gitignored.

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

### ADB fallback (Appium stays primary)

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

Each verifier removes only its own temporary files:

```bash
rm -f "$LOGIN_LOG"
```

After all verifiers return, the bundle owner stops everything it started —
conditional resources first (skip any never started), then the stack. An
iOS-only round has no Android resources to stop, so the Android stop line is
skipped by the same skip-any-never-started rule:

```bash
apps/mobile/e2e/remote-cli.sh stop                                                 # only after remote-cli.sh start
tmux kill-session -t "kilo-e2e-github-stub-$(basename "$PWD")" 2>/dev/null || true  # only after the GitHub stub
apps/mobile/e2e/record.sh <udid> stop                                              # every bundle device; idempotent
apps/mobile/e2e/record.sh <serial> stop                                            # only if android was started
pnpm dev:mobile:android emulator-stop || true                                      # only if android was started
pnpm dev:mobile:android release-all || true                                        # only if android was started
pnpm dev:mobile:simulator release-all
pnpm dev:stop
rm -f "$EMULATOR_LOG"
```

The wrappers release only this worktree's claims and power off only devices
they started. Never call `xcrun simctl shutdown` or kill an emulator session
yourself.

Also stop log followers you created. Never use `tmux kill-server`, kill an unrelated `kilo-dev-*` session, or use `pnpm dev:stop --force` while sibling worktrees are active.

Verify cleanup, and confirm no generated E2E fixtures remain tracked or untracked:

```bash
pnpm dev:status --json
tmux ls
xcrun simctl list devices booted
git status --short
```
