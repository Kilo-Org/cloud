# Cloud Agent Watch PR MVP

Date: 2026-10-14
Status: Observation-only foundation implemented; automatic-repair MVP blocked on
runtime safety prerequisites. Not ready for the MVP release gate.

## Implementation status (2026-10-15)

The first deliverable is deliberately observation-only behind the
`cloud-agent-watch-pr` release toggle. It does not issue execution credentials,
queue repair prompts, create repair chats, edit files, or push commits.

Implemented:

- PostgreSQL watch state, global live-PR uniqueness, generation-fenced controls,
  bounded observation projection, activity history, and user-deletion cleanup.
- Enablement from a verified grouped Cloud Agent session, with exact tenant,
  installation, repository, and open same-repository PR validation.
- Signed payload-first PR, review, inline comment, check, status, and branch-push
  observations. Receipt and projection commit together before webhook success;
  admission failures return a retryable response. No deferred repair dispatch is
  represented as durable delivery.
- Semantic observation ordering, current-head check failures, bounded early-SHA
  evidence, independent check identities, and ambiguity instead of guessed success.
- Accessible watch controls beside the PR badge, pause/resume/stop, activity, and
  an explicit manual recheck of PR identity/lifecycle only. Recheck does not scan
  checks or reviews. Enablement covers future events, not existing problems.
- Worktree deletion finishes associated watches in the deletion transaction.
  Expiry is enforced on event admission and lifecycle access; no expiry scheduler
  or recurring GitHub observation job is introduced in this milestone.

Automatic repairs remain unavailable because the existing asynchronous prompt
path is not an exclusive shared-worktree repair boundary, and existing writable
SCM credentials cannot enforce revocation or restrict publication to an authorized
attempt/ref. Prompt instructions and a pre-dispatch token check are insufficient.
The existing background automation issuer and idempotent sibling-creation ledger
are reusable, but do not independently provide these guarantees.

Before implementing dispatch, complete and test:

- Atomic runtime worktree reservation and safe-boundary handoff, including native
  sibling activity, questions, preparation, finalization, and cancellation.
- Non-bypassable, revocable publication authority, exact branch/lease enforcement,
  and structured push evidence. Direct Git/REST writes must not bypass it.
- Attempt-scoped background delegation, an internal idempotent repair-chat path,
  exact-message terminal notifications independent of drained session callbacks,
  and durable repair queue delivery/coalescing with finite retries.
- Trusted reviewer verification, bounded diagnostics, repairs for all three
  categories, rate-limit handling, competing-writer coordination, and live pilot
  verification. Saved preferences in the current UI grant no automatic-write
  authority; execution will require separate consent.

Operational prerequisites: apply the generated migration before enabling the
toggle, and configure/verify the GitHub App event subscriptions and grants. This
change does not update remote GitHub App configuration or deploy services. The
observation-only implementation does not fulfill sections 14-15's repair/runtime
acceptance criteria.

## 1. Goal and agreed constraints

After Cloud Agent creates a PR, the user can click **Watch PR**. Kilo then reacts
to GitHub events to address review feedback, failed checks, and conflicts or base
branch updates. The watch survives closing the browser and sleeping compute.

The agreed design is:

- Webhooks are the source of change notifications. No recurring PR polling.
- Webhook payloads update local state. Do not refetch GitHub state per event.
- If an eligible session is running in the original worktree, send one
  consolidated follow-up to that session.
- Otherwise create a repair chat in that worktree, using the existing PR branch.
- Use existing Cloud Agent execution and infrastructure. Do not build a separate
  watcher platform or keep a sandbox alive to wait for changes.
- Be economical with both installation API requests and agent executions.
- Fix observed problems; do not promise authoritative merge readiness.

One-shot event debounce, delayed dispatch, and bounded retries of admitted work
are allowed. They are not periodic observation of GitHub. Manual **Recheck** is
also allowed; it must be an explicit user action.

## 2. MVP scope and non-goals

### Included

- Opt-in watching of a verified, open, same-repository PR owned by a writable
  Cloud Agent worktree.
- Trusted inline review feedback and submitted review bodies.
- Terminal failed checks and legacy commit statuses on the current PR head.
- Base branch changes, branch updates, conflict resolution, and consented rebase.
- Durable event admission, deduplication, batching, session routing, and outcomes.
- Visible status, activity history, bounded attempts, pause, stop, and expiry.

### Excluded

- Auto-merge, automatic approval, bypassing repository protections, or disabling
  tests/checks to make a PR green.
- Fork PRs, arbitrary PR URLs, legacy ungrouped sessions, and unrelated worktrees.
- Conversation-tab comments (`issue_comment`) as repair instructions initially.
- Automatic review-thread resolution.
- General external-CI integrations or fetching arbitrary check details URLs.
- A full branch-rules/required-check evaluator.
- Periodic recovery scans of GitHub or an isolated repair-worktree architecture.

The UI should say **No observed problems** with the time of the last relevant
event/assessment, not **Ready to merge**. Missing deliveries and pending checks
must not be presented as proof of success.

## 3. Existing implementation and reuse

| Area | Existing code | Reuse or gap |
| --- | --- | --- |
| GitHub ingress | `apps/web/src/app/api/webhooks/github/route.ts`, `github-lite/route.ts` | Reuse signature validation and installation identity. |
| Event dispatch | `apps/web/src/lib/integrations/platforms/github/webhook-handler.ts` | Add independent watch admission; existing deferred handlers are not a durable repair queue. |
| Payload schemas | `apps/web/src/lib/integrations/platforms/github/webhook-schemas.ts` | Extend for check/status events, review changes, and complete head/base repository identity. |
| Verified PR linkage | `apps/web/src/lib/integrations/platforms/github/pr-link-identity.ts`, `webhook-handlers/upsert-cli-session-pull-requests.ts` | Reuse tenant-scoped identity; never infer a PR solely from branch name. |
| PR UI | `apps/web/src/components/cloud-agent-next/SessionPrIndicator.tsx`, `PrHoverCardContent.tsx` | Add watch controls and independent watch status. |
| Web API | `apps/web/src/routers/cli-sessions-v2-router.ts` | Follow existing ownership checks and tRPC/React Query patterns. |
| PR API reads | `apps/web/src/routers/github-pr-review-router.ts` | Reuse mapping/query concepts; current user-token procedures cannot be called directly by installation-authenticated automation. |
| Follow-up | `services/cloud-agent-next/src/router/handlers/session-send.ts`, `src/session/queue-message.ts` | Reuse durable message identity and admission; add constrained automation routing. |
| Sibling chat | `services/cloud-agent-next/src/router/handlers/session-worktree.ts` | Existing creation is browser-only and rejects bots; add a narrowly scoped internal automation path without relaxing public access. |
| Runtime | `services/cloud-agent-next/src/control-plane/session/`, `wrapper/src/control-plane/` | Target `workspace_*`; do not add this behavior to legacy `CloudAgentSession.ts`. |
| Completion | `services/cloud-agent-next/src/control-plane/session/callbacks.ts`, `session-do.ts` | Existing callbacks are session/batch-oriented; add exact watched-message terminal notification rather than overwriting session callback targets. |
| Durable delivery | `services/cloud-agent-next/wrangler.jsonc` | Existing Worker has queue consumers; a dedicated Watch PR queue can run in this Worker, not a new service. |
| Automation patterns | `services/gastown/src/dos/town/actions.ts`, `reconciler.ts`, `town-scm.ts` | Reuse feedback batching and conflict-episode concepts, not polling or its readiness evaluator unchanged. |

Important constraints found during research:

- The existing GitHub handler suppresses non-PR events from secondary organization
  installations. Watch routing must use the explicitly authorized installation,
  including an agent-only connection where permitted, rather than inherit this
  owner-wide suppression.
- Receipt deduplication followed by `after()` is not reliable job delivery. A
  duplicate must not suppress recovery of work that never reached durable dispatch.
- Shared worktree chats can execute concurrently. Queuing a prompt does not prove
  that agent edits or explicit Git commands are serialized.
- Sleeping-container recovery relies on the pushed branch and session history;
  uncommitted files are not guaranteed to survive.
- Modern control/workload tokens expire quickly. A stored browser token is not
  background watch authority.

## 4. User experience

### Enable

Show **Watch PR** on a verified open PR for an eligible worktree. The confirmation
explains that Kilo can edit and push without the browser remaining open and that
repairs incur normal usage charges.

The confirmation records:

- Repair categories: reviews, failed checks, base updates/conflicts.
- Branch update strategy: merge base changes or rebase with explicit history-rewrite
  consent. Neither strategy permits overwriting other people's commits.
- Model/profile, attempt limit, and watch duration.
- Existing supported spend controls, or an explicit limitation if a hard per-watch
  monetary cap is not available. Do not label a pre-dispatch balance check a cap.

Suggested initial defaults, to validate during the internal pilot: 24-hour watch
duration, two repair attempts for the same problem fingerprint, and ten total
repair attempts. These are proposed product defaults, not existing behavior.

Enablement uses existing verified PR/cache information. Perform at most one
targeted initialization read when required identity or feedback/check state is
missing. If omitted, state clearly that the watch starts from future events;
pre-existing failures/comments will not reliably be discovered.

### Status and controls

| Status | Meaning |
| --- | --- |
| Watching | Enabled; waiting for events, checks, or queued repair eligibility. |
| Fixing | One repair message is admitted/running. |
| Needs attention | Clarification, unknown outcome, permissions, unavailable diagnostics, or non-automatable blocker. |
| Paused | User pause, attempt/billing limit, or a recoverable access issue. |
| Finished | User stopped, watch expired, source worktree deleted, or PR merged/closed. |

Additional explanatory text distinguishes **Waiting for checks**, **Waiting for
GitHub rate limit**, **Waiting for another chat**, and **No observed problems**.

Provide **Pause**, **Resume**, **Stop watching**, **Recheck**, and a link to the
current/last repair chat. Show compact activity entries with trigger, attempt,
commit or safe failure reason, and available usage information. Repair messages
are visibly labeled as Watch PR automation in the transcript.

Pausing prevents new repairs. Stopping invalidates pending repair authority;
offer an explicit option to interrupt an already running repair. A generic
Cloud Agent **Stop** on a repair pauses the watch, so it cannot immediately restart
the work the user just stopped.

## 5. Minimal durable state

Use PostgreSQL for product state with atomic compare-and-set transitions and a
durable queue for work delivery. This is a proposed implementation choice; no new
PR-specific Durable Object is necessary for the MVP.

### Watch record

- Watch ID, owner user, optional organization, exact integration ID/app type.
- Repository ID, canonical URL, PR number, head/base refs, current head/base SHAs.
- Source worktree and Cloud/Kilo session IDs; last repair session ID.
- Policy/consent, explicit model/profile, expiry, attempt limits, lifecycle reason.
- Generation/version, pending revision, active attempt ID, last event/assessment.
- Small event-derived projection with provenance and completeness indicators.

Use text user IDs and normalized serialized timestamps, following
`packages/db/AGENTS.md`. Avoid duplicating the existing PR display cache as a
second authoritative lifecycle model; store watch-specific observations and
reuse existing verified identity where appropriate.

### Repair work / attempt record

- Stable attempt ID, watch generation, actionable fingerprint, included event IDs.
- Expected PR head/base SHAs, target session/worktree, creation operation key,
  durable message ID, dispatch state, terminal outcome, resulting commit evidence.
- Retry counts, next eligible delivery time, bounded diagnostics references.

Retain unresolved pending work separately from the immutable active-attempt
snapshot. Events arriving during execution belong to a later revision.

### Branch writer coordination

Enforce one active Watch PR writer per canonical repository/PR, even if the same
installation is shared between tenants. Do not reveal another tenant's details
when rejecting a conflicting watch. Keep authorization tenant-scoped.

Existing Auto Fix/Gastown can also mutate branches. During the MVP, reject or defer
known competing automation for the watched PR; do not silently run both. Use a
common branch-writer claim where existing execution paths can participate. Exact
Git leases remain necessary because human/external writers cannot be locked.

## 6. Webhook subscriptions and interpretation

| Event | Payload-first behavior | Minimum observation permission |
| --- | --- | --- |
| `pull_request` | Update lifecycle/head/base; supersede stale work; close/merge ends watch. | Pull requests read |
| `pull_request_review_comment` | Store created/edited/deleted inline feedback and replies; suppress self-generated feedback. | Pull requests read |
| `pull_request_review` | Store submitted/edited/dismissed reviews, including body and state. | Pull requests read |
| `check_run` | Store run ID, SHA, attempt/version where available, status, conclusion, and safe metadata. | Checks read |
| `status` | Store latest status evidence by SHA/context/provider identity where available. | Commit statuses read |
| `push` | Update watched head/base refs; coalesce base movement and branch deletion. | Contents read |

Optional later: `pull_request_review_thread` for resolution changes, `check_suite`
as supplementary evidence, and `issue_comment` with separately defined admission.

Execution additionally requires Contents write for pushes and Pull requests write
for replies. Actions read is required for GitHub Actions log retrieval. Workflow
edits require separately authorized capabilities; do not expand scope implicitly.

Changing subscriptions alone does not require installation approval if the
installation already has the required grants. Verify live grants; increasing
permissions may require approval. Official reference:
https://docs.github.com/en/webhooks/webhook-events-and-payloads

### Matching without GitHub lookups

- Route review/PR payloads by installation, repository ID, and PR number.
- Route check/status payloads using a local repository/head-SHA index. Use provided
  PR associations where available but do not depend on them being populated.
- If head identity is not known yet, retain bounded unmatched evidence and join
  it when a head/PR event arrives. Do not query GitHub to match every check event.
- Route base pushes only to watches targeting that exact repository/base ref.
- Ignore failures for an old head; a completed old repair does not clear new-head work.

### Ordering and completeness

Delivery IDs deduplicate delivery, not semantic state. Different deliveries can
describe the same problem. Use object update timestamps/IDs, explicit push
before/after evidence, and locally tracked ancestry where available to prevent
older payloads overwriting newer observations. If ordering cannot be established,
retain ambiguity rather than guessing or declaring success.

Do not treat all fields embedded in an unrelated event's PR object as fresh.
In particular, an old comment delivery must not roll back the locally tracked head.
Branch force-push and reopened PR ordering need explicit tests. Terminal watch
generation fencing prevents stale events from restarting stopped work.

`check_run.completed` does not imply that all checks passed. Passing checks update
state but do not start an agent. Reruns and superseded attempts require version-aware
tracking where payloads provide sufficient evidence. Pending/unknown/missing
evidence does not imply failure or success.

## 7. Durable event-to-repair pipeline

```text
Signed webhook
  -> durable normalized event enqueue
  -> update watch projection / accumulate actionable work
  -> delayed dispatch item, once per pending revision
  -> claim attempt and runtime eligibility
  -> send to running eligible session OR create repair chat
  -> exact message terminal notification
  -> settle attempt / dispatch remaining work
```

Keep webhook processing short. Validate signature and payload, match explicit
watch authorization, and durably enqueue before returning success. Return a
retryable response if durable admission fails; do not claim successful processing
after an ephemeral `after()` dispatch.

Use a dedicated queue binding/consumer in the existing Cloud Agent Worker. Keep
watch product handlers in a small separate module, not in session DO lifecycle
code. Establish a signed/service-authenticated internal admission boundary from
the web app; never accept public requests containing arbitrary watch identities.

On queue delivery, transact event dedupe and projection changes. Enqueue the
required follow-up before acknowledging the item. A retry must repair a missing
follow-up enqueue even when the event's DB update already succeeded. Stable job
identities and atomic attempt claims handle duplicate queue deliveries. Do not
promise exactly-once physical agent execution under ambiguous transport failures.

### Coalescing

- Use a short one-shot debounce, initially about 30 seconds, with a maximum batch
  age, initially about two minutes, to prevent continuous events starving work.
- Combine review feedback, CI failures, and base updates into one repair snapshot.
- During an active attempt, accumulate new observations without sending additional
  prompts. Terminal notification releases the lane and considers pending work.
- Use bounded cooldown after publication to avoid acting on partial rerun evidence.
  Do not wait indefinitely for every check or require polling to unblock dispatch.
- Dedupe comment revisions, failed run attempts/status contexts, and base SHA
  episodes. A failure on a new SHA is fresh evidence but still consumes total limits.

Delayed jobs exist only for admitted work, retries, debounce, or expiry. They must
not periodically fetch PR state. Configure finite redelivery and a dead-letter
path that leaves a visible recoverable status.

## 8. Session selection and runtime admission

An eligible running session belongs to the same owner/tenant, repository,
worktree, and watched PR branch, has writable current access, and is not awaiting
an unrelated permission/question or in teardown. A live sandbox alone does not
mean a chat is running.

Select deterministically:

1. If this watch already owns an active repair, accumulate pending work only.
2. Prefer the originating session if it is running and eligible.
3. Otherwise select an eligible running sibling working on the same PR.
4. If none exists, create a new repair chat in the original worktree. Reuse that
   chat while its repair is active; do not create one chat per webhook.

Send one visible consolidated follow-up, not an interrupt. It should execute at
the next safe boundary. Current native asynchronous prompt submission is not a
verified exclusive repair boundary: add explicit automation admission that checks
and reserves worktree eligibility atomically. If user/sibling work starts first,
defer and resume from its lifecycle notification, not a runtime polling loop.

Do not serialize all ordinary user chats as part of this feature. Instead, ensure
automated Git mutation only begins under a valid automation reservation. If the
shared worktree becomes unsafe during repair, pause publication and surface it.
Automatic branch switching in a checkout containing unrelated work is forbidden.

Add an internal sibling-chat creation path that reuses existing ownership,
repository, profile, registration, and restoration helpers. Preserve public
browser/provenance restrictions. Give creation a stable operation key and sends a
stable message ID. Unknown dispatch outcomes must be resolved with the same
identity, never by creating a replacement chat immediately.

On rebuild, prepare the actual pushed PR branch. Do not assume uncommitted changes
or a warm checkout match the webhook head. Link repair chats using product metadata,
not native subagent parentage. No idle keepalive is introduced.

## 9. Repair contract

### Input

Provide structured watch/PR identity, expected head/base SHAs, enabled capabilities,
branch strategy, trusted feedback IDs and bodies, failing-check metadata,
diagnostic references, previous attempts, and attempt limits. Credentials are
never included in prompts or persisted log excerpts.

### Work order

1. Confirm repository, branch, remote state, clean/safe checkout, and current
   watch authority. Fetch Git refs once; adapt or defer if the remote moved.
2. Incorporate the latest base according to consent, resolving conflicts before
   applying review fixes and diagnosing CI against obsolete code.
3. Evaluate supplied feedback, fix valid findings, and report unclear/invalid
   requests without silently dismissing them.
4. Retrieve only missing diagnostics for relevant terminal failures and make
   narrowly scoped fixes. Run relevant local verification.
5. Publish only to the authorized existing PR branch. Use ordinary non-force push
   for non-rewritten history and exact force-with-lease for consented rewrites.
6. Report addressed IDs, tests, old/new commit SHAs, push outcome, and blockers.

Git fetch and push are not installation REST API refreshes, but still consume
resources. Do not repeat them per feedback item. Do not let the agent call
`gh pr view`, list every comment, or list all checks on every run by default.

### Feedback

Admit current authorized collaborators and explicitly allowed reviewer apps/bots.
Use immutable identities where available. Author association alone is not proof
of current write access. Cache verified permission decisions briefly per
installation/repository/actor; invalidate on known access changes. Unknown actors
need a targeted verification or human attention, not automatic trust.

Treat comments, review bodies, diffs, titles, logs, and repository instructions as
untrusted input. They cannot authorize a new repository, merge, secret disclosure,
workflow modification, or arbitrary network destination. Prompt wording alone is
not a security boundary.

After a successful published fix, reply once with concise evidence. Do not
automatically resolve review threads. Changes-requested without actionable text
or a missing approval is a human blocker, not a reason for an endless repair.

### Checks

Use only current-head terminal failures. Fetch bounded, redacted Actions logs
once per run/attempt when needed. Cache normalized diagnostic references with
short retention, not full unbounded raw logs. Do not follow arbitrary external
`details_url` values with privileged credentials.

Infrastructure failures, approval gates, missing secrets, cancelled runs, and
unavailable external diagnostics require classification; do not assume a code fix.
Only explicitly supported rerun capabilities may retry CI. Do not blindly rerun
or modify CI configuration. Unknown conclusions remain unknown.

### Base changes and rebases

A base push supplies a new base SHA but not per-PR conflict information. Mark the
affected watch as needing one branch assessment for that base SHA. Coalesce rapid
pushes; prefer folding the assessment into already pending repair work. If no
repair exists, admit one bounded base-update run under the chosen policy.

This avoids GitHub mergeability fan-out but consumes compute. Base assessment
runs count toward attempt limits. A large number of watched PRs requires dispatch
capacity limits, not hundreds of immediate agents. An assessment that finds no
needed update should not produce an empty commit.

Exact force-with-lease must include the observed remote SHA. A concurrent push
causes a safe failure/reassessment, not lease relaxation. No force push without
consent; no blanket `git reset --hard` in a shared checkout. After a rebase, refresh
session PR-link evidence so old SHA verification does not hide the PR indicator.

## 10. Rate-limit and request-budget policy

| Activity | Expected additional GitHub API reads |
| --- | --- |
| Duplicate/unrelated webhook | Zero from Watch PR. |
| Passing check, stale-head failure, self-reply | Zero. |
| Known trusted review feedback | Zero at admission. |
| New/unknown reviewer | One targeted permission lookup, cached briefly. |
| PR enablement | Zero when sufficient state exists; one bounded initialization snapshot otherwise. |
| Dispatch | Zero full PR refreshes; Git fetch in the agent. |
| CI diagnosis | Relevant log/metadata requests only, paginated/bounded as necessary. |
| Base push | Zero mergeability reads; batched bounded Git assessment. |
| Manual Recheck or ambiguous outcome | Targeted reads only. |

These are Watch PR incremental targets, not a guarantee that existing code-review
or PR-cache consumers make no requests for the same webhook.

Use installation-wide rate-limit classification, bounded concurrency, and cached
remaining/reset information. Respect `Retry-After`, primary reset times, and
secondary-rate-limit responses. Serialize/coalesce duplicate diagnostic fetches.
Keep mutations more conservative than reads to avoid secondary limits.

Audit `github/runtime-authorization.ts` and adapter paths for hidden calls during
each delivery; cache reusable token/grant data only within its validity and never
bypass revocation checks. Do not cache a stale grant indefinitely to save requests.

If the installation is rate-limited, preserve pending work and schedule a bounded
delayed retry of that work. Do not repeatedly wake an agent to rediscover the
limit. Surface the delay. After retry exhaustion, show Needs attention rather
than silently dropping work.

Initial rollout must measure API calls by installation, reason, endpoint class,
and repair attempt. This is also how to detect agent-side `gh` request amplification.

## 11. Completion, cancellation, and authorization

Notify the watch when its exact durable message becomes terminal. Do not replace
a reused session's existing callback target or depend on all user messages being
drained. Use the existing terminal/report delivery infrastructure with a scoped
watch notification and deduplicate by attempt/message ID.

Validate completion reports against attempt identity. Agent summaries are not
authoritative proof of a push. Use platform finalization/Git publication evidence
and subsequent PR/push/check webhooks. If evidence is absent, perform one targeted
verification when necessary or show **Push outcome unknown**; never mark success
just because the turn completed.

Close an attempt once. Release its writer claim, preserve its immutable outcome,
and consider pending events. A new head triggers fresh checks via GitHub; no
periodic CI polling is introduced. Do not overwrite newer observed state with an
older completion result.

Persist revocable automation consent, not browser credentials. At dispatch,
revalidate owner, organization membership, exact integration/repository access,
model/profile, billing, watch generation, expiry, and branch identity. Issue only
short-lived scoped execution authority through an approved background delegation
path. The existing issuer's suitability is an implementation prerequisite.

Stop/pause/expiry and worktree deletion invalidate queued work by generation.
Before publication, check revocation through a constrained execution/publication
boundary. If the runtime cannot enforce this outside the prompt, do not promise
that Stop prevents a late push; implementing that boundary is required for the
automatic-write MVP. A push already in flight cannot be retroactively undone.

Do not automatically answer arbitrary questions/permissions. Surface them in the
repair chat and watch status; resume from the user's answer. Let normal compute
idle behavior operate while waiting.

## 12. Reliability without polling

Handle three distinct cases:

1. **Our admission/dispatch fails:** durable queue redelivery and stable identities
   recover the same admitted work within finite bounds.
2. **GitHub delivers duplicate/out-of-order events:** payload versioning, semantic
   fingerprints, SHA fences, and watch generations prevent duplicate unsafe work.
3. **GitHub never delivers an event:** automatic discovery is not guaranteed.
   Surface last-observed time and provide manual Recheck/redelivery support.

Do not assume GitHub automatically retries every failed webhook delivery. Retain
delivery IDs for operator diagnosis and explicit redelivery. Bounded matching and
unknown-state retention help with reordered deliveries but cannot manufacture
missing evidence.

No cron job scans GitHub. Expiry and retry timers do not fetch unrelated PRs. Queue
dead-letter inspection and operator recovery are not a hidden polling subsystem.

## 13. Implementation sequence

### Step 1: Resolve narrow runtime prerequisites

Confirm a supported background delegation path, atomic automation admission in a
shared worktree, idempotent internal sibling creation, exact-message completion
notification, and revocable publication enforcement. Reuse existing helpers; do
not redesign the whole Cloud Agent control plane.

Deliverable: focused interface changes and tests proving the proposed session
routing is safe. If these primitives require more work than expected, record the
scope explicitly before building the UI around unsupported guarantees.

### Step 2: Add watch state and controls

Add schema/migration, watch enable/pause/resume/stop/recheck procedures, eligibility
checks, consent, branch-writer uniqueness, status projection, and PR UI controls.
Keep the feature flagged. Update the Cloud Agent product spec for visible behavior
once decisions are settled; this plan is not a replacement for that spec.

Deliverable: watch lifecycle with no automated repairs yet.

### Step 3: Add payload-first event admission

Add validated event types and indexes, watch-specific installation routing,
durable queue admission, projection ordering, fingerprints, and one-shot debounce.
Handle standard and lite endpoints according to granted capabilities. Preserve
existing review/bot behavior without introducing extra refreshes.

Deliverable: internal event fixtures produce accurate watch activity and pending
repair batches with measured API-call counts.

### Step 4: Dispatch and complete repairs

Implement running-session selection, internal repair-chat creation, stable
operation/message identities, runtime reservation, prompt contract, notification,
limits, and cancellation. Start with trusted review feedback, then add current-head
CI diagnosis and consented base-update/conflict repair using the same lane.

Deliverable: all three requested repair categories work end to end without a new
watcher service or recurring polling.

### Step 5: Rate-aware internal pilot

Exercise real GitHub webhook deliveries on internal same-repository PRs. Measure
request amplification, batching, repair usefulness, cost, repeat failures, and
late publication. Validate defaults before widening opt-in access. Provide a kill
switch that prevents new dispatch and safely handles active work.

Deliverable: release decision based on observed behavior, not only mocked tests.

## 14. Verification and acceptance criteria

### Webhook and projection tests

- Correct signature/installation/tenant binding; unsupported grants fail closed.
- Secondary/agent-only installations route only their authorized watches.
- Repeated delivery and different deliveries of the same object revision dedupe.
- Passing check produces no repair and no additional GitHub reads.
- Old-head failure produces no repair; reordered head/comment events cannot roll
  back current head or restart a finished generation.
- Review edits/deletions supersede pending feedback; self-replies do not loop.
- Empty check PR associations match via local SHA index; early events join later.
- Base pushes affect only watches targeting that base and create one episode per
  coalesced base SHA.

### Dispatch and runtime tests

- Busy eligible source receives one safe-boundary follow-up; idle workspace creates
  one new repair chat. Live sandbox alone does not select an idle chat.
- Ambiguous create/send response retries the same identity without a second chat.
- Busy siblings, permission waits, unrelated branch work, and deleted worktrees
  prevent unsafe repair admission.
- Sleeping sandbox restores the pushed PR branch; lost local edits are not assumed
  present or overwritten blindly.
- Events during repair remain pending and dispatch once after terminal notification.
- Failed durable enqueue remains recoverable even after DB event dedupe succeeded.
- Watch notification does not replace another consumer's callback or depend on
  user-queue drain.

### Repair and failure tests

- Trusted review fix publishes and replies once; untrusted feedback cannot obtain
  expanded authority or secret access.
- Current-head test failure is fixed using bounded cached diagnostics; external
  log URLs and missing credentials fail safely.
- Base update resolves a reproducible conflict; concurrent remote push rejects an
  exact lease and preserves the other writer's commits.
- Rebase updates PR-link evidence and does not affect another repository/branch.
- Completed turn with failed/unknown push is not reported as fixed.
- Transient limits retry within bounds; unavailable authorization, insufficient
  funds, unclear conflict, repeated failure, and permission denial surface specific
  reasons without long silent waits.
- User Stop pauses the watch; watch stop/expiry fences queued work and prevents
  unauthorized publication subject to an already-in-flight push boundary.
- Waiting watch/CI/permission state does not keep compute alive.

### Request-budget tests

- Burst of passing events yields zero incremental GitHub reads from Watch PR.
- Burst of related failing checks/comments produces one consolidated repair.
- Repeated CI diagnostics are fetched once per run/attempt within bounded retention.
- Rate-limit responses preserve work, use delayed retries, and do not spin agents.
- No scheduled path repeatedly fetches PR/check/review state.

Use focused web/unit tests, Worker integration tests, and the Cloud Agent fake-LLM
harness for runtime transitions. Follow `repository-verification` and the relevant
package manifests when validating implementation. The observation-only foundation
needs focused web and worktree-deletion tests; the runtime/repair acceptance cases
remain unimplemented and must not be reported as passing.

## 15. MVP release gate

Release only when one watched PR can receive a trusted review comment, a current
head CI failure, and a base change/conflict, repair them through the user's proposed
session-routing flow, and return to waiting without polling or retaining compute.

Duplicate events must not multiply sessions or writes. External changes must not
be overwritten. Access loss, cancellation, rate limits, and unsuccessful repairs
must be visible and bounded. The UI must distinguish observed health from complete
merge readiness.
