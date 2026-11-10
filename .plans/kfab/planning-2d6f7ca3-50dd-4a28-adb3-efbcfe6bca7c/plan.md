<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

fix(cli-sessions): return a specific non-retryable error when GitHub runtime authorization blocks PR refresh

## Problem

Sentry KILOCODE-WEB-287N ('TRPCError: Failed to fetch pull request from GitHub', 21 events since 2026-10-14, ongoing) is thrown by the catch-all in `cliSessionsV2.refreshAssociatedPullRequest`. That catch maps only `GitHubRateLimitError` to TOO_MANY_REQUESTS; every other failure becomes INTERNAL_SERVER_ERROR. The most common underlying cause is `GitHubRuntimeAuthorizationError` ('GitHub installation is unavailable for runtime use', group KILOCODE-WEB-27W0, 71 events since 2026-09-15). It is thrown by the runtime authorization gate while the installation token is being minted, before any request reaches GitHub. That error means the session owner's GitHub connection or installation can't be used, which is a known state and not a fetch failure. The result is a misleading 500. The client retries it as if it were transient. A manual Refresh shows 'Failed to fetch pull request from GitHub'. The Sentry report also drops the machine-readable rejection reason, so the cause behind each event can't be seen.

## Evidence

- Sentry KILOCODE-WEB-287N latest event d8c5e839… (2026-10-29T03:02:38Z, production, fra1): the top first-party frame is apps/web/src/routers/cli-sessions-v2-router.ts:2105, the INTERNAL_SERVER_ERROR throw in the refresh catch.
- Sentry KILOCODE-WEB-27W0 (per triage): stack goes from the router's fetchPullRequestByNumber call to adapter generateGitHubInstallationToken, then assertGitHubInstallationRuntimeAuthorized, then the runtime-authorization.ts throw. Over 30 days it is the leading error behind this endpoint (22 events), and its latest event falls in the same second as 287N's last-seen time. A few other events at the endpoint are real GitHub failures (HttpError 5xx, timeouts, socket closed).
- Pinned source cli-sessions-v2-router.ts:2077-2109: the catch special-cases only GitHubRateLimitError. captureException adds tags source/endpoint and extra sessionId/owner/repo/number, with no reason.
- runtime-authorization.ts:15-43: GitHubRuntimeAuthorizationError carries `reason` (a fixed set of values such as integration_status, suspended, auth_invalid, disconnected, installation_unavailable, deleted_organization, blocked_personal_owner, missing_association) and `diagnostics`.
- prepare-review-payload.ts:963-978 already reports this error with tag githubRuntimeAuthorizationReason and extra githubRuntimeAuthorization {reason, ...diagnostics}.
- useSidebarSessions.ts:836-847: shouldRetryPrLinkVerification retries once on INTERNAL_SERVER_ERROR/BAD_GATEWAY/SERVICE_UNAVAILABLE/GATEWAY_TIMEOUT/TIMEOUT and not on other codes. The auto-verify effect (941-950) records one attempt per link-evidence key.
- PrHoverCardContent.tsx:70-79: manual Refresh shows a toast with the server error message.
- cli-sessions-v2-router.test.ts:3424-3436 already has a pattern test for mapping GitHubRateLimitError to TOO_MANY_REQUESTS that a new test can mirror.

## Desired outcome

When the runtime authorization gate rejects the session owner's GitHub installation during PR refresh, the endpoint fails fast with a specific, non-retryable error. The error code is PRECONDITION_FAILED, and the message tells the user to reconnect or check GitHub access. The client doesn't retry it, and a manual Refresh shows that actionable message. The rejection is still reported with its reason, so the cause can be diagnosed. Real GitHub failures (5xx, timeouts) still return INTERNAL_SERVER_ERROR and are still retried once, exactly as today.

## Scope

- In `refreshAssociatedPullRequest`'s catch around `fetchPullRequestByNumber`, add a `GitHubRuntimeAuthorizationError` branch before the generic branch. It maps to TRPCError code PRECONDITION_FAILED with a user-actionable message and `cause: error`.
- Report the authorization rejection with its reason, following prepare-review-payload: tag `githubRuntimeAuthorizationReason` and extra `githubRuntimeAuthorization: { reason, ...diagnostics }`. Keep the existing source/endpoint tags and sessionId/owner/repo/number extra.
- Add router tests: the authorization error maps to PRECONDITION_FAILED and its reason is reported; a generic error still maps to INTERNAL_SERVER_ERROR.
- Add or extend a unit test for `shouldRetryPrLinkVerification`: PRECONDITION_FAILED isn't retried and INTERNAL_SERVER_ERROR still is.

## Exclusions

- No changes to the runtime authorization gate, token minting, or owner-integration selection (`getIntegrationForOwner` still falls back to unhealthy rows).
- No change to stored `pr_link_verified_at`. A rejected installation doesn't prove the link is wrong, so the existing verification isn't revoked.
- No new sidebar UI for the auto-verify path beyond what already happens. Unverified links already render no PR.
- No change to handling of rate-limit, 404, or real GitHub 5xx/timeout errors.
- No data cleanup of unhealthy integrations, and no change to other Sentry groups.
- Post-deploy production monitoring of Sentry groups is not part of this plan's acceptance criteria.

## Approach

- Import `GitHubRuntimeAuthorizationError` from `@/lib/integrations/github/runtime-authorization` into cli-sessions-v2-router.ts.
- In the catch, after the GitHubRateLimitError branch: if `error instanceof GitHubRuntimeAuthorizationError`, call captureException with the existing tags plus `githubRuntimeAuthorizationReason: error.reason` and extra plus `githubRuntimeAuthorization: { reason: error.reason, ...error.diagnostics }`. Then throw `new TRPCError({ code: 'PRECONDITION_FAILED', message: 'GitHub access for this session is unavailable. Reconnect or check your GitHub integration, then try again.', cause: error })`. Diagnostics contain only installation ID, app type, and integration IDs, with no tokens.
- Leave the generic branch unchanged so real GitHub failures still produce INTERNAL_SERVER_ERROR and keep the client's single retry.
- Client: no code change is expected. shouldRetryPrLinkVerification already treats PRECONDITION_FAILED as non-retryable, and the hover card already shows the server message. Lock both in with tests.
- Tests: in cli-sessions-v2-router.test.ts, mock fetchPullRequestByNumber to reject with `new GitHubRuntimeAuthorizationError('installation_unavailable', {...})`. Assert code PRECONDITION_FAILED, assert the message isn't 'Failed to fetch pull request from GitHub', and, if captureException is mocked in that suite, assert the reason tag. Add a case where a plain Error still gives INTERNAL_SERVER_ERROR. Add shouldRetryPrLinkVerification cases.

## Affected areas

- apps/web/src/routers/cli-sessions-v2-router.ts (refreshAssociatedPullRequest catch, ~2077-2109)
- apps/web/src/routers/cli-sessions-v2-router.test.ts (refreshAssociatedPullRequest describe)
- apps/web/src/components/cloud-agent-next/hooks/useSidebarSessions.ts (tests for shouldRetryPrLinkVerification only)

## Acceptance criteria

### ac-1: When fetchPullRequestByNumber rejects with GitHubRuntimeAuthorizationError, refreshAssociatedPullRequest rejects with TRPCError code PRECONDITION_FAILED and a message about reconnecting or checking GitHub access, not 'Failed to fetch pull request from GitHub'. A router test covers this.

**Verification:** Code review

### ac-2: The authorization rejection is still sent to Sentry with tag githubRuntimeAuthorizationReason set to the error's reason, extra containing the reason and diagnostics, and the existing source/endpoint tags and session/PR extra. No tokens or credentials are included.

**Verification:** Code review

### ac-3: Regression: a non-rate-limit, non-authorization error from fetchPullRequestByNumber (for example a GitHub 5xx or timeout) still produces INTERNAL_SERVER_ERROR 'Failed to fetch pull request from GitHub' and is still reported. GitHubRateLimitError still maps to TOO_MANY_REQUESTS. Router tests cover both.

**Verification:** Code review

### ac-4: Failure UX, both effects: shouldRetryPrLinkVerification returns false for PRECONDITION_FAILED, so a known authorization condition fails right away with no extra retry delay. It still returns true on the first INTERNAL_SERVER_ERROR failure, so transient GitHub failures are retried within the same bound and don't take longer to surface. Unit tests cover both cases.

**Verification:** Code review

## Risks

- Sentry's tRPC middleware may or may not auto-capture non-500 TRPCErrors. Either way, the explicit captureException with the reason keeps the event diagnosable, and the 500-labelled wrapper group goes away.
- Rejection reasons vary (installation removed, connection disconnected, owner blocked, and so on), so one generic message may not fit every case. That's acceptable because each case needs the owner to act on the GitHub integration. Per-reason messages can follow once the newly reported reason data is visible.
- Other callers that depend on INTERNAL_SERVER_ERROR from this endpoint (for example the kilo-mcp catalog consumer) would now see PRECONDITION_FAILED for this case. That's a more accurate code, and no caller in the repo branches on it.

## Assumptions

- The GitHubRuntimeAuthorizationError reaches the router catch unwrapped, as the KILOCODE-WEB-27W0 stack and adapter source show (fetchPullRequestByNumber passes non-rate-limit errors through unchanged).
- The router test suite already mocks fetchPullRequestByNumber (mockedFetchPullRequestByNumber), so the new case fits the existing pattern.
- Diagnostics (installationId, appType, integrationIds) are internal identifiers, not secrets, and are already sent to Sentry by prepare-review-payload.

## Decisions

### d-1: Which tRPC code should a runtime-authorization rejection use on PR refresh?

**Answer:** PRECONDITION_FAILED: specific, not a server fault, and already excluded from the client's retry list. The repo uses it elsewhere for 'cannot proceed in the current state'.

**Blocking:** no

### d-2: Should an authorization rejection revoke the session's stored PR-link verification, as the 404/mismatch paths do?

**Answer:** No. Not being able to authenticate to GitHub doesn't disprove the link, so verification state stays unchanged and only the refresh fails.

**Blocking:** no

### d-3: Should the rejection still be reported to Sentry?

**Answer:** Yes, with its reason and diagnostics, matching prepare-review-payload. This recovers the missing reason distribution (triage M1) without changing the gate.

**Blocking:** no
