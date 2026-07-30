# ADR 0003: Use Org-Owned Agreements for Kilo Pass for Organizations

## Status

Accepted

## Context

Kilo Pass currently exists as a personal-user product. Current subscription, issuance, bonus threshold, scheduled-change, and audit records are keyed to `kilo_user_id` and personal subscription state.

Kilo Pass for Organizations has different requirements: parent organization billing, coverage for all eligible paid seats, allocation into direct child sub-orgs with all remaining purchased capacity defaulting to parent organization, pooled org or sub-org usage for bonus unlocks, manual enterprise agreements, and term-version preservation for legacy upfront-bonus deals.

The existing organization billing model already has seat purchase history and organization credit ledgers, but those rows do not preserve Kilo Pass-specific bonus terms, allocation state, or pooled unlock state.

## Decision

Kilo Pass for Organizations will use org-owned agreement records as its source of truth.

Personal Kilo Pass subscription rows remain the source of truth for the existing user-owned product only. Seat purchase rows may inform eligible seat counts and billing integration, but they are not the Kilo Pass for Organizations agreement source of truth.

Each org agreement references an immutable Kilo Pass term version. Standard term versions may be reused; manual legacy or custom deals may receive dedicated immutable versions. Commercial changes create new versions instead of mutating existing terms, and each issuance snapshots its resolved version terms.

Org term versions explicitly define concrete per-pass base benefit, bonus amount, unlock spend, and bonus mode. They do not inherit personal Kilo Pass streak, welcome-promo, payment-fingerprint, referral logic, or percentage formula evaluation. Similar commercial values may be configured independently.

Each term version snapshots per-pass billing price and base-credit benefit. Standard versions may match tier price; dedicated custom versions may differ. Issuance does not derive entitlement from live tier configuration, discounts, taxes, provider invoice proration amount, or actual invoice total.

Term versions store concrete `base_credit_microdollars_per_pass`, `bonus_credit_microdollars_per_pass`, and `unlock_spend_microdollars_per_pass` values. Each issuance multiplies these values by snapshotted allocation count. Default bonus-after-base terms set unlock spend equal to base benefit; future or custom versions may use another explicit amount.

Automated `upfront` bonus mode grants bonus alongside each monthly base issuance. Annual-all-upfront legacy contracts remain manual for current term rather than adding a separate annual bonus scheduler.

Each org agreement selects one existing Kilo Pass tier: `tier_19`, `tier_49`, or `tier_199`. The selected tier applies uniformly to every paid seat. Org agreements do not introduce separate org-only tier identifiers.

Existing manually administered customers are backfilled into org agreement records with purchase channel, contractual paid-through interval, and dedicated immutable custom terms where needed. Their current term uses manual legacy processing, so automated issuance does not duplicate operator grants. Automated processing begins only through an explicit renewal transition.

Migration records contractual half-open paid-through interval, external contract identity, processing mode, and `manually_issued_through`. It does not synthesize historical issuances or credits. Automation requires explicit next allocation plan and renewal transition.

The product does not support creating new manual, enterprise, or custom agreements yet. Manual processing exists only to preserve imported legacy agreements; purchase channel does not determine processing mode.

An agreement moves to a newer term version at its commercial renewal boundary: next monthly renewal for monthly agreements, next annual renewal for annual agreements, or explicit contractual renewal for manual agreements. Existing terms remain effective through the paid period.

Org-wide tier upgrades and downgrades also take effect only at commercial renewal boundary. Current paid period and issuance snapshots retain existing tier; no supplemental mid-period grant or threshold rewrite occurs.

Self-serve cancellation takes effect at commercial renewal boundary. Monthly agreements retain current paid-period entitlement; annual agreements continue scheduled monthly issuances through prepaid annual term. Granted credits remain, current issuance bonus may unlock through its issuance window, and no new issuance occurs after agreement ends.

Each agreement records half-open `[paid_from, paid_until)` entitlement intervals. Scheduled issuance occurs only while covered by interval; partial coverage creates explicit bridge window. Pending cancellation remains eligible through `paid_until`; failed or unpaid renewal blocks later issuance until payment restores entitlement. Manual agreements use contractual dates. Late successful payment backfills original covered windows.

Recognized `invoice.paid`, including legitimate zero-due invoice, extends self-serve paid-through entitlement. Refund, dispute, or chargeback suspends future entitlement and enters manual review without automatic pooled-credit clawback.

When a parent organization opts into Kilo Pass for Organizations, purchased pass capacity exactly equals the parent organization's paid seat count. Kilo Pass is a seat add-on, not an independently sized product. The count is not based on current active non-billing-manager members or occupied seats.

For an organization with an active Kilo Pass org agreement, every successful paid-seat quantity change automatically synchronizes purchased pass capacity to the new paid seat count. Kilo Pass capacity remains exactly equal to paid seat count.

A paid mid-window seat increase adds matching capacity to derived parent default allocation and creates a parent supplement only for `max(0, new purchased capacity - capacity already issued for current window)`. Moving added capacity to a child remains future-window effective. This prevents decrease/reincrease from granting twice. Seat decreases do not claw back or rewrite current-window issuance.

Supplement proration uses authoritative remaining-service-time ratio. Same ratio applies to base, bonus, and unlock spend; each result rounds to nearest microdollar with round-half-up. Snapshot records numerator, denominator, and resolved amounts. Benefit does not derive from invoice total.

In `after_base` mode, supplement is separate tranche that grants prorated base and opens independent prorated threshold using spend after supplement creation. In automated `upfront` mode, it co-grants prorated bonus. Spend before supplement does not unlock newly added benefit.

Self-serve Kilo Pass for Organizations is billed as recurring add-on item on parent organization's existing Stripe seat subscription. Add-on quantity and cadence remain synchronized with seat item. Internal org agreement, not Stripe item, remains source of entitlement terms, allocation, and issuance state.

Self-serve Kilo Pass charges and credit issuance schedule are co-termed with parent seat subscription on its existing billing anchor. Joint seat and Kilo Pass purchase records initial direct-child allocations before payment completion and creates immediate full first issuance from resolved child allocations and parent remainder. Mid-period enablement on monthly seats bridges to existing seat renewal. Mid-period enablement on annual seats bridges to next internal monthly anniversary. Full windows then follow seat-subscription anchor.

Confirmed paid Stripe invoice is authoritative for self-serve agreement activation and first issuance. Before payment completion, server persists initial direct-child allocation selection, if any. Webhook processing idempotently creates or activates agreement, resolves all remaining capacity to parent, and creates first issuance from that resolved allocation. Browser return may poll and display state but does not authorize entitlement or allocation.

Initial self-serve purchase allows a parent organization owner or billing manager to allocate integer pass capacity across direct child sub-orgs before first issuance. On paid activation, all purchased capacity not assigned to a direct child defaults to parent organization, and immediate issuance matching the paid service interval uses that resolved distribution. Later allocation changes apply only to future issuance windows.

Paid activation revalidates initial direct-child relationships and allocation totals against current purchased capacity. If a selected child is no longer a direct child or direct-child allocations exceed current purchased capacity, first issuance blocks for owner or billing-manager correction. The system does not silently reduce an explicitly selected child allocation.

At most one non-ended agreement may exist for a parent organization. Commercial states are `pending_payment`, `active`, `cancel_at_period_end`, and `ended`. Manual, blocked, overallocated, and failed are processing conditions rather than commercial states.

Existing parent organization owners and billing managers may purchase, cancel, view, and allocate Kilo Pass for Organizations. Regular members cannot access Kilo Pass purchasing, agreement, or allocation mechanics.

Kilo Pass purchase, status, and allocation controls live on existing organization subscription page beside seat controls. Personal Subscription Center does not manage org Kilo Pass.

Authorized parent organization owners and billing managers see Kilo Pass terminology in management and audit surfaces. Regular members see generic organization Credit balance and transaction language without Kilo Pass labels, counts, tiers, or bonus mechanics.

Child sub-org owners do not gain Kilo Pass allocation authority from child ownership. They may see resulting usable credits through existing balance surfaces, while parent owners and billing managers retain agreement and allocation control.

A child sub-org cannot detach, reparent, archive, or delete while it has nonzero initial or future Kilo Pass allocation. A parent organization owner or billing manager must first set allocation to zero. Already granted pooled credits remain with child because shared balance cannot safely identify source-specific remainder for clawback.

A seat decrease first reduces future parent default allocation. If direct-child allocations then exceed purchased pass capacity, the seat and pass count decrease still takes effect, parent default allocation becomes zero, and current-period issuance snapshots remain unchanged. The agreement enters an overallocated state that an authorized parent organization owner or billing manager must reconcile before next scheduled processing; the system does not choose which direct-child allocation loses capacity.

If the agreement remains overallocated at scheduled issuance processing, processing skips the entire agreement. It records a durable blocked result, notifies authorized parent organization owners and billing managers, and retries after allocations are reconciled. It does not partially issue by choosing containers or grant above paid capacity.

When blocked or failed processing later succeeds, it creates the original scheduled issuance window. Grant, pooled-spend threshold, and bonus expiry retain original boundaries; qualifying spend since scheduled window start counts. Processing delay does not shift agreement anchor or discard paid entitlement.

Allocation reconciliation may supply snapshot retroactively only for blocked, not-yet-created window. Once issuance snapshot exists, later allocation changes remain future-effective.

Monthly Kilo Pass for Organizations processing grants base credits to every allocation container with resolved pass capacity. Direct-child allocations are explicit integers, and parent allocation is derived as purchased capacity minus direct-child allocation sum. Every purchased pass therefore belongs to a child or parent allocation container, and no paid-but-unassigned state exists. Allocation plans are versioned by effective issuance boundary and reject stale concurrent writes transactionally.

Self-serve monthly processing uses parent seat subscription's billing anchor. Manual enterprise agreements may use a calendar-month anchor only when contract explicitly defines it. Reporting may group issuances by calendar month without making calendar month entitlement boundary.

Actual provider period boundaries are authoritative when available. Internal monthly boundaries derive from original billing anchor plus month index and clamp to target month end. They do not advance from previously clamped boundary. A January 31 anchor therefore yields February month-end, then March 31, not March 28.

New/default annual agreements charge annually but create monthly base-credit issuance snapshots. Each monthly issuance has its own pooled bonus-after-base unlock. Current-term annual-all-upfront legacy behavior remains manual.

When joint self-serve seat and Kilo Pass purchase completes, paid activation creates immediate full first issuance from pre-issuance direct-child allocation selection and derived parent remainder. Mid-period activation on monthly seats creates a prorated bridge through next seat renewal. Mid-period activation on annual seats creates a prorated bridge through next internal monthly anniversary.

Annual self-serve agreements create monthly issuances on subscription-date anniversaries and no more than 12 issuance windows during one 12-month paid term. Mid-term annual activation bridges only to next internal monthly anniversary, then full monthly windows continue through annual renewal.

The parent organization may be an allocation container for Kilo Pass-funded pooled credits when customer wants one shared org pool. Child allocations support direct children only in phase one; agreement owner must be top-level parent.

Initial allocation selection applies to first issuance. Every allocation-plan change after first issuance affects future scheduled processing only. Current-period base grants and bonus unlock thresholds are not prorated, recalculated, or reversed for ordinary mid-window edits. Blocked-window reconciliation may supply allocation only when no snapshot exists.

Bonus-after-base unlocks use immutable issuance snapshot created for allocation container. Snapshot records allocation count, concrete amounts, term version, and unlock threshold for window. Unlock logic does not read live allocation or live bonus terms after snapshot exists.

Bonus progress uses cumulative Credit spend charged to allocation container from scheduled window start, regardless of issuance record creation time or other credit sources in balance. Unlock compares spend with snapshotted unlock-spend threshold and does not require credit-lot ordering or proof that a specific Kilo Pass grant funded each deduction.

Qualifying spend is actual product Credit consumption, including chargeable model, API, hosting, and other product usage. Parent-child transfers, expirations, grants, refunds, reversals, and administrative adjustments do not advance bonus progress.

Exact organization ledger debited by request owns spend attribution. Parent membership or allocation in another container never transfers spend between containers.

Canonical allocation-container spend recording atomically advances issuance pooled spend and grants bonus exactly once when threshold is crossed. Issuance-level idempotency handles concurrent spend and retries. An idempotent sweep repairs missed evaluations but is not the normal unlock path.

Each issuance counts spend only during its agreement-relative issuance window. A still-locked bonus expires when next window begins. Unused granted base credits may remain in allocation-container balance, but old bonus opportunity does not carry forward.

When bonus unlocks, its credit grant expires at next agreement-relative issuance boundary. Expiration removes only unused bonus value. Base credits do not receive this period expiry and may remain in allocation-container balance.

If repair occurs after window ended, system backfills base and historical outcome but does not silently create already-expired spendable bonus. It records missed bonus for audited operator compensation. Windows process chronologically so later window cannot bypass unresolved earlier window.

One agreement/window processing attempt is an all-or-nothing database transaction. One allocation-container failure rolls back whole agreement issuance. Stable unique identities cover provider event, agreement activation, agreement/container/window issuance, invoice-line supplement, bonus tranche, credit grant, expiry, and blocked result.

Canonical qualifying debit ledger remains queryable by allocation container, timestamp, and stable transaction ID. Blocked run records original window immediately; repair reconstructs pooled spend from immutable debit records.

The product does not expose creation of new custom or manual agreements. Platform admins may maintain imported legacy agreements by setting paid-through intervals, designating manual processing, scheduling commercial transitions, issuing audited compensation, or manually retrying processing. Every mutation records actor, reason, before/after values, and timestamp.

Issuance operations persist `pending`, `running`, `succeeded`, `blocked`, or `failed`, use leased idempotent retries, expose manual replay and metrics, and show persistent subscription-page status. Blocked window sends one deduplicated email to current parent owners and billing managers.

Subscription page supports initial direct-child distribution before first issuance, then separates immutable current issuance snapshot from next allocation plan and effective date. It also shows purchased capacity, derived parent allocation, direct-child allocations, paid-through, pending-cancellation, blocked, and overallocated state.

## Alternatives

- Extend personal Kilo Pass subscriptions with organization fields and branch logic.
- Store Kilo Pass for Organizations terms only on organization seat purchase rows.
- Use global calendar-month issuance instead of provider-anchored agreement windows.
- Bill Kilo Pass through separate Stripe subscription rather than seat add-on item.
- Mutate live agreement terms or allocations instead of immutable versions and snapshots.

## Consequences

Kilo Pass for Organizations can model agreement versions, manual and self-serve purchase channels, purchased pass capacity, sub-org allocation, and pooled bonus-after-base unlocks without overloading personal Kilo Pass lifecycle rules.

Immutable term versions preserve the meaning of purchased agreements and allow support to identify which standard or custom rules produced each issuance.

Dedicated org term rules keep user-specific promotion and anti-abuse behavior out of parent-owned pooled agreements.

Recording legacy agreements without automating current-term grants preserves purchased behavior and creates one entitlement inventory without requiring unreliable historical issuance reconstruction.

Automating new sales-assisted agreements prevents manual operations from remaining the default enterprise lifecycle while preserving contractual exceptions.

Snapshotted price and benefit preserve purchased agreement meaning when product prices or provider invoices change.

Concrete microdollar values make grants and thresholds exact and auditable without percentage rounding or a general rule-expression engine.

Renewal-bound transitions prevent mid-term changes to prepaid benefits while avoiding permanent accidental grandfathering.

Renewal-bound tier changes keep provider price, per-seat base amount, and bonus terms on same effective date without mid-period issuance adjustment.

Period-end cancellation preserves purchased benefits and avoids pooled-credit attribution and clawback requirements.

Explicit paid-through entitlement separates credit eligibility from asynchronous provider status and gives self-serve and manual agreements one issuance gate.

Exact equality with paid seat count enforces seat add-on model, while parent-default allocation ensures every purchased pass produces value in either parent or direct-child container.

Automatic quantity synchronization enforces all-seat coverage as a system invariant rather than relying on a separate administrative step or later reconciliation.

Prorated seat-increase supplements make paid added capacity immediately useful without granting full-window value for partial-window payment.

Using one Stripe subscription gives seat and Kilo Pass items same invoice, renewal, cadence, and quantity lifecycle without cross-subscription synchronization.

Paid-invoice authority prevents unpaid or incomplete subscription updates from granting credits and makes provider retries safe.

Provider-anchored issuance keeps paid periods, credit windows, and cancellation boundaries consistent without changing existing seat billing terms.

Optional pre-issuance direct-child distribution lets an owner or billing manager direct first-window value immediately, while parent-default allocation ensures purchase still provides immediate credits without requiring any child allocation.

Seat reductions automatically consume parent default allocation first. Explicit reconciliation is required only when direct-child allocations exceed reduced purchased capacity, avoiding silent reduction of a business-critical child's allocation while allowing seat administration and provider-originated quantity changes to complete.

Blocking the entire overallocated agreement fails closed without granting unpaid capacity or encoding arbitrary team priority into billing logic.

Retrying original windows preserves provider-period alignment and paid entitlement while keeping reporting and later issuance dates stable.

Granting credits from direct-child allocations and derived parent default allocation keeps every purchased pass tied to one usage container without retroactive allocation changes or paid-but-unused capacity.

Agreement-relative processing prevents one payment from producing extra issuance windows at calendar boundaries. Calendar-month reporting remains available independently.

Original-anchor boundary derivation prevents cumulative short-month drift and supports exactly 12 monthly windows per annual paid term.

Separating annual payment cadence from monthly credit cadence keeps default monthly and annual agreements on one grant and bonus model while preserving versioned legacy exceptions.

Immediate full or prorated first issuance makes paid credits usable immediately while matching benefit to provider-billed service interval.

Allowing the parent organization as the default allocation container avoids forcing sub-org setup for organizations that want one shared pool and matches existing organization credit ledger behavior.

Future-cycle allocation changes apply at next agreement-relative issuance and avoid duplicate grants, clawbacks, or threshold rewrites caused by mid-period allocation edits.

Issuance snapshots make bonus unlock behavior auditable and keep later allocation or agreement-version changes from mutating current-period entitlements.

Container-level spend counters preserve pooled behavior and avoid introducing a separate wallet-bucket consumption model into existing organization credit balances.

Transactional unlock makes bonus available immediately after base-threshold consumption and avoids an eventual-consistency window where funded usage can be blocked.

Period-bounded eligibility prevents one later spend event from satisfying multiple monthly thresholds and avoids maintaining a queue of old locked bonuses.

Implementation adds new schema and routing rather than reusing existing personal Kilo Pass tables directly. Integration code must bridge org agreements to seat billing, credit grants, usage attribution, and admin UI.
