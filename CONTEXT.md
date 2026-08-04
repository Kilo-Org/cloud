# Context

## Scope

Kilo Code Cloud hosts Kilo Code agents, integrations, and automation. This contract defines Code Reviewer, Security Agent, Auto Routing, and Kilo Pass for Organizations language plus ownership boundaries used across review execution, analytics, sync, web, email, remediation, billing alerts, model selection, tests, and product documentation.

Covered domains must use this contract's canonical terms in code, docs, task descriptions, tests, and agent outputs. Do not introduce a synonym for a governed concept without updating this contract. Scoped `AGENTS.md` files link to this contract instead of copying it.

## Contexts

| Context | Owns | Location | Notes |
|---|---|---|---|
| **Code Reviewer** | Pull request and merge request review execution, Code Review Findings, review settings, and Review Analytics | `packages/app-shared/src/code-review/`, `apps/web/src/lib/code-reviews/`, `apps/web/src/components/code-reviews/` | A Code Reviewer owner is either one user or one organization; Review Analytics collection is organization- and platform-scoped |
| **Security Agent** | Security Findings, owner-scoped policy, settings, Auto Remediation, and user-visible outcomes | `packages/app-shared/src/security-agent/`, `apps/web/src/lib/security-agent/`, `apps/web/src/components/security-agent/`, `.specs/security-agent.md` | A Security Agent owner is either one user or one organization |
| **Security Sync** | Dependabot synchronization, finding persistence, notification eligibility, recipient intent materialization, and durable notification state | `services/security-sync/` | Event state remains owner-scoped; email sending does not occur inside finding persistence transactions |
| **Security Agent Email Delivery** | Dispatch-time revalidation, email rendering, owner-aware links, and Mailgun delivery | `apps/web/src/app/api/internal/security-agent/`, `apps/web/src/lib/email.ts`, `apps/web/src/emails/` | Accepts notification identity only and loads current data before sending |
| **Shared Security Notification Policy** | Canonical config parsing, defaults, severity thresholds, and pure event eligibility rules | `packages/worker-utils/src/security-notification-policy.ts` | Web and Worker must use same policy contract |
| **Cost Insights** | Retired. No owned behaviour remains | `apps/web/src/components/cost-insights/CostInsightsDiscontinuedNotice.tsx` | Only the discontinued-notice routes remain; the unused `cost_insight_*` tables are scheduled to be dropped |
| **Auto Routing** | Efficient model-pool settings, shared benchmark profiles, and per-request model selection | `packages/auto-routing-contracts/`, `services/auto-routing/`, `services/auto-routing-benchmark/`, `apps/web/src/components/auto-routing/` | Personal and organization settings constrain the existing `kilo-auto/efficient` model |
| **Kilo Pass for Organizations** | Organization-owned Kilo Pass agreements, term versions, purchased pass capacity, sub-org allocation, and pooled bonus unlock behavior | Organization billing, seats, credits, sub-orgs, and Kilo Pass org administration surfaces | Separate source of truth from personal Kilo Pass subscriptions |

## Canonical Terms

| Term | Agent meaning | Use this when | Avoid |
|---|---|---|---|
| **Code Reviewer** | Agent that reviews pull requests and merge requests and may raise Code Review Findings | Naming the product capability, settings, review execution, and analytics | Security Agent, review bot |
| **Code Review Finding** | Model-generated issue newly raised by Code Reviewer during one review execution | Referring to Code Reviewer output or its controlled analytics taxonomy | Security Finding, confirmed bug, verified vulnerability |
| **Review Analytics** | Organization-only, opt-in prospective collection of bounded classifications for completed reviews and newly raised Code Review Findings | Referring to the Code Reviewer Analytics tab, collection setting, coverage, or aggregate metrics | Security Agent analytics, historical backfill |
| **AI-estimated impact** | Code Reviewer's low, medium, or high estimate of a change's reach and consequence, independent of diff size, change type, complexity, and finding count | Referring to impact classifications or derived impact points | Developer quality, individual performance, delivered impact |
| **Security Agent** | Agent that syncs, analyzes, and helps resolve repository Security Findings | Naming product capability, settings, routes, and behavior | Security Reviews |
| **Security Finding** | Vulnerability item owned by one user or organization for a repository, usually synced from Dependabot | Referring to Kilo's persisted vulnerability domain object | Security review, alert |
| **Auto Remediation** | Security Agent feature that automatically starts Security Remediations for eligible Security Findings | Referring to policy-driven remediation admission | Auto Fix |
| **Security Remediation** | Security Agent-owned remediation task created from a Security Finding after analysis determines that a pull request is right next step | Referring to remediation task and its lifecycle | Auto Fix ticket |
| **Security Remediation Attempt** | One attempt to remediate a Security Finding through Cloud Agent, including session and pull request outcome | Referring to individual execution or retry | Auto Fix run |
| **Cloud Agent Write Identity** | Identity Cloud Agent uses to push remediation branches and open pull requests for Security Remediations | Referring to Git write attribution | Security Agent Bot |
| **Security Agent Notification** | Durable per-finding, per-recipient event with one specific notification kind | Referring to event identity, eligibility, deduplication, or durable state | Notification email, reminder, alert |
| **New-finding Notification** | Security Agent Notification admitted only when eligible finding is first inserted into Kilo | Referring to first-insertion event, including initial import of existing source alerts | New alert email, discovery reminder |
| **SLA Warning Notification** | Security Agent Notification admitted after eligible finding enters configured warning window and before persisted deadline | Referring to pre-deadline SLA event | SLA reminder, deadline alert |
| **SLA Breach Notification** | Security Agent Notification admitted when eligible finding reaches or passes persisted SLA deadline | Referring to at-or-after-deadline event | Overdue alert, breach reminder |
| **Notification Recipient** | User authorized to receive one Security Agent Notification: personal owner or current organization owner | Referring to per-user event identity and authorization | Subscriber, watcher, all organization members |
| **Email Delivery** | Attempt to render and send one Security Agent Notification through Mailgun | Referring to provider side effect, retry, or acceptance | Notification event |
| **Security Finding Activity Event** | Immutable record of one material user, system-policy, or source-driven action or outcome that changes or explains a Security Finding | Referring to evidence included in a Security Agent Audit Report | Page view, unchanged sync observation, queue claim, heartbeat |
| **Security Agent Audit Report** | Owner-scoped, period-bounded audit view of Security Finding Activity Events grouped by Security Finding | Referring to the interactive audit report | Generic audit-log export, activity dump |
| **Efficient model pool** | The exact model and thinking-variant pairs that `kilo-auto/efficient` may consider for an owner | Referring to either the platform default or an owner-configured pool | Custom mode, custom efficient model |
| **Pool entry** | One concrete model paired with its canonical thinking-variant key, or the model's default only when it exposes no variants | Referring to benchmark and routing identity inside an Efficient model pool | Model alone, normalized effort |
| **Benchmark profile** | Globally shared, current benchmark results for one Pool entry | Referring to readiness and measured routing evidence reused across owners | User benchmark, pool benchmark |
| **Kilo Pass for Organizations** | Organization-owned Kilo Pass product that buys pass capacity for parent-org paid seats and allocates pooled credit capacity into parent or direct child containers | Referring to org Kilo Pass agreements, purchases, allocations, and admin workflows | Personal Kilo Pass, user Kilo Pass subscription |
| **Kilo Pass org agreement** | Durable org-owned source of truth for one organization's Kilo Pass terms, version, purchase channel, and lifecycle | Preserving self-serve and manual org Kilo Pass terms | Personal subscription row, seat purchase row |
| **Kilo Pass term version** | Immutable versioned commercial and credit-grant rules attached to a Kilo Pass org agreement; standard and dedicated custom versions are allowed | Referring to legacy upfront-bonus terms, default bonus-after-base terms, or future bonus changes | Promo flag, mutable agreement fields, plan metadata |
| **Kilo Pass term transition** | Scheduled change from one immutable term version to another at agreement's commercial renewal boundary | Referring to future terms for an existing agreement | Mid-term mutation, retroactive version change |
| **Kilo Pass seat add-on item** | Recurring Stripe subscription item on parent org's seat subscription, with quantity and cadence synchronized to seat item | Referring to self-serve provider billing for Kilo Pass for Organizations | Separate Kilo Pass Stripe subscription, entitlement source of truth |
| **Purchased pass capacity** | Count of Kilo Passes the parent org has bought for eligible seats | Referring to total passes resolved across direct-child allocations and parent allocation | Assigned users, personal wallets |
| **Required pass capacity** | Purchased pass capacity required when a parent org opts into Kilo Pass for Organizations; exactly equals parent org paid seat count | Enforcing all-seat coverage for org Kilo Pass purchase or renewal | Current member count, occupied seats, independently selected quantity |
| **Kilo Pass allocation** | Integer pass capacity resolved for one Kilo Pass allocation container; direct-child allocations are explicit and parent allocation is the purchased-capacity remainder | Referring to parent or child allocation state | User assignment, unassigned capacity, personal credit balance |
| **Sub-org allocation** | A Kilo Pass allocation whose container is a direct child sub-org | Referring specifically to child allocation state | Parent allocation, descendant allocation, user assignment |
| **Parent default allocation** | Purchased pass capacity remaining after direct-child allocations, automatically allocated to parent organization | Referring to parent capacity derived from purchased capacity rather than explicitly assigned to a child | Unassigned pass capacity, unused passes, pending capacity |
| **Kilo Pass allocation plan** | Versioned set of direct-child allocations and derived parent default allocation applied at one issuance boundary; initial plan may govern first issuance and later plans are future-window effective | Referring to initial purchase distribution or pending allocation edits and their effective issuance boundary | Current-window issuance snapshot, unassigned capacity |
| **Kilo Pass org issuance snapshot** | Immutable record for one allocation container and one issuance window, including regular, bridge, or supplemental entitlement, allocated count, concrete amounts, and term version | Auditing or evaluating grants and bonus-after-base unlocks | Live allocation, live bonus terms |
| **Kilo Pass allocation container** | Parent org or direct child sub-org that can receive Kilo Pass-funded pooled credits and own a period's bonus unlock threshold | Referring to where purchased pass capacity is allocated | Billing entity, descendant org, personal wallet |
| **Overallocated Kilo Pass agreement** | Active org agreement whose future direct-child allocation total exceeds purchased pass capacity after paid seat count decreases; parent default allocation is zero until reconciled | Referring to allocation state requiring owner or billing-manager reconciliation | Invalid current-period issuance, automatic child-allocation reduction |
| **Kilo Pass pooled spend** | Cumulative actual product Credit consumption charged to one allocation container from scheduled issuance-window start, regardless of issuance record creation time or other credit sources in balance | Evaluating a snapshotted bonus-after-base threshold | Individual-user usage, Kilo Pass credit-lot depletion, balance movement |
| **Kilo Pass issuance anchor** | Agreement-specific monthly issuance schedule anchor; self-serve agreements derive it from parent seat-subscription billing anchor, while manual contracts may define another anchor such as calendar-month start | Determining issuance boundaries and allocation effective dates | Global first-of-month schedule |
| **Kilo Pass issuance window** | Agreement-relative monthly interval during which one issuance can accumulate pooled spend and unlock its snapshotted bonus | Referring to bonus eligibility lifetime | Calendar month by default, indefinite threshold, rolling multi-period threshold |
| **Kilo Pass paid-through interval** | Half-open `[paid_from, paid_until)` interval through which org agreement has paid or contractually approved entitlement | Determining scheduled issuance eligibility for self-serve and manual agreements | Inclusive end date, raw provider status alone, payment grace period |
| **Kilo Pass supplement tranche** | Immutable prorated current-window entitlement created only for paid capacity added above capacity already issued in that window | Referring to mid-window seat-increase grants and bonus progress | Rewritten original issuance, raw seat-count increase |
| **Kilo Pass org tier** | One of existing `tier_19`, `tier_49`, or `tier_199` price points selected once per org agreement and applied uniformly to every paid seat | Referring to org-wide per-seat Kilo Pass level | Per-member tier, org-only tier catalog |
| **Kilo Pass org term rules** | Dedicated immutable org rules defining concrete per-pass billing price, base-credit benefit, bonus benefit, unlock spend, and bonus mode | Referring to org agreement benefits | Personal Kilo Pass streak, welcome promo, fingerprint, referral logic, live tier config, formula document |
| **Manual legacy processing** | Agreement mode for an existing manually administered customer whose current-term grants remain operator-controlled while agreement and terms are recorded | Preserving existing current-term arrangements during migration | Missing agreement record, default automated processing |
| **Kilo Pass agreement state** | Commercial lifecycle state: `pending_payment`, `active`, `cancel_at_period_end`, or `ended` | Referring to entitlement lifecycle | Manual, blocked, overallocated |
| **Kilo Pass processing condition** | Operational condition such as manual, blocked, overallocated, or failed that does not replace commercial agreement state | Referring to processing eligibility or remediation | Subscription status, agreement state |
| **Kilo Pass processing run** | Durable attempt to process one agreement and issuance window, with state `pending`, `running`, `succeeded`, `blocked`, or `failed` | Referring to retries, replay, metrics, or blocked-window notifications | Agreement state, provider event |

## Relationships

- A **Code Review Finding** belongs to one captured Code Reviewer review result and contains only controlled taxonomy values in Review Analytics.
- **Review Analytics** enrollment is available only to organization-owned reviews and is snapshotted when a Code Reviewer execution attempt is dispatched; changing the setting does not change an in-flight attempt.
- **AI-estimated impact** describes a reviewed change and remains independent from Code Review Finding counts.
- A **Security Finding** belongs to exactly one Security Agent owner: one user or one organization.
- A **Security Finding** can create at most one **Security Agent Notification** of each kind per **Notification Recipient**.
- A **New-finding Notification** depends on first insertion into Kilo, not source alert creation time.
- An **SLA Warning Notification** and **SLA Breach Notification** use persisted `sla_due_at`; warning does not suppress later breach.
- A Security Agent Audit Report may show a persisted SLA deadline and recorded outcome when trustworthy evidence exists. V1 does not redefine live SLA behavior or calculate authoritative historical SLA compliance.
- A **Notification Recipient** for an organization finding is a current organization member with role `owner`.
- An **Email Delivery** realizes a durable **Security Agent Notification** and may be retried without creating new event identity.
- A **Security Remediation** belongs to one **Security Finding** and can have one or more **Security Remediation Attempts**.
- A **Security Finding Activity Event** belongs to one Security Agent owner and one Security Finding, including after that finding is deleted.
- An **Efficient model pool** belongs to one personal user or organization; an organization pool overrides members' personal pools, while no configured pool inherits the next available setting and then the platform default.
- A **Pool entry** has at most one current **Benchmark profile** for a benchmark-engine version, shared by every owner that selects that entry.
- `kilo-auto/efficient` considers only ready, request-compatible Pool entries from the effective Efficient model pool; its balanced failure fallback remains outside pool membership.
- **Kilo Pass for Organizations** uses a new org-owned source of truth; personal Kilo Pass subscription rows are not authoritative for org agreements.
- A **Kilo Pass org agreement** belongs to a parent organization and records a **Kilo Pass term version**.
- A parent organization has at most one non-ended **Kilo Pass org agreement**.
- **Kilo Pass agreement state** is separate from **Kilo Pass processing condition** so operational blocks do not rewrite commercial lifecycle.
- A **Kilo Pass org agreement** selects one **Kilo Pass org tier** from existing personal tier catalog; same tier applies to every paid seat.
- A **Kilo Pass term version** is immutable. Changing standard or custom commercial terms creates a new version rather than mutating an existing version.
- Each **Kilo Pass term version** contains dedicated **Kilo Pass org term rules** and does not inherit personal Kilo Pass streak, welcome-promo, fingerprint, or referral behavior.
- **Kilo Pass org term rules** snapshot per-pass billing price and base-credit benefit. Issuance does not derive benefit from live tier configuration or actual invoice totals.
- **Kilo Pass org term rules** store concrete base-credit, bonus-credit, and unlock-spend microdollars per pass. An issuance multiplies each by its snapshotted allocation count.
- Automated `upfront` bonus mode grants bonus alongside each monthly base issuance. Annual-all-upfront legacy contracts remain in manual processing for current term.
- A **Kilo Pass term transition** takes effect at commercial renewal: next monthly renewal for monthly agreements, next annual renewal for annual agreements, or explicit contractual renewal for manual agreements.
- A **Kilo Pass org tier** change takes effect only at commercial renewal boundary; current paid period and issuance snapshots retain existing tier.
- Self-serve cancellation takes effect at commercial renewal boundary. Entitlement and scheduled monthly issuances continue through paid period, granted credits remain, and no new issuance occurs after agreement ends.
- Scheduled monthly issuance requires its window to be covered by **Kilo Pass paid-through interval**. Pending cancellation remains eligible through `paid_until`; failed or unpaid renewal blocks later issuance until payment restores entitlement.
- Recognized paid invoices, including legitimate zero-due invoices, advance self-serve paid-through entitlement. Refund, dispute, or chargeback suspends future entitlement for manual review without automatic pooled-credit clawback.
- **Purchased pass capacity** belongs to parent organization; capacity allocated to direct child sub-orgs goes to those children and all remaining capacity becomes the **Parent default allocation**.
- **Required pass capacity** equals the parent organization's paid seat count, not active non-billing-manager membership count.
- A parent organization that opts into Kilo Pass for Organizations has exactly one pass per paid seat; Kilo Pass quantity is not independently selected.
- Successful paid-seat quantity changes for an organization with active Kilo Pass for Organizations automatically synchronize **Purchased pass capacity** to the new paid seat count.
- A mid-window paid-seat increase increases the **Parent default allocation** and creates a **Kilo Pass supplement tranche** for the parent only for capacity above amount already issued in current window; moving that capacity to a child remains future-window effective.
- A supplement uses authoritative remaining-service-time ratio, applies same ratio to base, bonus, and unlock spend, rounds each to nearest microdollar with round-half-up, and snapshots ratio inputs and results rather than deriving benefit from invoice total.
- For `after_base`, supplement grants prorated base and opens independent prorated threshold counting spend after supplement creation. For automated `upfront`, supplement co-grants prorated bonus. Prior spend does not unlock newly added benefit.
- Self-serve Kilo Pass for Organizations is billed through a **Kilo Pass seat add-on item** on parent org's existing seat subscription.
- **Kilo Pass seat add-on item** quantity and cadence match seat subscription item; internal **Kilo Pass org agreement** remains entitlement source of truth.
- Self-serve Kilo Pass charges and issuance schedule are co-termed with parent seat subscription's existing billing anchor.
- Confirmed paid Stripe invoice is authoritative for self-serve agreement activation and first issuance. Webhook processing is idempotent; browser return only displays or polls state. A recoverable failed or action-required payment remains `pending_payment`; a terminal void or uncollectible invoice removes the unpaid add-on and ends the pending agreement so purchase can be retried.
- Initial self-serve purchase allows a parent organization owner or billing manager to record direct-child allocations before first issuance. Confirmed paid activation resolves the remaining purchased capacity to the parent organization and creates immediate issuance for the resulting parent and child allocations matching the paid service interval; absent child allocations, all capacity defaults to parent.
- Paid activation revalidates initial direct-child relationships and allocation totals against current purchased capacity. Invalid hierarchy or direct-child allocations above current capacity block first issuance for owner or billing-manager correction; the system does not silently reduce a selected child allocation.
- Parent organization members with role `owner` or `billing_manager` may purchase, cancel, view, and allocate Kilo Pass for Organizations. Regular members cannot access Kilo Pass management mechanics.
- Kilo Pass purchase, agreement status, and allocation management live on organization subscription page beside seat controls; personal Subscription Center does not manage org Kilo Pass.
- Authorized parent organization owners and billing managers see Kilo Pass terminology in management surfaces. Regular members see only generic organization Credit balances and transaction language, without Kilo Pass labels or mechanics.
- Only parent organization `owner` and `billing_manager` roles manage Kilo Pass allocations. Child sub-org owners may see resulting usable credits through existing balance surfaces but cannot access parent Kilo Pass agreement terms or allocation controls.
- A child sub-org cannot detach, reparent, archive, or delete while its current effective plan, a future-effective plan, or a plan needed by an unresolved processing run assigns it nonzero Kilo Pass allocation. A parent organization owner or billing manager must set the applicable allocations to zero first. Superseded historical allocations do not block the change; already granted pooled credits remain with the child.
- A seat reduction first reduces the derived **Parent default allocation**. If direct-child allocations then exceed purchased pass capacity, the agreement becomes an **Overallocated Kilo Pass agreement**; the seat reduction remains allowed and the system does not choose which direct-child allocation loses future capacity.
- A **Kilo Pass allocation** creates pooled credit capacity for its allocation container; it is not a personal wallet and does not limit usage to specific users.
- The parent organization may act as a **Kilo Pass allocation container** when the customer wants one shared org pool; child sub-org allocations remain optional.
- Phase one allocation containers are parent org and direct child sub-orgs only; agreement owner must be top-level parent.
- **Kilo Pass allocation plan** stores integer allocations for direct child sub-orgs, derives **Parent default allocation** as purchased capacity minus their sum, rejects stale concurrent edits transactionally, and cannot newly set direct-child allocations above purchased capacity.
- Monthly base-credit processing grants Kilo Pass-funded credits only for current allocation counts in each **Kilo Pass allocation container**.
- Self-serve processing uses parent seat subscription's billing anchor as its **Kilo Pass issuance anchor**. Manual enterprise agreements may use calendar-month processing only when contract explicitly defines that anchor.
- Use actual provider period boundaries when available. Internal monthly boundaries derive from original **Kilo Pass issuance anchor** plus month index, clamped to target month end; they never advance from previously clamped boundary.
- New/default annual Kilo Pass org agreements charge annually but create monthly base-credit issuance snapshots; each monthly issuance has its own pooled bonus-after-base unlock. Current-term annual-all-upfront legacy behavior remains manual.
- Joint seat and Kilo Pass purchase creates immediate full first issuance. Mid-period enablement on monthly seats bridges to existing seat renewal. Mid-period enablement on annual seats bridges to next internal monthly anniversary. Full windows then follow agreement's **Kilo Pass issuance anchor**.
- Annual self-serve agreements create monthly issuances on subscription-date anniversaries and no more than 12 issuance windows within one 12-month paid term. Mid-term annual activation bridges only to next internal monthly anniversary, not annual renewal.
- Purchased pass capacity not allocated to direct child sub-orgs becomes **Parent default allocation** and creates spendable parent-org Kilo Pass-funded credits; no paid-but-unassigned state exists.
- The initial self-serve **Kilo Pass allocation plan** applies to first issuance. After first issuance snapshot creation, allocation-plan changes affect future scheduled processing only and do not prorate or recalculate current-period base grants or bonus unlock thresholds, except reconciliation for a blocked window without a snapshot.
- An **Overallocated Kilo Pass agreement** does not alter current-period issuance snapshots; an authorized parent organization owner or billing manager must reconcile future-cycle allocations before next scheduled processing.
- Scheduled issuance processing skips an **Overallocated Kilo Pass agreement** entirely, records a durable blocked result, notifies authorized parent organization owners and billing managers, and retries after allocation reconciliation.
- Delayed or repaired processing creates original scheduled **Kilo Pass issuance window** rather than shifting schedule or skipping paid entitlement. It counts qualifying pooled spend from scheduled window start and keeps original window end.
- Reconciled allocation may supply snapshot retroactively only for blocked, not-yet-created window. Once issuance snapshot exists, later allocation edits remain future-effective.
- Bonus-after-base evaluation uses the relevant **Kilo Pass org issuance snapshot**, not live allocation state or live bonus terms.
- Every **Kilo Pass org issuance snapshot** records the resolved terms from its agreement's immutable **Kilo Pass term version**.
- Existing legacy customers are backfilled with a **Kilo Pass org agreement**, dedicated immutable terms where needed, contractual paid-through interval, external contract identity, processing mode, and `manually_issued_through`; migration does not synthesize historical issuances or credits.
- **Manual legacy processing** does not automatically issue current-term grants; transition to automated processing requires explicit commercial renewal transition.
- Newly sold manual or enterprise agreements use automated allocation, monthly issuance, and pooled bonus processing by default; manual processing requires explicit legacy or exceptional contract designation.
- Bonus-after-base unlock compares **Kilo Pass pooled spend** with issuance's snapshotted unlock-spend threshold; default terms set threshold equal to base, but custom terms may differ.
- **Kilo Pass pooled spend** includes chargeable model, API, hosting, and other product Credit consumption. It excludes transfers, expirations, grants, refunds, reversals, and administrative adjustments.
- Canonical allocation-container spend recording atomically advances **Kilo Pass pooled spend** and grants an issuance bonus exactly once when threshold is crossed; idempotent sweep repairs missed evaluations. Request-level qualifying debits are recorded only for organizations that are current or planned allocation containers of a non-ended agreement and are hidden from member and admin Credit activity lists.
- Exact organization ledger debited by request owns spend attribution. Parent membership or allocation in another container never transfers spend between containers.
- Each issuance counts **Kilo Pass pooled spend** only within its agreement-relative **Kilo Pass issuance window**. A still-locked bonus expires when next window begins; unused granted base credits may remain in the allocation-container balance.
- An unlocked org bonus grant expires at next agreement-relative issuance boundary. Expiration removes only unused bonus value; unused base credits remain in allocation-container balance.
- If repair occurs after issuance window ended, system backfills base and historical outcome but does not silently create already-expired spendable bonus. It records missed bonus for audited operator compensation and processes windows chronologically.
- One **Kilo Pass processing run** is all-or-nothing across agreement allocation containers; one container failure rolls back whole agreement/window issuance.
- Stable idempotency identities exist for provider event, activation, agreement/container/window issuance, supplement, bonus tranche, credit grant, expiry, and blocked result.
- **Kilo Pass processing runs** use leased idempotent retries, metrics, and manual replay. Blocked window shows persistent subscription-page status and sends one deduplicated email to current parent organization owners and billing managers.
- The product does not support creating new custom or manual agreements. Platform admins may maintain imported legacy agreements by setting paid-through intervals, designating manual processing, scheduling commercial transitions, issuing audited compensation, or manually retrying; each mutation records actor, reason, before/after values, and timestamp.
- Organization subscription page supports initial direct-child distribution before first issuance, then separates current immutable issuance snapshot from next **Kilo Pass allocation plan** and effective date; it shows purchased, parent-default, direct-child allocated, paid-through, pending-cancellation, blocked, and overallocated state.
- **Cost Insights is retired.** No Cost Insights code runs: the UI, tRPC procedures, cron sweeps, spend capture, evaluation, alerting, and rollup maintenance are all removed, and none may be reintroduced. The `cost_insight_*` tables still exist but are no longer read or written, and are scheduled to be dropped.
- Credit spend paths record spend and usage only. They no longer maintain an hourly spend rollup, so spend recording no longer depends on Cost Insights availability.
- The former Cost Insights routes serve a discontinued notice so old bookmarks and previously sent alert emails do not land on a 404.
- A **Security Finding Activity Event** falls into a report period based on when Kilo recorded or applied it. External source timestamps are supporting evidence and do not determine report inclusion.
- A **Security Agent Audit Report** groups every matching reportable **Security Finding Activity Event** recorded by Kilo in the selected period.
- V1 reports persisted SLA evidence only when it can do so from trustworthy recorded data. It does not calculate historical SLA compliance percentages or introduce new SLA lifecycle semantics.
- A personal **Security Agent Audit Report** is available only to its owning user. An organization report is available to organization owners, billing managers, and audited Kilo platform admins, not ordinary members.
- Security Agent Audit Report access has no separate plan or active-subscription gate; authorized owners retain read-only historical access after cancellation or disablement.
- A **Security Agent Audit Report** includes owner history from current, deselected, unavailable, and deleted repository scope. Current Security Agent repository selection does not limit historical evidence; an explicit report repository filter may narrow displayed Security Finding groups by exact recorded repository full name.
- Human activity in a **Security Agent Audit Report** uses an event-time display name and stable typed actor reference; automated activity uses explicit system attribution. Actor and notification recipient emails are not report evidence.
- Deleting an actor's Kilo account anonymizes their dedicated identity fields in organization-owned Security Finding Activity Events while preserving stable non-PII attribution and event evidence. Identity-bearing values do not belong in event snapshots or arbitrary metadata.
- Superseded Security Findings remain separate report groups and show their canonical Security Finding ID when recorded; canonical remediation evidence is not copied into superseded groups.
- Each v1 report range is capped at 90 inclusive calendar days.
- A report displays its reliable event-coverage start and labels supplemental legacy activity as potentially incomplete.
- Disabling Security Agent or its integration does not hide authorized historical Security Agent Audit Reports.
- `security_audit_log` is the canonical ledger for Security Finding Activity Events; finding events are distinguished by stable finding identity.
- A reportable local Security Finding state transition and its Security Finding Activity Event are atomic. External side effects use a durable request event and terminal outcome event without keeping database transactions open across network calls.
- Security Agent Audit Reports include structured, sanitized analysis and remediation outcomes, not prompts, raw analysis markdown, transcripts, assistant messages, full execution logs, or recipient-level notification history.

## Agent Rules

- Use **Code Review Finding** for an issue raised by Code Reviewer. Never call it a **Security Finding**, even when its category is `security`.
- Describe Review Analytics values as model-generated signals: use "findings raised" and **AI-estimated impact**, not confirmed bugs, verified vulnerabilities, or developer quality.
- Keep Review Analytics organization-only, prospective, and opt-in. Missing, invalid, or omitted structured results are unavailable coverage states, not zero-finding reviews.
- Do not persist finding prose, code, paths, lines, symbols, prompts, raw manifests, or full assistant output in Review Analytics.
- Use **Security Finding** for Kilo's persisted domain object. Use "Dependabot alert" only for external source object at GitHub boundary.
- Use exact notification kind when discussing eligibility or history: **New-finding Notification**, **SLA Warning Notification**, or **SLA Breach Notification**.
- Treat "new" as first insertion for owner in Kilo. Updates and reopening do not make finding new again.
- Distinguish **Security Agent Notification** from **Email Delivery**. Event deduplication does not guarantee provider-level exactly-once delivery.
- Use "Security Agent owner" for user/organization policy boundary and "organization owner" for membership role.
- Keep notification eligibility and outbox transitions in **Security Sync**. Keep rendering and Mailgun access in **Security Agent Email Delivery**.
- Keep notification config parsing and pure eligibility semantics in **Shared Security Notification Policy** so web and Worker cannot drift.
- Do not call organization members or billing managers **Notification Recipients** unless they also hold current organization `owner` role.
- Treat "all activity" in a **Security Agent Audit Report** as all material actions and outcomes recorded by Kilo, not every internal processing step or an attestation that legacy history is exhaustive. Exclude reads, unchanged sync observations, queue claims, heartbeats, and retries with no new finding-level outcome.
- A rollout baseline event records current state at actual capture time for an existing Security Finding; it is not a synthetic creation event and must not be backdated.
- Use **Kilo Pass for Organizations** for the org-owned product. Do not describe org agreements as personal Kilo Pass subscriptions.
- Use **Kilo Pass org agreement** for the durable org-owned source of truth. Do not use seat purchase rows as the Kilo Pass source of truth.
- Use existing `tier_19`, `tier_49`, and `tier_199` identifiers for **Kilo Pass org tier**. Do not create per-member tiers or separate org tier identifiers without a later product decision.
- Use immutable **Kilo Pass term versions** for both reusable standard terms and one-off legacy/custom terms. Do not store mutable bonus policy only on the agreement.
- Keep **Kilo Pass org term rules** independent from personal Kilo Pass bonus and promotion code. Similar commercial values may be configured explicitly without sharing personal lifecycle logic.
- Record legacy agreements even when grants remain manual. Do not infer automated current-term grants or leave legacy entitlement represented only by operator notes and bonus-credit transactions.
- Treat manual purchase channel separately from processing mode. Do not make new sales-assisted agreements manually administered by default.
- Use term-version base-credit benefit for issuance. Do not let discounts, taxes, prorations, or later tier-config changes alter purchased credit entitlement.
- Use concrete microdollar amounts for org base, bonus, and unlock threshold. Do not introduce percentage rounding or flexible formula evaluation for org term versions.
- Interpret automated `upfront` as monthly base-and-bonus co-grant. Do not add annual-upfront automation solely for legacy current-term agreements.
- Use a **Kilo Pass term transition** for future version changes. Do not change an active agreement's terms during its paid commercial period.
- Schedule org-wide tier changes for commercial renewal. Do not create mid-period supplemental grants, prorations, or bonus-threshold rewrites for tier changes.
- Use **Required pass capacity** when referring to the all-seat quantity. It exactly equals paid parent-org seats, not occupied seats or an independently selected quantity.
- Treat paid-seat and purchased-pass quantities as one synchronized entitlement for active Kilo Pass org agreements. Do not permit a successful seat change to leave pass capacity below paid seat count.
- Match confirmed paid seat-increase billing with an immediate prorated supplement to the **Parent default allocation**. Grant only capacity above current-window issued capacity; do not move the supplement to a child mid-window or double-grant after decrease/reincrease.
- Use **Kilo Pass seat add-on item** for self-serve Stripe billing. Do not model self-serve org Kilo Pass as separate Stripe subscription or make Stripe item source of agreement terms and allocations.
- Do not activate self-serve agreement or grant first issuance from subscription-item presence or browser return. Require paid invoice evidence.
- Use parent seat subscription billing anchor as self-serve **Kilo Pass issuance anchor**. Do not create a global first-of-month entitlement boundary for self-serve agreements.
- Derive internal issuance boundaries from original anchor plus month index. Do not repeatedly add a month to prior boundary because short-month clamping causes permanent schedule drift.
- When a seat decrease creates overallocation, preserve current-period issuance and require owner or billing-manager reconciliation for future direct-child allocations. Do not automatically choose a child allocation to reduce.
- Do not partially issue or overgrant an **Overallocated Kilo Pass agreement**. Block entire agreement's scheduled processing until allocations are reconciled.
- Retry blocked or failed issuance against original scheduled boundaries. Do not shift agreement anchor or discard paid issuance because processing completed late.
- Use **Purchased pass capacity** and **Kilo Pass allocation** for org pass counts. Use **Sub-org allocation** only when container is direct child. Do not call these user assignments or personal wallets.
- Use **Kilo Pass allocation container** when behavior applies to either the parent org default pool or a child sub-org pool.
- Before initial self-serve issuance, allow a parent organization owner or billing manager to allocate capacity across direct child sub-orgs. Resolve all remaining purchased capacity to parent organization and use that distribution for first issuance; if no child allocation is provided, allocate all capacity to parent.
- Use existing parent organization `owner` and `billing_manager` roles for Kilo Pass management. Do not introduce a Kilo Pass-specific organization admin role.
- Place org Kilo Pass management with organization seat subscription workflow, not personal Subscription Center or general member dashboard.
- Keep parent-funded Kilo Pass allocation authority at parent organization boundary. Do not infer allocation authority from child sub-org ownership.
- Do not detach, reparent, archive, or delete a child with a nonzero current effective, future-effective, or unresolved-run allocation, and do not attempt source-specific credit clawback. Require zero for the applicable plans, ignore superseded historical allocations, and preserve already granted pooled credits.
- Keep Kilo Pass terminology on authorized management and audit surfaces. Do not expose pass counts, tiers, bonus rules, or Kilo Pass-funded transaction labels to regular members.
- Treat self-serve Kilo Pass for Organizations monthly processing as agreement-relative and provider-anchored. Use calendar-month processing only for manual contracts that explicitly define it.
- Treat annual cadence as payment cadence for new/default agreements, not annual upfront credit cadence. Preserve current-term annual-all-upfront legacy behavior through manual processing.
- Treat self-serve cancellation as non-renewal, not immediate entitlement removal or credit clawback. Annual agreements continue monthly issuances through prepaid annual term.
- Use **Kilo Pass paid-through interval**, not raw Stripe status alone, to determine scheduled issuance eligibility across self-serve and manual agreements.
- Match initial issuance to paid service interval: full for joint seat/Kilo Pass start, prorated bridge for mid-period enablement on existing seat subscription.
- Do not issue again at next calendar-month boundary. Next self-serve issuance occurs at next agreement-relative boundary defined by **Kilo Pass issuance anchor**.
- Use **Parent default allocation** for purchased capacity not allocated to direct child sub-orgs. Do not model or display paid capacity as unassigned, unused, or pending allocation.
- Apply initial self-serve **Kilo Pass allocation plan** to first issuance. Treat every later allocation-plan change as a next-window input except blocked-window reconciliation before snapshot; ordinary mid-window edits do not create immediate grants, prorations, reversals, or threshold rewrites.
- Use **Kilo Pass org issuance snapshot** when describing period-specific base grants and bonus unlock thresholds. Do not compute current-period bonus unlock from live allocation or live term-version changes.
- Use **Kilo Pass pooled spend** for container-level threshold progress. Do not model bonus unlock as individual usage or explicit depletion of a Kilo Pass credit lot.
- Do not advance **Kilo Pass pooled spend** for ledger movement that is not actual product consumption.
- Keep normal bonus unlock transactional with canonical spend recording and issuance-level idempotency. Do not rely on asynchronous or scheduled evaluation as primary unlock path.
- Treat bonus eligibility as period-bounded by agreement-relative **Kilo Pass issuance window**. Do not carry a locked bonus threshold into later windows or count later spend toward multiple issuance bonuses.
- Apply bonus-credit expiry at next agreement-relative issuance boundary, matching personal Kilo Pass period behavior. Do not apply same period expiry to base credits.
- Use **Efficient model pool** for the candidate set and **Pool entry** for an exact model and canonical thinking variant. Do not introduce a second efficient mode or model ID.
- Treat **Benchmark profiles** as global evidence, never owner-specific benchmark results.

## Ambiguities

| Ambiguous term | Problem | Canonical decision |
|---|---|---|
| finding | Can mean Code Reviewer output or the Security Agent's persisted vulnerability object | Use **Code Review Finding** for Code Reviewer output and **Security Finding** only for the Security Agent domain object |
| impact | Can imply delivered business value, diff size, complexity, or individual performance | Use **AI-estimated impact** only for the model-generated reach-and-consequence classification |
| alert | Can mean external Dependabot alert, persisted Security Finding, or outgoing notification | Use "Dependabot alert" at source boundary, **Security Finding** after persistence, and exact notification kind for outgoing event |
| notification email | Conflates durable semantic event with retryable provider side effect | Use **Security Agent Notification** for event and **Email Delivery** for send attempt |
| new finding | Can mean newly created at source, first observed, inserted, updated, or reopened | For notification policy, it means first insertion into Kilo for owner |
| owner | Can mean Security Agent policy owner or organization membership role | Use "Security Agent owner" for user/organization boundary and "organization owner" for role |
| SLA reminder | Does not distinguish warning before deadline from breach at/after deadline | Use **SLA Warning Notification** or **SLA Breach Notification** |
| Kilo Pass subscription | Can mean current personal Kilo Pass subscription or future org Kilo Pass purchase | Use **Kilo Pass org agreement** for org-owned terms and personal Kilo Pass subscription for the existing user product |
| assigned pass | Can imply a user receives a personal credit wallet | Use **Kilo Pass allocation** for org pass distribution and **Purchased pass capacity** for bought capacity |
| admin | Can mean customer organization role or internal Kilo operator | Use "organization owner" or "billing manager" for customer roles; use "platform admin" for internal manual-commercial operations |

## Context Boundaries

- **Code Reviewer** owns review execution, Code Review Findings, Review Analytics settings, and user-visible aggregate review signals.
- Review Analytics stores bounded taxonomy observations separately from Security Agent `security_findings` and does not establish a cross-review finding lifecycle.
- **Security Agent** owns product policy, settings, permissions, and user-visible finding/remediation outcomes.
- **Security Sync** owns finding synchronization, notification event admission, recipient intent materialization, deduplication, and durable state transitions.
- **Security Agent Email Delivery** may revalidate and deliver an existing notification but must not create notification eligibility or copy mutable finding data into Worker request.
- **Shared Security Notification Policy** defines common parsing and pure eligibility behavior; it does not perform persistence or recipient lookup.
- Cross-context dispatch sends only stable notification ID from **Security Sync** to authenticated **Security Agent Email Delivery** boundary.
- **Auto Routing** owns effective pool resolution and per-request selection. The benchmark worker owns Benchmark profile measurement and publication; web owns catalog validation, permissions, and settings UI.
- **Kilo Pass for Organizations** owns org agreements, term versions, purchased pass capacity, allocation plans, issuance snapshots, and pooled bonus-after-base behavior. Personal Kilo Pass owns existing user subscriptions and user-global threshold behavior.
- Org seat purchases may determine eligible seat counts for Kilo Pass for Organizations, but seat purchase rows are not the Kilo Pass agreement source of truth.

## Decision References

- `.specs/kilo-pass.md` defines current personal Kilo Pass behavior.
- `docs/adr/0003-org-kilo-pass-source-of-truth.md` records org-owned agreement, provider-anchored issuance, allocation, bonus, migration, and operational decisions.
- `.plans/code-review-analytics.md` defines prospective Review Analytics collection, taxonomy, persistence, and metric semantics.
- `.specs/security-agent.md` defines Security Agent Auto Remediation and notification guarantees.
- `.plans/security-agent-notifications.md` records notification implementation and rollout design.
- `.plans/security-agent-audit-report.md` records Security Agent Audit Report implementation and evidence design.
