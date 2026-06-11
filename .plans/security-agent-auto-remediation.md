# Security Agent Auto Remediation Implementation Plan

## Goal

Add Security Agent Auto Remediation: an opt-in Security Agent feature that starts Cloud Agent remediation work for eligible Security Findings and records the pull request outcome.

Auto Remediation must be separate from legacy Auto Fix. See [ADR 0001](../docs/adr/0001-security-remediation-separate-from-auto-fix.md).

## Product Decisions

- Feature name: **Auto Remediation**.
- Durable work item: **Security Remediation**.
- Per-run unit: **Security Remediation Attempt**.
- Auto Remediation is off by default.
- Manual action label: **Start remediation**.
- Security Agent does not use legacy `auto_fix_tickets`.
- Cloud Agent opens the pull request. Security Agent records, validates, and displays the result.
- No feature flag.
- No settings-time or launch-time GitHub write-permission preflight in Security Agent.
- Security Agent keeps findings `open` while remediations are queued, running, or PR-opened.

## Current Integration Points

- Security Agent config lives in `agent_configs` with `agent_type = 'security_scan'`.
- Auto Analysis admission currently lives in `apps/web/src/lib/security-agent/router/shared-handlers.ts` and `apps/web/src/lib/security-agent/db/security-analysis.ts`.
- Analysis callback finalization lives in `services/security-auto-analysis/src/callbacks.ts`.
- Cloud Agent sessions are launched through `prepareSession` plus `initiateFromPreparedSession`.
- Slack/Kilo Bot PR creation uses ordinary Cloud Agent sessions and prompt instructions, not a PR-specific API.

## Data Model

Update `packages/db/src/schema.ts` and generate migrations with `pnpm drizzle generate`.

### Security Agent Config

Extend `SecurityAgentConfigSchema`, defaults, router schemas, UI state, and worker config parsing:

- `auto_remediation_enabled: boolean`, default `false`
- `auto_remediation_min_severity: 'critical' | 'high' | 'medium' | 'all'`, default `high`
- `auto_remediation_include_existing: boolean`, default `false`
- `auto_remediation_enabled_at: string | null`
- `remediation_model_slug: string`

Behavior:

- `remediation_model_slug` is always visible in settings.
- When unset, default it from the current analysis model on save/load, then treat it independently.
- When Auto Remediation toggles from off to on, set `auto_remediation_enabled_at` to now.
- Turning Auto Remediation off stops future automatic admission. It does not cancel running attempts.

### New Table: `security_remediations`

Parent row, one per Security Finding.

Suggested fields:

- `id`
- owner refs: `owned_by_organization_id`, `owned_by_user_id`
- `finding_id` unique, FK to `security_findings`
- `repo_full_name`
- `status`: `queued`, `running`, `pr_opened`, `failed`, `blocked`, `no_changes_needed`, `cancelled`
- latest outcome summary fields:
  - `latest_attempt_id`
  - `latest_analysis_fingerprint`
  - `latest_analysis_completed_at`
  - `pr_url`
  - `pr_number`
  - `pr_draft`
  - `pr_head_branch`
  - `pr_base_branch`
  - `failure_code`
  - `blocked_reason`
  - `outcome_summary`
- timestamps: `created_at`, `updated_at`, `completed_at`

Indexes:

- owner + status
- finding id
- repo + status

### New Table: `security_remediation_attempts`

Queueable attempt row. A new attempt represents a new Cloud Agent remediation session. Launch retries before session creation stay on the same attempt.

Suggested fields:

- `id`
- `remediation_id`, FK
- `finding_id`, FK
- owner refs
- `repo_full_name`
- `origin`: `auto_policy`, `bulk_existing`, `manual`
- `status`: `queued`, `launching`, `running`, `pr_opened`, `failed`, `blocked`, `no_changes_needed`, `cancelled`
- `attempt_number`
- `retry_of_attempt_id`
- `requested_by_user_id`
- `analysis_fingerprint`
- `analysis_completed_at`
- `remediation_model_slug`
- `branch_name`
- Cloud Agent ids:
  - `cloud_agent_session_id`
  - `kilo_session_id`
  - `execution_id`
- queue/claim fields:
  - `priority`
  - `claim_token`
  - `claimed_at`
  - `claimed_by_job_id`
  - `launch_attempt_count`
  - `next_retry_at`
- callback auth:
  - `callback_attempt_token_hash` or equivalent safe token reference
- outcome fields:
  - `failure_code`
  - `blocked_reason`
  - `last_error_redacted`
  - `structured_result`
  - `final_assistant_message`
  - `validation_evidence`
  - `risk_notes`
  - `draft_reason`
  - PR fields: `pr_url`, `pr_number`, `pr_draft`, `pr_head_branch`, `pr_base_branch`
- cancellation fields:
  - `cancellation_requested_at`
  - `cancellation_requested_by_user_id`
- timestamps: `queued_at`, `launched_at`, `completed_at`, `created_at`, `updated_at`

Indexes:

- owner claim path for `status = 'queued'`
- repo claim path for `status = 'queued'`
- owner in-flight path for `launching`/`running`
- repo in-flight path for `launching`/`running`
- remediation + attempt number unique
- finding + analysis fingerprint
- cloud agent session id

Use guarded transactions to enforce:

- one active queued/launching/running attempt per remediation
- one active running remediation per owner
- one active running remediation per repo
- no automatic duplicate for the same finding and analysis fingerprint after active or terminal semantic outcomes

### Extend `security_agent_commands`

Add:

- `command_type: 'apply_auto_remediation'`
- `origin: 'settings_include_existing'`
- `result_metadata: jsonb`

Use this only for include-existing backlog admission. Manual per-finding remediation returns remediation/attempt ids directly.

### Soft Delete

Update `softDeleteUser` for user-owned `security_remediations`, `security_remediation_attempts`, and any new command metadata if needed. Add tests in `apps/web/src/lib/user.test.ts`.

## Eligibility Policy

Implement one shared eligibility module used by web routers, Worker admission, reconciler, and UI summary.

### Safety Gates

Required for all origins:

- finding belongs to the owner
- finding `status = 'open'`
- repo is currently selected/enabled for Security Agent based on local config
- analysis status is `completed`
- sandbox analysis exists
- `sandboxAnalysis.isExploitable === true`
- `sandboxAnalysis.suggestedAction === 'open_pr'`
- analysis is fresh relative to the latest finding sync
- latest analysis fingerprint is known
- there is no queued/launching/running remediation for the finding
- there is no known `pr_opened` remediation for the finding
- action is concrete enough:
  - patched version plus package/manifest metadata, or
  - concrete `sandboxAnalysis.suggestedFix`, or
  - usage locations plus an actionable fix

Do not allow remediation for:

- `manual_review`
- `monitor`
- `isExploitable: 'unknown'`
- triage-only analysis

### Automatic Gates

For `auto_policy`:

- Auto Remediation enabled
- severity meets `auto_remediation_min_severity`
- `analysis_completed_at >= auto_remediation_enabled_at`
- no active or terminal semantic outcome for the same analysis fingerprint

For `bulk_existing`:

- Auto Remediation enabled
- `auto_remediation_include_existing` enabled
- severity meets threshold
- older analyses may be admitted
- same fingerprint dedupe applies

### Manual Gates

Manual `Start remediation` bypasses only:

- Auto Remediation enabled
- severity threshold
- enablement timestamp

Manual still requires all safety gates.

Manual retry is allowed for terminal `failed`, `blocked`, `no_changes_needed`, and `cancelled` attempts if safety gates still pass and no PR is open. It is not allowed for `pr_opened` in v1 because PR lifecycle is not synced.

## Analysis Callback Admission

In `services/security-auto-analysis/src/callbacks.ts`:

1. Finalize completed sandbox analysis.
2. Run Auto Dismiss first.
3. If finding is still open, call idempotent Auto Remediation admission.
4. Do not wrap remediation admission in the same transaction as analysis finalization.
5. Do not fail or roll back completed analysis for expected remediation admission failures.

Admission should:

- compute analysis fingerprint
- check eligibility for `auto_policy`
- create/update parent remediation row
- create queued attempt
- enqueue attempt launch message
- write audit/analytics

If queue admission fails after DB rows are created, either mark attempt failed with queue-admission failure or retry via callback queue if idempotent.

## Include Existing Flow

Product behavior should mirror Auto Analysis include-existing.

Triggers during settings save:

- `auto_remediation_include_existing` turns on while Auto Remediation is enabled
- Auto Remediation is re-enabled while include-existing is already on
- severity threshold changes while both Auto Remediation and include-existing are on

Implementation:

- settings save creates `security_agent_commands` row with `command_type = 'apply_auto_remediation'`
- enqueue command to a remediation command queue in `services/security-auto-analysis`
- command worker scans local eligible findings and admits `bulk_existing` remediation attempts idempotently
- command status stores counts in `result_metadata`

Do not create a separate batch table.

## Reconciler

Deferred from v1. Manual remediation remains the fallback when an automatic admission is missed.

Purpose:

- recover missed `auto_policy` admissions after callback/admission failures
- when include-existing is enabled, recover missed older eligible admissions too

Future implementation rules:

- create remediation attempts directly in small batches
- use the shared eligibility function
- never create duplicates for the same finding/fingerprint
- do not retry terminal semantic outcomes automatically

## Attempt Launch Worker

Add remediation attempt queue handling to `services/security-auto-analysis`.

Claiming:

- one active remediation per owner
- one active remediation per repo
- manual priority before bulk_existing before auto_policy
- launch retries use `launch_attempt_count` and `next_retry_at`

Before launch, re-check local eligibility:

- current finding status/config/selection
- current threshold for automatic origins
- current remediation state
- same repo/package/manifest open PR suppression based on existing `pr_opened` remediation records

If a queued automatic attempt no longer qualifies:

- mark `blocked`, not silently delete
- examples: `AUTO_REMEDIATION_DISABLED`, `BELOW_CURRENT_THRESHOLD`, `STALE_ANALYSIS`, `COVERED_BY_EXISTING_REMEDIATION_PR`

## Cloud Agent Launch

Use existing Cloud Agent session API:

- `prepareSession`
- `initiateFromPreparedSession`

Do not use legacy Auto Fix infra.
Do not use `autoCommit: true`.
Do not have Security Agent create the PR after callback.

Prepare input:

- `createdOnPlatform: 'security-remediation'`
- `mode: 'code'`
- `model: remediation_model_slug`
- `githubRepo: finding.repo_full_name`
- `upstreamBranch: deterministicBranchName`
- `callbackTarget` with scope `security-remediation-callback`
- remediation prompt

Branch naming:

- include package/advisory segment and stable ids
- include attempt number from the start
- example: `security-remediation/lodash-ghsa-xxxx/<finding-short>-1`
- cap length and sanitize aggressively

Auth assumption to validate during implementation:

- Security Agent may still need a Kilo API token to call Cloud Agent and own the session.
- That token must not imply the remediation actor or PR author.
- Cloud Agent should resolve repository write auth for `createdOnPlatform = 'security-remediation'`, preferably installation-only.
- Avoid passing a GitHub token from Security Agent if Cloud Agent can resolve repo auth from owner/session metadata.

## Cloud Agent Guard

Add a command guard for `createdOnPlatform = 'security-remediation'`.

Allow:

- repo inspection
- package manager install/update commands
- narrow test/build commands
- git branch/status/diff/add/commit/push as needed
- `gh pr create`
- `gh pr view`

Deny:

- PR merge/close/edit operations
- repo creation/forking/settings operations
- destructive shell commands
- arbitrary external network commands outside package manager and official metadata needs
- secrets access or credential exfiltration

This guard should be tighter than Slack and less restrictive than Code Review.

## Remediation Prompt

Prompt must include:

- finding metadata
- package/advisory metadata
- manifest path and package ecosystem
- patched version when present
- structured sandbox analysis
- raw sandbox analysis markdown in an untrusted context section
- stable Kilo finding URL
- required branch name
- required PR title/body guidance
- validation expectations
- prompt-injection warning for all finding/advisory/analysis text

Prompt rules:

- treat analysis as decision input; do not re-litigate exploitability
- make the smallest safe code change
- use the repo's actual package manager/lockfile workflow
- allow manifest, lockfile, Dockerfile, CI, and build/deploy changes only when directly required
- do not open no-change PRs
- open a draft PR if validation is incomplete or risk is nontrivial
- include Kilo finding backlink in PR body
- include validation and risk notes in PR body

## Structured Result Contract

Require final assistant response to contain a machine-readable block:

```text
SECURITY_REMEDIATION_RESULT
{ ...json... }
END_SECURITY_REMEDIATION_RESULT
```

Suggested JSON:

```json
{
  "status": "pr_opened",
  "prUrl": "https://github.com/org/repo/pull/123",
  "prNumber": 123,
  "draft": false,
  "headBranch": "security-remediation/pkg-ghsa/finding-1",
  "baseBranch": "main",
  "summary": "Updated vulnerable dependency and lockfile.",
  "validation": [
    {
      "command": "pnpm test -- package",
      "outcome": "passed",
      "summary": "Relevant tests passed."
    }
  ],
  "riskNotes": "No breaking API changes expected.",
  "draftReason": null,
  "errorReason": null
}
```

Accepted statuses:

- `pr_opened`
- `failed`
- `blocked`
- `no_changes_needed`
- `cancelled`

Callback handling:

- parse from `lastAssistantMessageText`
- if malformed, try PR recovery by expected branch
- if exactly one open PR exists for expected branch, mark `pr_opened` with warning
- if zero/multiple PRs, mark failed with `MISSING_REMEDIATION_RESULT`
- verify parsed/recovered PR exists and matches expected repo/branch before marking `pr_opened`

`interrupted` callback mapping:

- if cancellation requested, mark `cancelled`
- if no cancellation requested, mark `failed` with `CLOUD_AGENT_INTERRUPTED`

If Cloud Agent returns `pr_opened` after cancellation was requested, persist the PR and mark `pr_opened`.

## Cancellation

Queued attempts:

- cancel locally in a transaction
- parent becomes `cancelled` if this is the latest active attempt

Running attempts:

- set `cancellation_requested_at` and `cancellation_requested_by_user_id`
- keep status `running`
- call Cloud Agent `interruptSession`
- derive UI state as "cancelling" from running plus cancellation requested
- map interrupted callback to cancelled

## API and Routers

Extend shared Security Agent handlers.

Settings:

- personal: existing personal Security Agent mutation
- org: `organizationBillingMutationProcedure`

Manual remediation actions:

- `startRemediation`
- `retryRemediation`
- `cancelRemediation`
- personal: finding owner
- org: `organizationMemberMutationProcedure`

Queries:

- finding list returns latest remediation summary and capability reason enums
- finding detail returns remediation summary plus attempt history
- command status supports `apply_auto_remediation`

Return from manual start:

- `securityRemediationId`
- `securityRemediationAttemptId`

## UI

Update existing Security Agent UI.

Config page:

- Auto Remediation toggle
- severity threshold
- include existing analyzed findings toggle
- remediation model selector, always visible
- no GitHub write-permission preflight UI
- distinguish from legacy Auto Fix in copy

Finding list:

- remediation badge: queued, running, PR opened, failed, blocked, no changes, cancelled
- PR link when available
- disabled/action reason tooltip from server summary

Finding detail:

- Start remediation button when eligible
- Cancel for queued/running
- Retry for retryable terminal statuses
- attempt history with requester, model, status, PR, validation, failure/block reasons
- remediation audit events in finding timeline/history

## Audit and Analytics

Add Security Audit Log actions for user-visible milestones:

- remediation requested/queued
- remediation started
- remediation PR opened
- remediation failed
- remediation blocked
- remediation no changes needed
- remediation cancelled
- remediation retried

Audit resource:

- `resource_type: 'security_remediation'`
- `resource_id: remediationId`
- metadata includes `findingId`, `attemptId`, `origin`, `requestedByUserId`, PR fields, analysis fingerprint

Analytics:

- config changed
- remediation admitted/requested
- launch started
- callback outcome
- PR opened
- failed/blocked/no changes
- manual retry/cancel
- include-existing command counts

Automatic post-analysis remediation actor:

- system/null actor
- preserve who enabled config via config audit
- preserve analysis trigger user only as analysis metadata

Bulk/include-existing:

- origin `bulk_existing`
- store settings user as `requested_by_user_id`

## Failure Semantics

Use separate remediation failure codes. Do not reuse Auto Analysis failure codes.

Examples:

- `LAUNCH_NETWORK_TIMEOUT`
- `LAUNCH_UPSTREAM_5XX`
- `CLOUD_AGENT_REPO_ACCESS_BLOCKED`
- `CLOUD_AGENT_INTERRUPTED`
- `MISSING_REMEDIATION_RESULT`
- `INVALID_REMEDIATION_RESULT`
- `INVALID_PR_OUTCOME`
- `PR_VERIFICATION_FAILED`
- `QUEUE_ADMISSION_FAILED`
- `AUTO_REMEDIATION_DISABLED`
- `BELOW_CURRENT_THRESHOLD`
- `STALE_ANALYSIS`
- `COVERED_BY_EXISTING_REMEDIATION_PR`

Status semantics:

- `blocked`: external/precondition blocker, not agent failure
- `failed`: execution or system failure
- `no_changes_needed`: terminal semantic outcome, not a failure code
- `pr_opened`: terminal for v1

## Testing

Unit tests:

- config schema defaults and save mapping
- eligibility policy for auto, bulk, manual, retry
- severity threshold helper
- analysis fingerprint helper
- branch naming
- result parser and malformed recovery
- failure/status mapping
- cancellation mapping

DB/integration tests:

- security_remediations owner constraints
- attempt status constraints
- one active attempt guard
- command ledger new type/origin/result metadata
- softDeleteUser cleanup

Worker tests:

- post-analysis admission after callback
- Auto Dismiss runs before Auto Remediation
- include-existing command scans and admits idempotently
- reconciler admits missed work without duplicating
- attempt claim ordering and owner/repo caps
- launch retry behavior
- Cloud Agent callback idempotency and stale token/session rejection

Router tests:

- settings save fields and include-existing command admission
- personal/org permissions
- manual start/retry/cancel
- list/detail remediation summary

UI tests:

- config controls render and save
- remediation badges and PR links
- button availability/reason mapping
- detail attempt history

Targeted verification:

- run relevant unit/integration tests only
- run `pnpm format` before committing
- generate migrations with `pnpm drizzle generate`

## Implementation Phases

### Phase 1: Schema and Config

- add config fields/defaults
- add remediation tables
- extend command ledger
- update schema types, soft delete, migrations
- update context exports/types

### Phase 2: Eligibility and Admission

- implement shared eligibility module
- implement analysis fingerprinting
- add parent/attempt repository helpers
- add manual start/retry/cancel handlers
- add include-existing command admission

### Phase 3: Worker Orchestration

- add remediation attempt queue consumer
- add remediation command queue consumer
- add callback endpoint/queue handling
- add reconciler
- add Cloud Agent launch helper

### Phase 4: Cloud Agent Contract

- add `security-remediation` command guard
- build remediation prompt
- parse structured result
- verify/recover PR outcome
- wire cancellation via `interruptSession`

### Phase 5: UI

- config controls
- list/detail remediation summaries
- action buttons
- attempt history
- audit timeline inclusion

### Phase 6: Observability and Polish

- audit actions
- PostHog events
- operational logs
- failure reason text
- docs/readme updates if needed

## Open Implementation Checks

- Confirm Cloud Agent can launch a `security-remediation` session without Security Agent passing a GitHub token.
- Confirm how to generate the Kilo API token used only to authorize the Cloud Agent session for automatic/system-origin remediations.
- Confirm PR verification can use existing GitHub installation auth without reintroducing settings-time or launch-time preflight.
