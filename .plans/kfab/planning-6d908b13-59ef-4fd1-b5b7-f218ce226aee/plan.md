<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

fix(code-reviews): route wrapped GitLab PrAT permission errors to Maintainer guidance and stop error-level Sentry capture for action-required failures

## Problem

Sentry KILOCODE-WEB-1RFS (1373 lifetime occurrences, still happening) reports "Failed to create Project Access Token for GitLab code review on <repo>. Error: Cannot create bot token for project 34. You need Maintainer role or higher." from POST /api/webhooks/gitlab → tryDispatchPendingReviews → dispatchReservedReview → prepareReviewPayload. The cause is on the customer side: the connected GitLab credential does not have the Maintainer role, so GitLab returns 403 when we try to create a Project Access Token. The product already handles this. The dispatcher classifies the message as gitlab_project_access_required, fails the review, disables Code Reviewer, and emails the owner. Two code defects remain. (1) gitlab-service.getOrCreateProjectAccessToken wraps GitLabProjectAccessTokenPermissionError in a TRPCError FORBIDDEN, so the bare `instanceof GitLabProjectAccessTokenPermissionError` check in prepare-review-payload never matches. The generic fallback message runs instead, and it includes the raw numeric GitLab project id. The sibling 401 case already unwraps the cause through isGitLabReconnectRequiredError. (2) prepareReviewPayload's outer catch always calls captureException at error level. So this expected failure, which the dispatcher has already classified and reported to the owner, creates recurring Sentry noise.

## Evidence

- Sentry KILOCODE-WEB-1RFS (anaconda-nq/7389808140), latest event f417f08ec982410398ed4f2f9555de77: frame prepare-review-payload.ts:566 is the generic `throw new Error('Failed to create Project Access Token ...')` branch. Tags: handled=yes, level=error, operation=prepareReviewPayload. First seen 2026-04-06, last seen 2026-10-29, 0 users (webhook context).
- Pinned source apps/web/src/lib/integrations/gitlab-service.ts (~lines 766-779): GitLabProjectAccessTokenPermissionError is rethrown as `new TRPCError({ code: 'FORBIDDEN', message: 'Cannot create bot token for project ${projectId}. You need Maintainer role or higher.', cause })`. This text matches the inner message in the Sentry title exactly.
- Pinned source prepare-review-payload.ts (~lines 552-569): catch checks isGitLabReconnectRequiredError (cause-aware), then a bare `instanceof GitLabProjectAccessTokenPermissionError`, then the generic throw.
- Pinned source apps/web/src/lib/integrations/platforms/gitlab/credential-errors.ts: isGitLabReconnectRequiredError already unwraps a TRPCError UNAUTHORIZED cause and Error.cause. No equivalent helper exists for the permission case.
- prepare-review-payload.test.ts 'keeps Maintainer-role guidance when GitLab refuses the role' mocks getOrCreateProjectAccessToken rejecting with the *unwrapped* adapter error. Production never produces that shape, so the test hides the bug.
- Pinned source prepare-review-payload.ts (~lines 961-979): the outer catch calls captureException for every error before rethrowing.
- Pinned source dispatch-pending-reviews.ts (~lines 166-171, 383-480): getActionRequiredReasonFromError → classifyCodeReviewActionRequiredFailure. Classified failures are disabled, failed with action-required copy, and skip the dispatcher's own captureException.
- Pinned source action-required.ts (~lines 125-134): gitlab_project_access_required matches messages that contain 'project access token' plus either 'failed to create project access token for gitlab code review' or 'cannot create project access token for gitlab code review' (and other fragments).
- Triage evidence: Sentry message-family aggregation (1RFS, 23KH, 28AS, 285P) and an Axiom 'vercel' dataset sample over 7 days (2 matching log lines) show low-volume, single-tenant recurrence.

## Desired outcome

When GitLab refuses Project Access Token creation for permission reasons, prepareReviewPayload throws the intended repo-named Maintainer-role guidance, with no raw numeric project id. The dispatcher keeps classifying it as gitlab_project_access_required, failing the review, disabling Code Reviewer, and emailing the owner just as quickly as today. Failures that already classify as action-required are no longer reported to Sentry at error level from prepareReviewPayload. They are still logged, and unclassified failures are still captured.

## Scope

- Add a cause-aware helper (e.g. isGitLabProjectAccessTokenPermissionError) in apps/web/src/lib/integrations/platforms/gitlab/credential-errors.ts. It recognizes a direct GitLabProjectAccessTokenPermissionError, a TRPCError FORBIDDEN whose cause is that class, and an Error whose cause is that class.
- Use the helper in the prepare-review-payload.ts GitLab PrAT catch in place of the bare instanceof. Keep the reconnect check first. Change the thrown message to name only review.repo_full_name: no numeric project id, and no wrapped inner message that contains it. The message must still match the existing gitlab_project_access_required classifier.
- In the prepareReviewPayload outer catch, skip captureException when classifyCodeReviewActionRequiredFailure(getErrorMessage(error)) returns a reason. Keep the existing error log (or downgrade it to a warning that includes the reason) so the failure stays visible in logs.
- Update and add unit tests in prepare-review-payload.test.ts and credential-errors tests (or the nearest existing test file).

## Exclusions

- No change to GitLab's Maintainer requirement or to PrAT creation, rotation, or validation logic in adapter.ts or gitlab-service.ts.
- No reclassification of GitLab 400 'User does not have permission to create project access token' (KILOCODE-WEB-23KH) as a typed permission error. It already reaches the generic message, which the classifier handles. It benefits from the capture change only.
- No change to dispatcher action-required handling, disable/email behavior, or user-facing copy in packages/app-shared.
- No Sentry ignore rules or other external configuration changes.
- No change to merge-request-handler's best-effort PrAT use for commit status and reactions.

## Approach

- credential-errors.ts: export isGitLabProjectAccessTokenPermissionError(error). Return true for `error instanceof GitLabProjectAccessTokenPermissionError`; for a TRPCError with code 'FORBIDDEN' and `cause instanceof GitLabProjectAccessTokenPermissionError`; and for any Error whose cause is that class. Mirror the structure of isGitLabReconnectRequiredError.
- prepare-review-payload.ts GitLab branch: replace `pratError instanceof GitLabProjectAccessTokenPermissionError` with the helper and throw `Cannot create Project Access Token for GitLab code review. You need Maintainer role or higher on project ${review.repo_full_name}.` with `{ cause: pratError }` so the original error stays attached for debugging. Do not interpolate pratError.message, which carries the numeric id. Remove the now-unused direct class import if it becomes unused.
- prepare-review-payload.ts outer catch: compute `const actionRequiredReason = classifyCodeReviewActionRequiredFailure(getErrorMessage(error))` (import from '@/lib/code-reviews/action-required', and reuse an existing error-message helper if one is available). If non-null, log a warning tagged with the reason and rethrow without captureException. Otherwise keep the existing captureException call unchanged. This classifies with the same function the dispatcher uses, so the two layers agree on what counts as expected.
- Tests: (a) mock getOrCreateProjectAccessToken rejecting with `new TRPCError({ code: 'FORBIDDEN', message: 'Cannot create bot token for project 456. ...', cause: new GitLabProjectAccessTokenPermissionError(...) })`. Assert the rejection contains 'You need Maintainer role or higher on project <REPO>', does not contain 'project 456', classifies as gitlab_project_access_required, and captureException was not called. (b) Keep the direct-error test. (c) Keep or confirm the existing test at ~line 288-295: an unclassified error is still passed to captureException. (d) Add unit tests for the new helper covering direct, TRPCError-wrapped, Error.cause-wrapped, and non-matching inputs (TRPCError UNAUTHORIZED, a plain Error).

## Affected areas

- apps/web/src/lib/integrations/platforms/gitlab/credential-errors.ts
- apps/web/src/lib/code-reviews/triggers/prepare-review-payload.ts
- apps/web/src/lib/code-reviews/triggers/prepare-review-payload.test.ts
- Tests for credential-errors (new or existing file next to it)

## Acceptance criteria

### ac-1: When getOrCreateProjectAccessToken rejects with a TRPCError FORBIDDEN whose cause is GitLabProjectAccessTokenPermissionError (the production shape), prepareReviewPayload rejects with a message that contains 'You need Maintainer role or higher on project <repo_full_name>' and does not contain the numeric GitLab project id. A unit test covers this wrapped shape, and the existing direct-error test still passes.

**Verification:** Code review

### ac-2: The new Maintainer-role message still classifies as 'gitlab_project_access_required' via classifyCodeReviewActionRequiredFailure. The dispatcher therefore still fails the review with action-required copy, disables Code Reviewer for non-manual reviews, and emails the owner within the same dispatch attempt, with no added retries or delays before the owner learns the specific reason.

**Verification:** Code review

### ac-3: prepareReviewPayload does not call captureException for errors whose message classifies as an action-required reason (asserted in a unit test for the GitLab permission case). It still logs the failure and rethrows the same error.

**Verification:** Code review

### ac-4: Errors that do not classify as action-required are still passed to captureException with tags.operation='prepareReviewPayload' and the existing extras (the existing capture test remains and passes).

**Verification:** Code review

### ac-5: isGitLabProjectAccessTokenPermissionError returns true for a direct GitLabProjectAccessTokenPermissionError, a TRPCError FORBIDDEN with that cause, and an Error with that cause. It returns false for a TRPCError UNAUTHORIZED and for unrelated errors. The reconnect check keeps precedence in prepare-review-payload.

**Verification:** Code review

### ac-6: After deployment, KILOCODE-WEB-1RFS stops receiving new events from operation=prepareReviewPayload for GitLab permission failures, while the action-required review state and owner email are still produced for affected reviews.

**Verification:** Manual: After release, check Sentry KILOCODE-WEB-1RFS for no new events, and check production logs for the warning-level prepareReviewPayload line on the next GitLab permission failure

## Risks

- Suppressing capture by message classification could hide a real regression whose message happens to match an action-required fragment. Mitigation: the classifier fragments are specific, failures stay logged, and the dispatcher still records the failed review with its reason.
- Removing the inner error text from the Maintainer message reduces debugging detail. Mitigation: attach the original error as `cause` and keep the log line.
- Other action-required reasons (BYOK invalid key, GitHub installation, IP allow list, model unavailable) also stop being captured from prepareReviewPayload. This is intended, because the dispatcher already handles them without capture, but it reduces Sentry volume for those families too.

## Assumptions

- The only path by which GitLabProjectAccessTokenPermissionError reaches prepareReviewPayload is through getOrCreateProjectAccessToken's TRPCError wrapping (validation, rotation, and revocation paths swallow or type their errors, per triage).
- Expected, already-classified customer-configuration failures should not be error-level Sentry events. The triage left this open as non-blocking. This plan adopts suppression with log retention as the default (see decision).
- Tests run with the existing apps/web jest setup. No new verification commands are introduced.

## Decisions

### d-1: Should classified action-required failures be excluded from prepareReviewPayload's Sentry capture, or only the message plumbing fixed?

**Answer:** Exclude them from capture and keep a warning log, using the dispatcher's own classifier, so both layers agree. This removes the recurring noise that the plumbing fix alone would leave.

**Blocking:** no

### d-2: How should the permission error be detected?

**Answer:** Use a cause-aware helper in credential-errors.ts that mirrors isGitLabReconnectRequiredError, rather than changing gitlab-service to stop wrapping (other tRPC callers rely on the FORBIDDEN code and message).

**Blocking:** no
