# Workflow Learnings

Environment blockers and their fixes, recorded by the planner or orchestrator for the role that hit them. The full contract — when to read, when to write, entry shape, deduplication — is in [MOBILE_WORKFLOW.md](MOBILE_WORKFLOW.md).

## Planner

## Orchestrator

### SpringBoard `Open in "Kilo"?` confirmation blocks `simctl openurl` (2026-07-27, PR #4697 main-merge)

- Symptom: `e2e/login.sh` fails at settle-app: after preflight's `xcrun simctl openurl` a SpringBoard dialog `Open in "Kilo"?` (curly quotes, Cancel/Open buttons) stays on screen; `settle-app.yaml` only matched the Safari wording `Open this page in "Kilo"?` and timed out.
- Cause: origin/main added `associatedDomains: ['applinks:app.kilo.ai']` (universal links) in `app.config.ts`; with the merged build installed, opening the custom scheme via `simctl openurl` surfaces a SpringBoard confirmation the flows did not handle.
- Fix: match both wordings in `e2e/flows/settle-app.yaml` and `e2e/flows/open-app.yaml` (`Open in ["“”]Kilo["“”]\?` alongside the Safari string) and tap `Open` in the same bounded optional-prompt slot; updated the stale "skips Safari's confirmation" bullet in `e2e/AGENTS.md`.

### Maestro `IOSDriverTimeoutException` under multi-simulator load (2026-07-27, PR #4697 verifier rerun)

- Symptom: every Maestro command against a claimed iOS simulator fails with `xcuitest.installer.LocalXCTestInstaller$IOSDriverTimeoutException: iOS driver not ready in time`, even with `MAESTRO_DRIVER_STARTUP_TIMEOUT=300000`; `simctl openurl` may also time out (`NSPOSIXErrorDomain code=60`).
- Cause: a stale `xcodebuild test-without-building` process left bound to the UDID after a killed Maestro run (check `ps aux | grep xcodebuild` and match the `-xctestrun` temp path / `id=<udid>`), compounded by several same-type simulators booted by sibling worktrees.
- Fix: kill only the `xcodebuild` process whose xctestrun path contains your UDID, then `xcrun simctl shutdown <udid> && xcrun simctl boot <udid>` (app and login state survive; `login.sh` is idempotent). Validate with a one-step `takeScreenshot` flow before dispatching the verifier again.

### "GitHub connection expired" against hermetic stub = git-token-service 503 (2026-07-27, PR #4697 C3)

- Symptom: PR-review E2E with the hermetic GitHub stub opens the PR then stalls on "GitHub connection expired / Check connection"; the stub request log shows only the first `pulls/<n>` fetch and no further traffic; nextjs logs repeated `githubPrReview.getPullRequest 412`.
- Cause: `withGitHubUserTokenRetry` resolves the user's GitHub token through git-token-service before any outbound call; the service's `POST /internal/github-user-authorizations/token` returned `503 authentication_unavailable` because its `NEXTAUTH_SECRET_DEV` Secrets Store binding had never been created in this worktree (Secrets Store state is local to each Worker directory). A missing-URL or key-drift `USER_GITHUB_APP_TOKEN_*` envelope produces the same 412 surface.
- Fix: `pnpm dev:env -y cloudflare-git-token-service` (creates `NEXTAUTH_SECRET_DEV` and syncs the `USER_GITHUB_APP_TOKEN_*` envelope into the worker env from root `.env.local`), then `pnpm dev:restart cloudflare-git-token-service`. Smoke with an authenticated `GET /api/trpc/githubPrReview.getPullRequest?...owner=kilo-stub...` — expect 200, not 412. Note nextjs reads `GIT_TOKEN_SERVICE_API_URL` from `apps/web/.env.development.local` (`@url cloudflare-git-token-service`), not from root `.env.local`.

### Hermetic GitHub stub lacks `GET /pulls/{n}/files` — Files-tab E2E 404s (2026-07-27, PR #4697 C3)

- Symptom: PR-review Files tab shows "Pull request unavailable" while Overview loads fine; nextjs logs `githubPrReview.listFiles 404`; stub request log shows every pinned endpoint hit except `/files`.
- Cause: the stub's pinned surface (REST pull/repo/check-runs/statuses + GraphQL review ops) does not cover `GET /repos/{owner}/{repo}/pulls/{n}/files`, which `listFiles` needs.
- Workaround (one-off): temporarily add a `/files` handler returning patched-file fixtures, restart the stub tmux session, verify, then restore `server.mjs` byte-identical. Permanent fix (teach the stub `/files` + pagination) is intentionally left out of scope; do it as a dedicated harness change when a run needs Files-tab E2E regularly.
