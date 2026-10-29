<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

fix(code-reviews): reject retrigger when the GitHub PR no longer exists and stop reporting billing-notice 404s to Sentry

## Problem

Sentry KILOCODE-WEB-28HJ (3 events in about 7 seconds, handled, level error, tag operation=code-review-billing-post-notice) is a GitHub 404 from `octokit.issues.listComments`. The call chain is codeReviews.retrigger → tryDispatchPendingReviews → failReviewForInsufficientCredits → finalizeCodeReviewBillingFailure → postCodeReviewBillingNotice → hasPRCommentWithMarker → scanPRIssueComments. The review's GitHub pull request no longer resolves at its stored repo/number. The PR fetch returns 404, check-run creation for the stored head SHA returns 422, and dispatched sandbox sessions fail with "branch not found". Even so, retrigger resets the review, re-creates a gate check, and dispatches sandbox sessions that cannot succeed. When the review finally fails for insufficient credits, the terminal billing-notice path sends a 404 that could never have succeeded to Sentry as an error. The user gets a slow, unclear failure, and maintainers get an avoidable Sentry issue.

## Evidence

- Sentry anaconda-nq KILOCODE-WEB-28HJ (event 49648532212c4d2ca8f4676d52a68e01, release ebf5c14b): HttpError Not Found list-issue-comments at adapter.ts:632 scanPRIssueComments. Stack: hasPRCommentWithMarker (adapter.ts:428) ← postCodeReviewBillingNotice (billing.ts:67) ← finalizeCodeReviewBillingFailure (billing.ts:198) ← failReviewForInsufficientCredits (dispatch-pending-reviews.ts:616) ← tryDispatchPendingReviews (:376) ← codeReviewRouter.retrigger (code-reviews-router.ts:735). Tags: handled=yes, operation=code-review-billing-post-notice. 3 occurrences, 0 users impacted.
- Axiom vercel dataset (summarized from triage, same review): over about 3 minutes, check-runs POST returned 422 'No commit found for SHA', GET pulls/{n} returned 404, two dispatched sessions failed with 'Requested repository branch was not found', the payer balance was 0, and GET issues/{n}/comments returned 404 (the captured event).
- Pinned billing.ts:168-208: finalizeCodeReviewBillingFailure catches closeProviderGate and postCodeReviewBillingNotice failures. Both call errorExceptInTest and captureException, under tags code-review-billing-close-provider-gate and code-review-billing-post-notice. Status 404 is not treated differently.
- Pinned adapter.ts:598-660: scanPRIssueComments calls issues.listComments with no 404 handling. Other adapter functions, such as fetchPullRequestByNumber (adapter.ts:1218-1322), already map `isHttpError(error) && error.status === 404` to null and log a warning.
- Pinned code-reviews-router.ts:619-746: retrigger checks ownership, status, and config, then calls resetCodeReviewForRetry, createCodeReviewAttempt, recreatePRGateCheck (failures only logged), and tryDispatchPendingReviews(owner). Nothing checks that the provider PR still exists.
- postCodeReviewBillingNotice is also called from the code-review status callback route (route.ts:1875, 1953), so a change inside postCodeReviewBillingNotice would also affect that caller. Keeping the change in finalizeCodeReviewBillingFailure's catch avoids this.
- Existing tests: routers/code-reviews-router.test.ts (retrigger cases around lines 2251-2570), lib/code-reviews/dispatch/dispatch-pending-reviews.test.ts (mocks hasPRCommentWithMarker and @sentry captureException), adapter.test.ts (fetchPullRequestByNumber 404 → null).

## Desired outcome

If the stored GitHub PR is confirmed gone (404), retriggering it fails immediately with a specific error. The review is not reset, no gate check is re-created, and no sandbox session is dispatched. When a terminal billing-failure path hits a GitHub 404 for the PR or repo, it logs a warning and does not create an error-level Sentry event. All other provider failures are still captured as before.

## Scope

- Retrigger preflight in codeReviewRouter.retrigger for GitHub reviews that have an integration with platform_installation_id. Call the existing fetchPullRequestByNumber before resetCodeReviewForRetry. If it returns null, throw a TRPCError BAD_REQUEST with a specific message, e.g. 'This pull request is no longer available on GitHub (deleted, or the repository is no longer accessible to Kilo), so the review cannot be retried.'
- Fail-open preflight: rate-limit, 5xx, network, or token-generation errors from the preflight are logged and the retrigger continues as it does today. Only a definitive 404 blocks it.
- In finalizeCodeReviewBillingFailure, treat a GitHub HTTP 404 from postCodeReviewBillingNotice as an expected 'provider resource gone' condition: log a warning with the reviewId and skip captureException. Apply the same 404 handling to closeProviderGate's catch. Other errors keep the current errorExceptInTest + captureException behavior.
- Unit tests for both behaviors.

## Exclusions

- Narrowing the owner-wide tryDispatchPendingReviews(owner) call made by retrigger. Other pending reviews of the same owner may still be dispatched; that is a separate design decision.
- GitLab and Bitbucket preflight or 404 classification. GitLab adapter errors have a different shape and were not seen in this incident.
- Changing hasPRCommentWithMarker/scanPRIssueComments to swallow 404s. The status-callback route and other callers rely on them throwing.
- Changing the 422 'No commit found for SHA' handling in recreatePRGateCheck (already non-blocking), and detecting stale repo renames or transfers.
- Blocking retrigger for closed or merged PRs (they still resolve and are out of scope).

## Approach

- Router: in retrigger, after the ownership, status, and config checks and before ensureCurrentCodeReviewAttemptFromReview/resetCodeReviewForRetry, add a small helper (e.g. `assertProviderPullRequestStillExists(review)`). It does work only when the platform is GitHub, review.platform_integration_id is set, getIntegrationById returns an integration with platform_installation_id, and shouldPublishCodeReviewToProvider(review) is true. Manual or local reviews keep current behavior.
- The helper splits review.repo_full_name into owner/repo and calls fetchPullRequestByNumber({ installationId: Number(platform_installation_id), owner, repo, number: review.pr_number, appType: integration.github_app_type ?? 'standard' }). If the result is null, it throws a TRPCError BAD_REQUEST with the specific 'pull request no longer available' message. The router's existing catch rethrows TRPCErrors, so the client sees the message. Any other thrown error (including GitHubRateLimitError) is caught, logged with logExceptInTest/warn, and ignored.
- Billing: add a local `isProviderNotFoundError(error)` in billing.ts. It returns true for objects with numeric `status === 404`, which is the Octokit RequestError shape and matches adapter.ts isHttpError. In finalizeCodeReviewBillingFailure, both the closeProviderGate and postCodeReviewBillingNotice catches log a warning (e.g. '[code-review-billing] Pull request or repository no longer available; skipping billing notice') with the reviewId and return without captureException when this is true. Otherwise they behave as today.
- Tests: extend routers/code-reviews-router.test.ts with (a) a GitHub review whose PR fetch returns null → retrigger rejects with BAD_REQUEST containing the message; the review status stays terminal, no attempt row is created, and createCheckRun and dispatch are not called; (b) PR fetch throws a non-404 error → retrigger proceeds as before. Extend dispatch-pending-reviews.test.ts (or add billing.test.ts) so that mockHasPRCommentWithMarker rejecting with { status: 404 } results in no captureException call while the review is still marked failed, and rejecting with { status: 500 } still calls captureException with operation code-review-billing-post-notice.
- Mention 'Fixes KILOCODE-WEB-28HJ' in the PR or commit.

## Affected areas

- apps/web/src/routers/code-reviews/code-reviews-router.ts (retrigger preflight)
- apps/web/src/lib/code-reviews/billing.ts (finalizeCodeReviewBillingFailure catch classification)
- apps/web/src/routers/code-reviews-router.test.ts
- apps/web/src/lib/code-reviews/dispatch/dispatch-pending-reviews.test.ts (or new apps/web/src/lib/code-reviews/billing.test.ts)

## Acceptance criteria

### ac-1: Retriggering a failed, cancelled, or interrupted GitHub review whose PR lookup returns 404 (fetchPullRequestByNumber → null) rejects immediately with a BAD_REQUEST TRPCError. The message says the pull request is no longer available on GitHub. The review keeps its terminal status, no new attempt row is created, no check run is created, and tryDispatchPendingReviews is not invoked. A router unit test covers this.

**Verification:** Code review

### ac-2: If the preflight PR lookup throws a non-404 error (e.g. rate limit or 5xx), the retrigger is not blocked: the review is reset and dispatch is attempted exactly as before. Reviews without a GitHub installation, and manual or non-provider-published reviews, skip the preflight. A router unit test covers the throwing case.

**Verification:** Code review

### ac-3: When finalizeCodeReviewBillingFailure hits a provider error with status 404 from postCodeReviewBillingNotice or closeProviderGate, it logs a warning that includes the reviewId and does not call captureException. The review's insufficient-credits failure is still recorded. A unit test covers this.

**Verification:** Code review

### ac-4: Non-404 failures in finalizeCodeReviewBillingFailure (e.g. status 500 or a non-HTTP error) still call captureException with the existing operation tags code-review-billing-post-notice / code-review-billing-close-provider-gate. hasPRCommentWithMarker, scanPRIssueComments, and the status-callback route's direct postCodeReviewBillingNotice calls are unchanged. A unit test covers this, and source review confirms the unchanged callers.

**Verification:** Code review

### ac-5: Failure UX check, recorded in the PR description. Gone PR: the user learns the outcome from the retrigger response in one GitHub round trip, instead of waiting through sandbox dispatch and a delayed failure. Genuine retriggers: they gain at most one extra GitHub PR fetch before reset, with no new retries or timeouts.

**Verification:** Manual: reviewer confirms the PR description states both effects (fail-fast for gone PRs; at most one extra GitHub call for valid retriggers)

## Risks

- A transient or permission-related 404, e.g. the GitHub App briefly losing access to a repository, would block a manual retrigger. This is acceptable because the review could not run in that state anyway, and the message tells the user why.
- The extra PR fetch adds latency and GitHub API usage to each GitHub retrigger. It is bounded to one call and fails open on non-404 errors.
- Suppressing 404 captures could hide a real bug that targets the wrong repo or PR. The warning log keeps a signal in Axiom, and the retrigger preflight surfaces the same condition to the user.
- The deployed release (ebf5c14b) differs from the pinned commit (e95c34aa). Stack line numbers match the pinned files, so drift risk is low.

## Assumptions

- Octokit RequestError exposes a numeric `status`, which adapter.ts isHttpError already relies on, so a 404 from listComments/createComment/updateCheckRun can be detected in billing.ts without new dependencies.
- fetchPullRequestByNumber's existing 'null on 404, throw otherwise' contract is suitable for the retrigger preflight.
- Downgrading the deliberate capture to a warning only for 404 fits the documented intent of finalizeCodeReviewBillingFailure (report terminal reviews cleanly) and does not need a product decision. The triage's open question m2 is resolved this way, and the decision is recorded.

## Decisions

### d-1: How should GitHub 404s on the terminal billing-notice and gate-close paths be reported?

**Answer:** Log a warning and skip captureException for status 404 only. All other errors are still captured with the existing tags.

**Blocking:** no

### d-2: Should retrigger validate that the provider PR still exists before resetting and dispatching?

**Answer:** Yes, for GitHub reviews with an installation. Block only on a definitive 404 and fail open on any other preflight error.

**Blocking:** no

### d-3: Should the owner-wide dispatch triggered by a single retrigger be narrowed in this change?

**Answer:** No. It is excluded to keep the change small; a separate follow-up can handle it.

**Blocking:** no
