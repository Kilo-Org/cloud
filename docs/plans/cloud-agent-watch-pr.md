# Cloud Agent PR Maintenance MVP

Date: 2026-11-12
Status: Product contract and storage foundation implemented. Observation, coordination,
runtime execution, and web controls must satisfy the release gate before release.

This plan replaces the observation-only pilot's planned automatic-repair behavior.
The pilot's saved preferences authorize observation only. They never grant automatic
write consent, including when their history-rewrite preference is true.

## 1. Product contract

Offer **Automatically maintain this PR** on a verified GitHub PR linked to a writable
Cloud Agent workspace. Support open PRs whose head and base belong to the same repository.
Fork PRs, arbitrary external PR URLs, legacy ungrouped sessions, and general external-CI
integrations are outside the MVP. Merging remains a user action. GitHub owns approval
requirements and merge rules.

Maintenance handles three categories:

1. Actionable inline review feedback, submitted review bodies, and conversation comments.
2. Terminal failing checks on the current PR head.
3. Merge conflicts with the PR's actual target branch.

A base update without a conflict causes no rebase, push, or maintenance attempt.
Waiting survives browser closure and sleeping compute. It does not run an agent or
keep a sandbox awake. Observe through GitHub webhooks, not recurring GitHub polling.

### Accepted publication and shared-checkout risk

Maintenance chats have the same Git and GitHub access as user chats. Branch, push,
merge, file-selection, and rebase rules are agent instructions, not enforced limits.
The product accepts this risk. Non-bypassable publication enforcement and an exclusive
workspace execution lock are not MVP prerequisites.

The exact lease protects the remote branch against another writer's push. It does not
isolate local edits. User chats and maintenance can change one checkout concurrently.
An untidy checkout is acceptable when a later attempt can recover. Do not claim that
Stop can revoke a push already in flight.

## 2. Enablement, consent, and lifecycle

Enablement verifies the workspace, linked PR, current repository access, and selected
execution settings. Explain that maintenance can edit, commit, rebase, push, and consume
normal credits. Record fresh automatic-write, history-rewrite, and no-hard-spend-cap
consent. Attempt limits and balance checks are not a monetary cap.

Record the selected model, optional variant, profile, environment, trusted review bots,
and enabled repair categories. Assess existing problems immediately through the shared
PR refresh. Future events alone do not satisfy enablement.

Keep watching until the PR closes or merges, the user stops maintenance, or the workspace
is deleted. There is no watch expiry. `expires_at` remains nullable for storage compatibility
only. Do not use it for eligibility, scheduling, or authorization.

Each new maintenance chat revalidates current access and receives fresh automation
authorization. Do not copy an old chat's expired authorization. Maintenance must start
after more than 24 hours without browser activity.

Pause for a user decision, exhausted attempts, unavailable access, or a specific blocker.
Show its reason and recovery action. Rate limits delay work; they do not pause the watch.

Controls: enable, stop, pause, resume, Recheck, and open current or previous maintenance
chats. Stop on a maintenance chat also pauses its watch. New events must not restart
work that the user stopped. Generation changes invalidate queued work. A finished watch
cannot restart through delayed events or a PR reopen event.

## 3. Start-only workspace coordination

Create a fresh maintenance chat for each repair batch. Never inject maintenance work into
an ordinary user chat. Do not create an empty chat while waiting for execution.

Before starting, check that:

- The watch remains enabled and its pending work remains relevant.
- No user chat in the workspace has status `busy`, `retry`, `question`, or `permission`.
- No user chat changed status during the quiet period, using `status_updated_at`.
- No other maintenance attempt is `creating`, `running`, or `needs_input` in that workspace.

When blocked by user work, show **Waiting for your session to finish**. A delayed server
check reads only Kilo state. It does not call GitHub or start an agent. Coordination is
best effort and applies only at start. Do not build a workspace execution lock.

Once maintenance starts, user chats can start or continue independently. Neither kind
of chat delays, stops, or pauses the other. New PR events remain pending for a later batch.

### Shared checkout rules

- Fetch and inspect the checkout and remote branch before changing files.
- Set maintenance messages' `finalization.autoCommit` to false. Auto-commit uses
  `git add -A` and can include another chat's unfinished edits.
- Commit only files maintenance changed. Do not stash or commit unrelated edits.
- User auto-commit skips while a maintenance rebase is in progress.
- A rebase requires a clean checkout. If unrelated edits prevent it, end the attempt
  and retry when the workspace is idle.
- On any maintenance termination, abort an unfinished rebase with `git rebase --abort`.
  Leave other partial edits in place. Do not assume sleeping-sandbox recovery preserves
  or removes uncommitted files.

### Questions

Show **Needs your input** and keep the current maintenance chat pinned while it waits.
The question does not block user chats or keep compute awake. A waiting message ending
with `sandbox_stopped` remains `needs_input`; it is not a failed attempt. The user's
answer continues the same maintenance chat, as a new message after sandbox stop. It
does not wait for other chats. Normal user messages also continue that maintenance chat.

## 4. Shared storage and contracts

Import runtime-safe validation and types from `@kilocode/db/cloud-agent-pr-maintenance`.
The module has no database connection or web/runtime dependency. The existing
`schema-types` entry point re-exports `watchPrPolicySchema`, `WatchPrPolicy`, and
`WatchPrStatus` for compatibility.

### Policy

`watchPrPolicySchema` parses a versioned union without upgrading stored consent:

- `watchPrPolicyV1Schema`: existing observation-only policy, unchanged.
- `watchPrMaintenancePolicySchema`: version 2; requires explicit
  `automaticWritesConsent`, `historyRewriteConsent`, and `noHardSpendCapConsent`, all true.

Version 2 stores `model`, nullable `variant`, nullable `profileId`, nullable `environmentId`,
`trustedBotLogins`, categories `{reviews, failedChecks, conflicts}`, and `branchStrategy: rebase`.
It bounds attempts, batching, and the start quiet period. A rebase remains conflict-only.
`hasWatchPrAutomaticWriteConsent` rejects version 1. Never derive consent from old
preferences or an observation-only watch's existence.

Pilot defaults: two attempts per unresolved problem, ten total attempts, 30-second
batching, two-minute maximum batch wait, three-minute start quiet period, 30-second
busy recheck, 15-minute conflict check interval, three failing-job log reads, 12,000
characters per log, 25 PRs per conflict query, and five delivery attempts. Persist attempt
counts across fresh chats. After exhaustion, show a visible recoverable pause.

### Watch

`cloud_agent_pr_watches.status` owns lifecycle: `watching | paused | finished`.
Independent `execution_status` is
`watching | waiting_for_session | fixing | waiting_for_checks | needs_input`.
Lifecycle takes display precedence when paused or finished.

The watch stores `generation`, `pending_revision`, `pending_since`, `next_run_at`,
`last_assessed_at`, `total_attempts`, `last_attempt_id`, `last_event_at`, and `finished_at`.
Retain its existing exact owner, organization, installation/app, repository/PR, workspace,
source-chat, head/base, policy, projection, and activity contracts. One live watch owns
each repository/PR globally; do not reveal another tenant's details on refusal.

### Attempts

`cloud_agent_pr_maintenance_attempts` stores a stable ID, watch/workspace, generation,
pending revision, lifetime ordinal, session IDs, `creation_operation_key`, `message_id`,
status, immutable `input`, compact `result`, delivery count, next run time, lifecycle
timestamps, and reason. Session IDs remain null until creation is reconciled. Keep the
same operation key and message ID after uncertain transport outcomes.

Statuses: `creating | running | needs_input | completed | failed | stopped`.
A partial unique index permits only one live attempt per workspace, including questions.
Creation, message, session, watch/ordinal, and watch/generation/revision identities are
unique. A deliberate new repair advances the pending revision; a delivery retry does not.
Terminal attempts set `finished_at`; live attempts leave it null.

`watchPrMaintenanceInputSchema` retains a bounded batch of problems, PR purpose, explicit
constraints, repository/branch/head/base/stack-parent identity, policy, lifetime ordinal,
per-problem counts, previous results, prior dispositions, verification commands, and
references. Problems include full bounded feedback and thread IDs, current-head failing
jobs with trimmed logs, or a conflict. Do not append later events to this snapshot.
The JSON input limit is 262,144 characters; at most 50 problems, 50 prior dispositions,
and ten compact previous results are included. Keep detailed history through references,
not the full original chat or every repair transcript.

`watchPrMaintenanceResultSchema` records changed files, verification outcomes, problem
dispositions, publication evidence, and a user-input reason separately. A completed
agent turn does not imply a published repair, passing checks, or approval.

`watchPrPublicationEvidenceSchema` distinguishes `not_attempted`, `unknown`, `failed`,
and `published`. Published evidence requires Git provenance, canonical repository,
branch, observed/pushed/verified remote head SHAs, base SHA, exact branch lease, zero push
exit code, and normalized verification time. The verified remote head must match the
pushed commit. Validate the evidence against the exact attempt/message; an agent summary
alone never proves publication. Update a stacked workspace's recorded parent SHA only
after confirmed publication.

### Feedback dispositions and chat metadata

`cloud_agent_pr_feedback_dispositions` stores watch/attempt, problem key, actionable
content fingerprint, disposition, reason, bounded evidence, thread ID, posted reply ID,
reply body/time, and resolution state/time. Deduplicate by watch/problem/content revision.
Keep addressed, already-addressed, disagreed, deferred, needs-input, and not-actionable
decisions outside chat context. New actionable content is new evidence.

`cli_sessions_v2.chat_kind` is explicitly `user | maintenance` and defaults to `user`.
Nullable `maintenance_watch_id` and `maintenance_attempt_id` link dedicated chats.
Do not reuse `created_on_platform`; it also controls idle policy and telemetry.
Derive automatic chat pinning from its live linked attempt, not from platform or a
persisted pin flag. Terminal attempts lose the pin. Retained chats keep their Maintenance
badge after watch retention clears the links. Mobile and extension clients may initially
show maintenance chats as ordinary chats.

### Retention, privacy, and timestamps

Delete only finished watches after 30 days, measured from `finished_at` or legacy
`updated_at`. Never delete an inactive watching or paused watch. Activity receipts have
their own 30-day retention; live attempt inputs/results and dispositions remain linked
to their watch. Watch deletion cascades activity, private attempt inputs/results, and
feedback dispositions. User soft deletion removes owned watches and thus all these
records. It must preserve another owner's records. Chat references become null without
deleting chat history. Normal chat privacy cleanup still applies.

Session maintenance links are advisory columns without foreign keys on the populated
session table. Retention and user deletion clear these links in the watch-deletion
transaction. The Maintenance kind remains unchanged.

Use text user IDs, including OAuth IDs. Normalize PostgreSQL timestamp strings to UTC ISO
before strict transport validation. Never persist credentials or full unbounded logs.

## 5. Durable observation, batching, and scheduling

Use existing signed GitHub webhook admission, exact tenant/installation identity, and
Cloud Agent infrastructure. Admit events durably before acknowledging success. Observer
save failures must remain retryable; logging a failure and returning success is not
durable admission. Deduplicate deliveries and semantic object revisions. Handle reordered
head/comment/check events without rolling back newer state or guessing success.

Required events for both standard and lite Apps:

| Event | Use |
|---|---|
| `pull_request` | Identity, head/base, retarget, close, merge, reopen ordering. |
| `pull_request_review_comment` | Inline comments and edits/deletions. |
| `pull_request_review` | Submitted/edited/dismissed review bodies. |
| `issue_comment` | Actionable PR conversation comments. |
| `pull_request_review_thread` | Thread resolution changes. |
| `check_run`, `status` | Current-head check evidence. |
| `push` | Exact head/base branch changes and file overlap. |

Verify remote subscriptions and grants separately; source changes do not configure Apps.
Webhook payloads supply reviewer association and branch changes without API lookups.
Retain bounded early-SHA evidence when check events arrive before head identity.
Old-head failures never start a repair. Pending, unknown, incomplete, or passing evidence
must not imply that all required checks passed.

Batch with a short delay and maximum age. Keep pending events separate from the active
attempt's immutable input. Timers, retries, and workspace-availability checks belong to
durable server scheduling outside Vercel request lifetimes, such as `cloud-agent-next`.
Use finite retries and visible exhausted-delivery recovery. Do not run agent polling or
sleep loops. Missing webhook delivery remains possible: show the last event time and Recheck.

## 6. Feedback and failed checks

Trust payload authors with `author_association` `OWNER`, `MEMBER`, or `COLLABORATOR`, and
configured review bots. Kilo Code Reviewer is trusted by default for standard and lite
Apps. Ignore deployment/coverage bots unless explicitly configured. Edited bot summaries
start a new batch only when actionable content changes. Older unresolved feedback can
remain relevant after a push; verify it against current code.

The agent verifies requests before changing code. Fix valid actionable feedback and
reply with evidence. Verify already-addressed work. Explain disagreement once and leave
disputed threads open. Defer optional work outside the PR's purpose with a reason. Ask
one specific question for unclear or conflicting requests. Missing approval or a
changes-requested review without actionable text needs human attention, not a repair loop.

Prefer platform-posted structured replies. Record posted comment IDs and ignore their
events. Add a hidden maintenance marker; ignore marked comments only from recognized
Kilo bot accounts. Account-only filtering would also suppress Code Reviewer feedback.
Reply once per handled review thread. Use one conversation summary per batch. Resolve
review threads only after verified published code addresses them, and batch resolutions
in one GraphQL request. Conversation comments have no resolution action.

Diagnose terminal failures on the current head. Read each failing job's logs once, for
at most three jobs per attempt, and trim/redact them before briefing. Fix code failures
and run focused local checks. Retry confirmed transient infrastructure failures within
a small limit. Surface missing secrets, permissions, approvals, and unavailable diagnostics
with specific reasons. Do not follow arbitrary external diagnostic URLs with credentials.
After publication, end the attempt and observe CI through webhooks; do not keep an agent
running while checks execute.

## 7. Conflict-only rebase and publication

After a fresh fetch, rebase onto the actual PR target's current tip:

- Normal PR: `git rebase origin/<target>`.
- Stacked PR: `git rebase --onto origin/<target> <parent-commit>`, using
  `cloud_agent_worktrees.base_sha`. This avoids replaying rewritten parent commits.

The maintenance agent runs the rebase. Do not call Restack: a maintenance turn is running,
ordinary workspaces have no parent SHA, and Restack returns conflicts instead of repairing
them. Use Restack's fetch, unseen-remote-work, exact-lease, and lease-failure restoration
behavior as the reference.

Fetch and inspect both branches, record the remote PR head, incorporate unseen remote
work, resolve the conflict, and verify the combined result. Publish only to the existing
PR branch:

```bash
git push \
  --force-with-lease=refs/heads/<pr-branch>:<observed-head-sha> \
  origin HEAD:refs/heads/<pr-branch>
```

Never relax the lease or use plain force. If the lease fails, fetch and reassess. Never
rewrite a stacked PR's parent branch. After confirmed publication, record the new parent
commit for a stacked workspace. Do not restack child workspaces automatically; the user
keeps the existing Restack control. Stop and access changes invalidate queued work, but
cannot undo an in-flight push. These Git rules remain instructions, as accepted in section 1.

## 8. Installation-wide GitHub API budget

Maintenance shares the customer's installation budget with Code Reviewer, PR displays,
and user agents. Maintenance has the lowest priority. Reuse `pr-refresh-budget.ts`, its
per-PR throttle, and `deferPrRefresh` installation cooldown.

| Activity | Budget rule |
|---|---|
| Enable or Recheck | Reuse shared PR refresh, about four calls; include existing comments/checks/conflicts. |
| Payload observations and reviewer trust | No additional reads. |
| Base push without overlapping files | No calls. |
| Base push with overlap | Batch 25–50 PRs per installation; check a PR at most about every 15 minutes. |
| Conflict while repair is queued | Agent fetch and `git merge-tree`; no GitHub API call. |
| CI logs | One read per failing job, at most three jobs per attempt. |
| Replies/resolutions | One reply per thread, one conversation summary per batch, batched resolution. |
| Sandbox agent | Brief includes all other GitHub data; no listing comments/checks/runs with `gh`. |

Debounce base pushes, compare payload files with the PR's cached changed-file list, and
skip checks without overlap. Cache that list per head SHA. Batch `mergeable` reads across
repositories in one installation. Handle each alias independently. Retry `UNKNOWN` once
after a delay. Only `CONFLICTING` queues a rebase; `MERGEABLE` does nothing. Keep queries
small enough for GitHub's ten-second timeout and record actual `rateLimit { cost }`.

Serialize writes at least one second apart. On primary or secondary rate limits, stop
all maintenance calls for that installation until the reset/cooldown time. Never retry
immediately. Preserve pending work and show **Waiting for GitHub rate limit**. Postpone
low-priority conflict checks and Recheck when remaining budget is low, initially below 20%.
Measure installation calls by endpoint class/reason, including brokered sandbox calls.

## 9. Web presentation

Display **Watching**, **Waiting for your session to finish**, **Fixing**, **Waiting for
checks**, **Needs your input**, **Paused**, and **Finished**. Add a rate-limit explanation
when applicable. Show last event/assessment time and specific recovery actions.

Label dedicated chats **Maintenance**, without the PR number. Pin only the current live
attempt's chat, including user-input waits. Remove its pin on completion or Stop; keep
finished chats accessible through maintenance history. Do not pin the workspace.

Activity records the trigger, changes, verification, publication outcome, and chat link.
Notify on a user decision or meaningful completed maintenance. Keep routine progress in
activity. Show actual usage when available. Display review and check status separately;
a successful repair does not imply approval or merge readiness. Missing evidence is not
success. Stale controls must fail visibly rather than modify another PR or generation.

## 10. Implementation sequence and verification

1. Add versioned consent, bounded contracts, attempts/dispositions/chat metadata, generated
   migration, finished-only retention, and privacy deletion coverage.
2. Add initial/shared observation, durable event admission, reviewer trust, conversation
   comments, thread state, conflict batching, and installation-wide budget handling.
3. Add lifecycle controls, start-only coordination, immutable briefs, limits, stable
   identities, exact-message results, verified publication, and recorded dispositions.
4. Add durable runtime scheduling, fresh maintenance authorization/chat creation,
   no-auto-commit messages, rebase termination cleanup, and question recovery.
5. Add web controls, consent/settings, activity, badges, and active-attempt pinning.

Run focused checks and affected local-stack flows. Unit or structural schema tests alone
do not prove runtime behavior. Production deployment and an internal pilot require separate
authorization. Apply the generated maintenance migration before deploying consumers.

### Release gate

With the browser closed, one enabled PR must handle new actionable feedback, a failed
current-head check, and a base update that creates a conflict. Each case must publish a
verified fix or expose a specific recoverable blocker.

Local verification must cover:

- Existing problems on enablement; bounded batching; duplicate and reordered deliveries;
  no duplicate chats/replies; pending events retained during repair.
- Busy user chats and quiet-period activity delaying start without creating empty chats;
  user chats started during maintenance continuing independently; one live maintenance
  attempt per workspace, including questions.
- Maintenance-only file commits during concurrent edits; unrelated dirty work preventing
  rebase; a later idle retry succeeding; termination aborting rebase and restoring branch.
- Questions surviving sandbox stop and answers continuing the same chat without waiting
  for other chats; sleeping recovery not assuming local edits survive or disappear.
- Fresh briefs retaining prior decisions/results/limits; execution after more than 24
  hours without browser activity; live and paused watches surviving retention; privacy
  deletion cascading only the deleted owner's private maintenance data.
- Normal target-tip rebase; rewritten/squash-merged stacked parent rebase without replaying
  parent commits; parent SHA updating only after confirmed push; exact-lease failure
  preserving another writer's commits; failed/unknown pushes never reported as success.
- Base updates without conflict causing no attempt; no-overlap pushes causing no API call;
  installation-batched conflict checks; bounded logs; rate-limit cooldown stopping calls.
- Code Reviewer feedback triggering repairs and marked maintenance replies not triggering
  them for both Apps; one reply per thread; verified resolutions and disputed open threads.
- Stop pausing and preventing restart; pause/access/generation invalidating queued work;
  PR close/merge and workspace deletion finishing maintenance; active-chat pin appearing
  and clearing at the correct lifecycle boundaries.

During an authorized pilot, measure useful fixes, repeated failures, event-to-repair delay,
concurrent edits, token usage, total cost, and API calls per installation. Do not report
unrun acceptance checks as passing.
