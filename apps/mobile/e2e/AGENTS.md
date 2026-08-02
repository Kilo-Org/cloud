# Mobile E2E Runbook

This directory is the mobile E2E harness. The scripts do the mechanics; this runbook holds the rules the scripts cannot enforce. Run commands from the repository root. Follow this runbook exactly.

| Script | Purpose |
|---|---|
| `e2e/login.sh <device> [email]` | Sign the app in on a device: preflight, OTP request, outbox read, verify, assert Home |
| `e2e/logout.sh <device>` | Sign the app out; no-op when signed out |
| `e2e/appium.sh <device> ...` | All Appium use: run flows, dump the hierarchy, manage the per-device server |
| `e2e/record.sh <device> ...` | Segment screen recording and frame extraction |
| `e2e/github-stub.sh start\|status\|stop` | Hermetic GitHub API stub for PR-review E2E: server, env line, token seed |
| `e2e/remote-cli.sh start\|prepare\|exec\|status\|stop` | Local kilo CLI as a remote session against this worktree's stack |
| `e2e/preflight.sh` | Internal. `login.sh`/`logout.sh` run it; it proves services, device claim, and Metro provenance |
| `e2e/flows/*.js` | Reusable flow modules; `e2e/wdio/` is their driver plumbing |

# Ground rules

- One bundle owner per round starts every resource, records what it started, and stops all of it at the end. A verifier never starts, stops, or replaces a resource, and never uses a device another worktree claimed.
- The default platform scope is iOS-only. Run Android only with a recorded platform-specific reason.
- Long-lived helper processes run in named `kilo-e2e-*` tmux sessions, never as loose background processes.
- Do not read `.env` files. `github-stub.sh` owns the one sanctioned env-file edit.
- Do not export `KILO_PORT_OFFSET` and do not source `apps/mobile/.env`. The dev runner assigns and persists each worktree's port offset itself. Read live ports from `pnpm dev:status --json`; never assume defaults.
- Never create proxies, redirects, tunnels, NAT rules, or listeners to repair stale client or bundler state. Never map port 8081 to a worktree Metro port. Port 23750 is the one repo-owned exception (shared Docker proxy); never kill a `socat` owned by another worktree.
- If an unexpected listener exists, report its PID, parent, command, and port. Stop it only when you can prove you created it.
- Never commit E2E fixtures. Generate per-run data in a temporary directory and delete it before you finish. The committed harness code in this directory is not a fixture.
- Appium output is large. Keep success output out of context; on failure show a bounded tail:

```bash
LOG=$(mktemp /tmp/kilo-e2e.XXXXXX)
apps/mobile/e2e/login.sh <device> >"$LOG" 2>&1 || { tail -n 100 "$LOG"; false; }
```

# Fresh worktree

Node must be v24 (root `.nvmrc`). If dependencies or local env files are missing, run `pnpm dev:worktree:prepare` once. Missing local env values are a human step: `pnpm dev:setup-env`. Test data: `pnpm dev:seed` (no arguments lists topics; `app:create-user`, `app:add-credits`, `app:api-token`, `app:user-id`).

# Real GitHub integration (cloud agents and similar)

A scenario that needs a real GitHub integration (for example cloud agents cloning or pushing) cannot use the stub. Copy a valid integration from the shared dev database onto the signed-in E2E account:

```bash
pnpm dev:seed app:github-integration-copy <email>
```

The command finds the newest valid integration, re-encrypts its tokens for the account, and reports the donor login and expiries. When it fails with "No valid GitHub integration found", the scenario cannot run: report `VERIFICATION BLOCKED.` with that message — never fake the integration or skip the scenario silently. The copy shares the donor's token; if the connection later shows as expired, run the copy again.

# Start the stack (bundle owner)

1. Record the pre-existing state, so you later stop only what you started:
   `pnpm dev:status --json`, `tmux ls`, `xcrun simctl list devices booted`.
2. Reuse a running stack only when it belongs to this worktree (session `kilo-dev-<this-basename>`). Never stop another worktree's `kilo-dev-*` session.
3. Start:

```bash
pnpm dev:env -y cloudflare-session-ingest
pnpm dev:start --no-attach --reuse-running mobile cloud-agent-next kiloclaw event-service
pnpm drizzle migrate
```

4. Confirm `mobile`, `nextjs`, `cloudflare-session-ingest`, `cloud-agent-next`, `kiloclaw`, and `event-service` are `up` in `pnpm dev:status --json`. Restarts are asynchronous: when a service is still starting, read its log and re-check; do not restart the stack.
5. Never run bare `wrangler secrets-store` commands; use `pnpm dev:env -y <group>` from the repository root. A secret-creation failure is fatal, not retryable.

Logs: `tail -n 200 dev/logs/<service>.log` or `pnpm dev:capture <service>`. Never guess a tmux window from `tmux ls`; a service pane can live inside the dashboard. Use raw tmux only for an interactive process, after resolving the pane from `pnpm dev:status --json` and `tmux list-panes -a`.

# iOS simulator (bundle owner)

```bash
CLAIM=$(pnpm -s dev:mobile:simulator claim)      # claim + boot an unclaimed iPhone
UDID=$(printf '%s' "$CLAIM" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).device.id)')
pnpm dev:mobile:ios build "$UDID"                # validated cached build only
pnpm dev:mobile:simulator release-all            # at cleanup; powers off what it booted
```

- The wrapper renames the device and restores the name on release. Never run `xcrun simctl rename`, `boot`, or `shutdown` behind the wrapper's back.
- Give claims a 10-minute-or-more timeout under parallel load; booting is slow. A claim killed mid-boot recovers on the next claim.
- Never install a DerivedData app by hand and never run a separate Expo native build; `build <udid>` validates fingerprint and cache.
- `login.sh` reconnects the dev client to this worktree's exact Metro URL and proves Metro provenance (project root and API URL in the manifest). After env changes: regenerate env, restart Metro, run `login.sh` again. Rebuild only when native config or plugins changed.
- For manual reconnection, open the BARE Metro URL only: `xcrun simctl openurl <udid> "exp+kilo-app://expo-development-client/?url=<url-encoded-metro-url>"`. Never append an app route to the `url` parameter; the manifest fetch 404s. Drive routes with `kiloapp://<route>` only after boot completes; a link fired during boot is dropped.
- iOS can show a SpringBoard prompt `Open in "Kilo"?` for universal links; the shared launch flows tap `Open`. A Safari or WebView step can show `Open this page in "Kilo"?`; tap the exact `Open` accessibility action.

# Android emulator (bundle owner)

Do not conclude Android is unavailable from `command -v adb`; the wrappers resolve the SDK themselves. Run `pnpm dev:mobile:android doctor` first; it prints resolved paths and AVDs.

```bash
EMULATOR=$(pnpm -s dev:mobile:android emulator-start <avd-name> --wait)
SERIAL=$(jq -r .serial <<<"$EMULATOR")
pnpm -s dev:mobile:android claim "$SERIAL" >/dev/null
pnpm dev:mobile:android build "$SERIAL"
apps/mobile/e2e/login.sh "$SERIAL"
```

- `emulator-start --wait` blocks until `sys.boot_completed=1` and retries a failed launch once by itself: a missed boot envelope retries the same GPU; every other launch failure switches to software rendering. When it still fails, report a test-environment blocker with the last 200 lines of `$TMPDIR/kilo-e2e-android-<worktree-slug>.log` (slug: basename, non `[A-Za-z0-9_-]` becomes `_`). Never launch with raw `tmux`, `emulator`, or a hand-picked port. Never attempt a third launch.
- Record `serial`, `pid`, and `log` from the printed JSON in the round handoff.
- Never use unbounded `adb wait-for-device`, manual `adb reverse`, or a dev-client `am start`; `login.sh` preflight applies both reverse mappings and opens the dev client.
- Under host load the emulator can show `Kilo isn't responding` (ANR) during cold launch. Answer `Wait` and keep waiting; the shared launch flow does this itself. An ANR dialog alone is never a product failure — fail only when the app crashes or stays blank past the scenario budget.
- Reinstall with `build <serial>` only when the native fingerprint changed, never to reset app state. To reset app state: `pnpm dev:mobile:android adb -s <serial> shell pm clear com.kilocode.kiloapp`, then run `login.sh <serial>` again.
- App Links: `pnpm dev:mobile:android adb -s <serial> shell am start -a android.intent.action.VIEW -d "https://<host>/<path>"` drives real intent resolution.
- `apps/mobile/{ios,android}` are gitignored; the wrappers run `expo prebuild` when the tree is missing.

# Sign in and out

```bash
apps/mobile/e2e/login.sh <device> [email]   # default email: e2e-mobile-<worktree>-<ios|android>@example.com
apps/mobile/e2e/logout.sh <device>
```

- The default email is per-worktree and per-platform, so parallel shards never share a backend user. Pass an explicit email only when a test needs a specific account.
- `login.sh` requests an email code, reads it from the worktree outbox (30-second wait), verifies it, accepts first-account consent, and asserts Home. It retries once through a cold relaunch. On failure it states which half broke: no outbox email means the request never fired; a new outbox email means the code screen was never reached. Neither is a product-bug lead by itself.
- Never bypass the preflight and never call the flow files directly.
- Native prompts are flow states, not errors: the launch flow answers tracking with `Ask App Not to Track`; login handles the notification prompt after authentication. For feature prompts (microphone, speech), inspect the hierarchy and tap the exact button text the test requires. Never a blind `tapOn('Allow')`.

# Appium

All Appium use goes through `e2e/appium.sh <device> ...`; it serializes per device, so taps can never land on another worktree's device. Never use an MCP automation tool or a hand-rolled driver connection. Appium is primary on both platforms; fall back to `simctl` or wrapped ADB only when Appium cannot do the operation. Setup (drivers, `APPIUM_HOME`) is automatic on first use.

```bash
apps/mobile/e2e/appium.sh <device> test -e KEY=VALUE <flow.js> [more-flows.js]
apps/mobile/e2e/appium.sh <device> hierarchy [out.xml]   # writes a file, prints its path — grep it, never cat it
apps/mobile/e2e/appium.sh <device> server stop           # at bundle cleanup
```

- One `test` invocation runs many flow files on ONE WebDriver session, and session startup dominates cost: plan the route and batch flows into as few invocations as possible. `login.sh`/`logout.sh` keep their own sessions.
- Never guess a selector from a visible label or screenshot. Copy the exact text or accessibility value from `hierarchy`. Matching is full-string regex against the element label (iOS) or text / content-desc (Android), not substring.
- Tab buttons expose full accessibility labels such as `Home, tab, 1 of 4`; `tapOn('Agents')` is wrong. Inspect before relying on any remembered label; counts and labels change.
- Inspect the screen before selecting elements; re-inspect after UI changes.
- Flows are plain node modules in `e2e/flows/*.js` using `e2e/wdio/helpers.js` (`tapOn`, `assertVisible`, `waitVisible`, `inputText`, `eraseText`, `scrollUntilVisible`, `stopApp`, `launchApp`, `when`, `whenNot`). A failed helper throws; the process exit code is the verdict.
- ADB fallback: dump bounds first, never tap from a screenshot or memory. Re-dump after every navigation or prompt.

```bash
pnpm dev:mobile:android adb -s <serial> shell uiautomator dump /sdcard/window.xml
DUMP=$(mktemp /tmp/kilo-window.XXXXXX)
pnpm dev:mobile:android adb -s <serial> pull /sdcard/window.xml "$DUMP"
grep -o 'text="[^"]*" bounds="[^"]*"' "$DUMP"   # grep the file, never cat it
pnpm dev:mobile:android adb -s <serial> shell input tap <x> <y>
pnpm dev:mobile:android adb -s <serial> shell input keyevent KEYCODE_BACK
```

# Flow-writing constraints (device-tested)

- Pass `EMAIL` and `OTP` with `-e`; the flows fail fast without them.
- Target the email field by its placeholder `you@example.com`. Tap `Verify code` without dismissing the number pad.
- The email field is uncontrolled and keeps prior text. Erase it first and assert the typed address before submitting; two attempts otherwise interleave into one malformed address.
- Taps land on an element's center. A center inside the keyboard window or under fixed header chrome is a silent no-op, not a product regression. Verify with `hierarchy`: the center must be above the keyboard window's top bound.
- The native sign-out confirmation is the first case-insensitive `Sign Out` match (`index: 0`, topmost by position).

# Evidence

Record each flow segment, never one whole-route video; Android caps recordings near 3 minutes. Extract report frames from the timestamps the flow hit; simctl videos are variable-frame-rate, so a static screen yields few frames. Screenshots are for ad-hoc stills and the fallback when recording fails; still return a verdict. `stop` is idempotent; the bundle owner runs it for every device before release.

```bash
apps/mobile/e2e/record.sh <device> start <video-path>
apps/mobile/e2e/record.sh <device> stop
apps/mobile/e2e/record.sh frame <video> <hh:mm:ss> <out.png>
xcrun simctl io <udid> screenshot <path>
pnpm dev:mobile:android adb -s <serial> exec-out screencap -p > <path>
```

# GitHub stub (PR-review E2E)

```bash
apps/mobile/e2e/github-stub.sh start <email>   # server + env line + token seed; then relaunch the app
apps/mobile/e2e/github-stub.sh seed <email>    # token row for one more signed-in account (other platform's verifier)
apps/mobile/e2e/github-stub.sh stop            # reverses everything
```

The email is the account the app is signed in as; the user must exist (sign in on the device first). Fixtures: `kilo-stub/discussion-mixed#1` (iOS verifier), `kilo-stub/discussion-mixed#11` (Android verifier — the two run in parallel and must never share one mixed fixture, its thread state is mutable), `kilo-stub/discussion-conversation-only#2`, `kilo-stub/discussion-empty#3`. `stop` does not remove the seeded token row; until the next `start`, the PR-review screen keeps its URL input and real GitHub calls fail as an expired connection — that residue is expected, not a defect. If the app stalls on "GitHub connection expired" with repeated `githubPrReview.getPullRequest 412` in the nextjs log, run `pnpm dev:env -y cloudflare-git-token-service && pnpm dev:restart cloudflare-git-token-service` (nextjs reads `GIT_TOKEN_SERVICE_API_URL` from `apps/web/.env.development.local`).

# Remote CLI sessions

Use only for session discovery, mirroring, or mobile-to-CLI messaging. The bundle owner prepares the CLI; verifiers never mint tokens or read env files.

```bash
apps/mobile/e2e/remote-cli.sh start <email>    # TUI in tmux kilo-e2e-cli-<slug>
apps/mobile/e2e/remote-cli.sh exec session list --pure
apps/mobile/e2e/remote-cli.sh exec run "say hello"
apps/mobile/e2e/remote-cli.sh stop
```

- Pass the account the app is signed in as (the `login.sh` default). A fresh E2E account has zero credit; seed with `pnpm dev:seed app:add-credits <user-id> 10` first.
- `-m` takes CLI ids: `kilo/kilo-auto/efficient`, never `kilo-auto/efficient` (that fails and leaves a harmless empty `New session` row).
- The `remote` relay must stay alive for the whole flow: run it in its own `kilo-e2e-*` tmux window or send `/remote` to the TUI. A one-shot `exec remote` exits and kills the relay.
- Inspect the TUI with `tmux capture-pane -p -t kilo-e2e-cli-<slug> -S -100`. Slash commands need one Enter for autocomplete and one to submit. The mobile list updates about 12 seconds after the CLI's first heartbeat. If no session is prepared, stop and ask the bundle owner to run `remote-cli.sh start <email>`.

# Foreign data on your device

A hierarchy or screenshot showing another worktree's data is never a product defect on its own. Prove it against the backend first: row ownership in Postgres, this worktree's nextjs and ingest logs, and whether pull-to-refresh reproduces it. Re-confirm the signed-in account (Profile tab) and Metro provenance. When backend evidence contradicts the capture, it is cross-device noise: re-run the check cleanly and report both.

# Cleanup (bundle owner)

Stop what you started, conditional resources first; skip any you never started:

```bash
apps/mobile/e2e/remote-cli.sh stop            # only after remote-cli.sh start
apps/mobile/e2e/github-stub.sh stop           # only after github-stub.sh start
apps/mobile/e2e/record.sh <device> stop       # every bundle device; idempotent
apps/mobile/e2e/appium.sh <device> server stop
pnpm dev:mobile:android emulator-stop         # only if android was started
pnpm dev:mobile:android release-all           # only if android was started
pnpm dev:mobile:simulator release-all
pnpm dev:stop
```

Never `tmux kill-server`, never stop an unrelated `kilo-dev-*` session, never `pnpm dev:stop --force` while sibling worktrees are active. Also stop log followers you created. Then verify: `pnpm dev:status --json`, `tmux ls`, `xcrun simctl list devices booted`, and `git status --short` shows no leftover fixtures.
