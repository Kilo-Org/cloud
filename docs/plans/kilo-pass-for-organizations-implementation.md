# Kilo Pass for Organizations implementation plan

## Outcome

Ship the accepted Kilo Pass for Organizations model from ADR 0003 as a production feature. The implementation must preserve the separation between personal Kilo Pass subscriptions and organization-owned agreements, use the parent seat subscription as the Stripe billing vehicle, allocate pooled Credits to the parent or direct children, and make issuance and bonus processing replay-safe.

## Delivery principles

- The Kilo Pass org agreement is the entitlement source of truth. Stripe and seat-purchase rows are integration inputs.
- Purchased pass capacity always equals the parent organization's paid seat count.
- Current term versions and issuance snapshots are immutable. Changes apply at their documented future boundary.
- Every purchased pass resolves to the parent or a direct child. No user assignment or unassigned capacity exists.
- One agreement/window issuance is one database transaction. Retries cannot duplicate grants.
- Organization management requires parent `owner` or `billing_manager` authority on both page and API boundaries.
- Browser return from Stripe is display-only. A recognized paid invoice activates entitlement.
- The implementation uses existing dependencies, Stripe tier prices, tRPC/React Query, organization ledgers, and Storybook views.

## Workstreams

### 1. Persistence and domain contracts

Owner: database/domain workstream.

- Add immutable term versions, org agreements, term transitions, allocation plans and rows, processing runs, issuance snapshots, spend events, supplements, and audit records.
- Add constraints for nonnegative allocation, half-open windows, stable provider identities, and at most one non-ended agreement per parent.
- Add deterministic calculations for allocation, provider-anchored windows, paid-through eligibility, bridge periods, and round-half-up supplement proration.
- Generate and inspect one additive Drizzle migration. Do not mutate personal Kilo Pass tables.

Acceptance:

- Schema can represent every commercial state, processing condition, and Storybook state without overloading Stripe status.
- Domain tests cover short-month anchors, annual monthly windows, over-allocation, stale plans, and supplement rounding.

### 2. Agreement, allocation, and issuance engine

Owner: org-pass backend workstream.

- Seed/reuse standard immutable terms for `tier_19`, `tier_49`, and `tier_199` with the accepted concrete Storybook benefits.
- Implement initial agreement creation, allocation validation, paid activation, all-or-nothing base issuance, `upfront` co-grant, future allocation plans, cancellation, and paid-through transitions.
- Implement seat-capacity synchronization, parent-only current-window supplements, decrease/reincrease idempotency, and overallocated blocking.
- Grant pooled organization Credits through a dedicated ledger primitive with stable org-pass identities.
- Implement processing-run claim/retry semantics and original-window replay.

Acceptance:

- Paid activation issues exactly once to the resolved parent/direct-child distribution.
- A failed container grant rolls back the complete window.
- Current snapshots do not change when future allocations or terms change.
- Overallocated agreements block the whole next window and recover after explicit reconciliation.

### 3. Stripe and seat lifecycle integration

Owner: billing integration workstream.

- Add the selected tier price as a recurring item on the existing parent seat subscription, with matching quantity/cadence and agreement metadata.
- Persist pending agreement and initial allocations before provider mutation.
- Route org-pass invoices ahead of personal Kilo Pass classification and use recognized paid invoices, including zero-due invoices, for activation and paid-through advancement.
- Keep seat-line counting independent from the add-on item.
- Synchronize add-on quantity and internal capacity after successful seat changes.
- Suspend future processing for refund/dispute/chargeback review without clawing back granted Credits.

Acceptance:

- No org invoice can invoke personal Kilo Pass issuance.
- Replayed or out-of-order provider events cannot duplicate or regress agreement state.
- Seat and add-on items remain on one Stripe subscription and invoice.

### 4. Pooled spend and scheduling

Owner: usage/operations workstream.

- Record qualifying organization usage against the exact debited organization and active issuance snapshot.
- Advance spend and grant a threshold-crossing bonus atomically and once.
- Exclude grants, transfers, expirations, refunds, reversals, and administrative adjustments.
- Add an idempotent repair processor for missed evaluations and a scheduled agreement-window processor with durable blocked/failed runs.
- Preserve original windows during delayed processing and prevent later windows from bypassing unresolved earlier windows.

Acceptance:

- Concurrent threshold-crossing usage grants one bonus.
- Spend before a supplement does not satisfy its independent threshold.
- Expired locked bonuses are not made spendable by a late repair.

### 5. Typed API and production UI

Owner: web product workstream.

- Add an organization Kilo Pass tRPC router for summary, setup, agreement detail, checkout, activation, allocation updates, cancellation, and retry-safe status reads.
- Wire the organization subscription center and add setup, review/checkout, activation, and detail routes.
- Convert Storybook view actions from visual-only controls to typed callbacks with pending, error, stale-plan, and retry behavior.
- Preserve generic Credit language for regular members and keep all agreement mechanics behind parent billing authority.
- Add hierarchy guards to child detach/reparent/archive/delete mutation boundaries.

Acceptance:

- The production journey matches the Storybook available, setup, review, activation, active, cancellation, blocked, failed, and overallocated states.
- All links and controls perform real navigation or mutations.
- Forms expose labels, validation relationships, keyboard focus, and mobile layouts required by the design contract.

## Integration sequence

1. Land schema and pure calculations.
2. Build agreement/allocation/issuance transactions against the schema.
3. Add tRPC reads and mutations, then Stripe and seat event adapters.
4. Add canonical spend integration and scheduled repair/issuance entry points.
5. Wire production routes and existing Storybook views.
6. Add focused database, domain, router, Stripe, usage, hierarchy, and UI tests.
7. Run specialized reviews for data rollout, logic/concurrency, security, types/contracts, React/accessibility, and test quality; fix confirmed findings.

## Validation plan

### Automated

- Generate the Drizzle migration and inspect it for additive, non-destructive DDL.
- Run schema consistency and fresh bootstrap migration verification.
- Run focused org-pass domain, issuance, Stripe routing, router authorization, hierarchy, and pooled-spend tests.
- Run changed-package typechecks and lint, changed-file formatting, dependency-cycle check where relevant, and `git diff --check`.
- Run the broader web test suite after focused checks pass.

### Local end-to-end

- Start or reuse the worktree local stack using its reported port and migrated PostgreSQL database.
- Create a fresh fake parent-owner account and seed a parent organization, paid seats, and direct children through repository-supported local paths.
- Verify desktop and mobile-width journeys with browser automation:
  1. subscription-center availability;
  2. tier and initial allocation setup;
  3. review and pending payment;
  4. local paid-invoice activation and first pooled Credit issuance;
  5. future allocation edit and stale-write rejection;
  6. qualifying spend and exactly-once bonus unlock;
  7. seat increase supplement;
  8. seat decrease to overallocated, blocked issuance, reconciliation, and retry;
  9. cancellation through paid-through;
  10. member and child-owner access denial/generic Credit visibility.
- Inspect server logs and persisted rows after each critical transition. Capture screenshots of the main available, setup, active, and overallocated states.

### Completion gate

The feature is complete when the accepted ADR invariants are implemented at database and transaction boundaries, the production flow is usable without Storybook fixtures, focused and package-level checks pass, and the local browser journey proves activation, allocation, issuance, bonus, seat synchronization, recovery, and authorization behavior end to end.
