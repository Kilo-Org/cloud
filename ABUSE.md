# PR #3552 — Stripe Early Fraud Warning Persistence: Abuse / Threat-Model Review

Reviewer: automated abuse pass for human triage.
Branch: `pr-3552` (vs `main`).
Scope: persistence + spec only (PR1). PR2 will activate enforcement. Findings cover both what is shipped now AND foreseeable abuse against the design as currently specified.

## Executive Summary

The persistence layer is conservative and reasonable: cases are unique on Stripe EFW id, actions are unique on `(case_id, action_type, target_key)`, the `restrict` FK on actions prevents accidental case deletion losing audit, and the soft-delete only nulls the `kilo_user_id` link while retaining Stripe correlation IDs (`stripe_customer_id`, `stripe_charge_id`, `stripe_payment_intent_id`, `stripe_early_fraud_warning_id`) and the action ledger. That is the right baseline for repeat-offender detection across re-registrations.

However, the spec leaves multiple structural escape hatches that a sophisticated abuser can exploit, several of which need to be closed in PR2 design before enforcement is enabled. The most important ones are:

1. **Org-routing is a giant escape hatch.** Any payment routed through an organization Stripe customer falls into review-only with no automated containment, no automatic refund, no automated affiliate/referral reversal, and no KiloClaw suspension. A fraudster who can attach a stolen card to any org (their own throwaway org, or a trusted member's existing org) effectively bypasses every automated control. Spec rules 7, 8, 21, 25, 28, plus team spec rules 1–3.
2. **Pre-EFW window is fully exploitable.** EFWs typically arrive hours-to-days after the charge. Nothing in this spec or PR shortens the window for spending credits, spinning KiloClaw compute, collecting referrer/affiliate payouts, or running expensive model usage. PR2 must add a "first-payment hold" or velocity gate or accept that fraudsters speed-run consumption before EFW arrival.
3. **`unmatched`/`ambiguous` classifications are a deliberate downgrade path.** The spec elevates anything ambiguous to review-only. Adversaries can manufacture ambiguity (e.g., share a payment method across personal+org customers, switch primary owner, mutate metadata) to force review-only.
4. **Soft-delete after a fraud-block is a partial reset.** The current `softDeleteUser` overwrites `blocked_reason` to "soft-deleted at ..." and clears `blocked_at` and `blocked_by_kilo_user_id`. Spec rule 16 says enforcement MUST NOT overwrite an earlier independent block reason; soft-delete violates the spirit of that for retained-block users. Although `stripe_customer_id` is preserved on the user row and the EFW case retains correlation IDs, the user-row block signal is lost.
5. **Not all fraud signals survive soft-delete.** The EFW case retains `stripe_customer_id`, `stripe_charge_id`, `stripe_payment_intent_id`, `stripe_early_fraud_warning_id` (great), but does NOT store the payment-method fingerprint, dispute id, fraud_type, IP, or device fingerprint. Re-detection across re-registration needs Stripe API round-trips, which is slow and unreliable.
6. **No webhook signature contract in the spec.** Although PR1 ships no event handler, the spec does not state webhook signature verification or replay-window requirements. PR2 must require signed Stripe webhooks with a replay-protection clock skew bound and a webhook-secret rotation story; otherwise a forged `radar.early_fraud_warning.created` could be used as a *DoS* (forcing a refund/cancel) or buried among many to overwhelm review.
7. **Affiliate/referral clawback is not race-proof.** Impact SALEs that have already been paid out to the affiliate cannot be reversed without Impact's reverse-action API; the pre-PR window allows a fraudster to collect cashable referrer rewards or even self-affiliate kickbacks before EFW arrival.
8. **Team/Enterprise seat abuse is unaddressed.** A bad-actor admin can charge a stolen card, send invitations, distribute Composio credentials and credits across seats, and seat-consumed access stays alive because org cases are review-only. Already-issued invitations, Composio creds, and downloaded data have no automated revocation path.
9. **Composio credential propagation is invisible to the EFW path.** Per `.specs/kiloclaw-composio.md` (referenced but unchanged), creds are sharable and injected into agents — neither the EFW spec nor the action ledger contains a Composio revocation step.
10. **No tenant scoping / RLS** on the new tables. Any future admin/internal tool with a generic DB binding can read/write across cases. This is no worse than the rest of the schema, but the case payloads have higher fraud-leak sensitivity.

The remainder of this document expands each finding by category. Findings include both **already-merged-in-PR1** issues and **PR2-design-risk** issues (clearly labelled).

---

## Finding format

Each finding lists: scenario / where it applies / severity / mitigation. Severities are: `critical`, `high`, `medium`, `low`, `theoretical`. PR1 = persistence-only file/spec; PR2 = future enforcement design risk.

---

## 1. Account / Identity Laundering

### 1.1 [PR2 design] Multi-account fraud farms via personal customer rotation
- Scenario: Fraudster purchases stolen card BIN → spins up N personal accounts (different Google identities, IPs via residential proxies), each runs one or two purchases, consumes credits, then EFW arrives. Each account looks like one isolated victim. Spec rules 5–7 only correlate at the canonical-personal-owner level. There is no spec-level requirement to correlate cases across users sharing the same `payment_method.fingerprint` or BIN.
- Where: `.specs/stripe-early-fraud-warnings.md:43-46` (ownership resolution rules). Schema does not store payment-method fingerprint on the case (`packages/db/src/schema.ts:485-558`).
- Severity: high.
- Mitigation: Persist `stripe_payment_method_fingerprint` and `stripe_payment_method_id` on the case; add a fingerprint index. PR2 enforcement design must auto-block any *other* personal account that shares fingerprint with an enforced case (post-soft-delete too, since fingerprint survives).

### 1.2 [PR2 design] Org "review-only" laundering by attaching a stolen card to a throwaway org
- Scenario: Fraudster creates an organization (KiloClaw teams), attaches the stolen card as the org's payment method, runs fraudulent charges and consumes value through org-scoped credits/seats. EFW resolves to the org Stripe customer ⇒ classification `organization` ⇒ review-only. No automatic refund, no automatic credit clawback, no seat revocation, no affiliate/referral reversal.
- Where: `.specs/stripe-early-fraud-warnings.md:45-46` rule 7; `.specs/team-enterprise-seat-billing.md` "Early Fraud Warning Review Boundary" 1–3.
- Severity: critical.
- Mitigation: Revisit the bright line. At minimum, an org with (a) a single member who is also the creator, (b) age < N days, and (c) no successful prior payments should fall into the personal-enforcement path or a dedicated "small-org auto-enforce" path. Alternatively require that org cases trigger an automatic *containment-only* (block writes to that org's billing, freeze auto-top-up, freeze invitations) without doing destructive financial work, leaving full unwind to review.

### 1.3 [PR2 design] Switching personal ↔ org context after charge
- Scenario: User charges as a personal customer, transfers credits/instances to an organization (or vice versa), then EFW arrives. Ownership resolution at EFW time matches the *current* canonical owner; spec rule 6 requires "canonical stored payment-customer ownership" but does not pin to the time of *the warned charge*.
- Where: `.specs/stripe-early-fraud-warnings.md:43-46` rule 5–6.
- Severity: high.
- Mitigation: Resolve ownership against the customer that *owned the warned charge at the time of the charge*, not the current ownership. Persist a `stripe_customer_id_at_charge_time` on the case explicitly.

### 1.4 [PR2 design] Teammate-card abuse / shared PaymentMethod
- Scenario: An admin in an org adds another member's card. EFW maps to the cardholder's customer; if that customer also exists as a personal Kilo customer, the spec calls this `ambiguous` ⇒ review-only. Fraudster can deliberately attach the card to a second customer to manufacture ambiguity.
- Where: `.specs/stripe-early-fraud-warnings.md:23-24`, `45-46`.
- Severity: high.
- Mitigation: Require that *any* canonical personal owner with a non-disputed `stripe_customer_id` matching the card's customer is enforced, while still flagging org review separately. Alternatively use payment-method fingerprint as the primary correlation key, not customer id alone.

### 1.5 [PR1] EFW case has no link to the specific payment_method row
- Scenario: When investigating, reviewers cannot pivot from a case to the specific `payment_methods` row used (only via Stripe API). This makes mass abuse pattern-matching slower in incidents.
- Where: `packages/db/src/schema.ts:485-558` — case stores `stripe_customer_id` but no `stripe_payment_method_id` or `stripe_fingerprint`.
- Severity: medium.
- Mitigation: Add `stripe_payment_method_id` (text), `stripe_payment_method_fingerprint` (text, indexed) columns to the case (and a backfill SQL appended after the generated DDL, per AGENTS.md migration rules).

---

## 2. Personal-only vs Organization-only Enforcement

### 2.1 [PR2 design] Org-routing as the universal bypass
- Scenario: Same as 1.2. Worth re-listing in this category: fraudsters preferentially route every charge through an org because the spec promises ZERO automatic destructive actions on org-owned EFWs. Even containment is review-only (rules 7, 21, 25 + team spec 2).
- Where: `.specs/stripe-early-fraud-warnings.md:45-46`, 67-68; `.specs/team-enterprise-seat-billing.md` review boundary section.
- Severity: critical.
- Mitigation: As 1.2; also explicitly add a non-destructive auto-containment for org cases (freeze auto-top-up, block new seats, block new invitations, freeze KiloClaw provisioning) until reviewed. This is consistent with spec rule 7 "MUST NOT automatically block a person, refund, reverse value, cancel billing, or suspend compute" if framed as *organization-level access freeze*. Confirm with product/legal whether a "soft freeze" of an org pending review is acceptable.

### 2.2 [PR2 design] Convert personal subscription to org subscription post-charge to dodge enforcement
- Scenario: Fraudster pays personally, then uses an admin/migration tool to move the subscription to an org they create, before EFW arrives. EFW now maps to the org customer (or becomes ambiguous) ⇒ review-only.
- Where: spec rules 5–6.
- Severity: high.
- Mitigation: Pin enforcement classification to the customer at *charge time* (1.3), AND deny customer/owner migration on subscriptions whose latest payment is younger than the EFW window (Stripe quotes ~120 days; practically the high-risk window is the first 14 days).

### 2.3 [PR2 design] Composio credential propagation across org seats
- Scenario: Fraudster (admin of org) charges stolen card, distributes Composio creds across seats (per `.specs/kiloclaw-composio.md`). EFW arrives, org case is review-only. No action type in the action ledger covers `composio_credential_revocation`.
- Where: `packages/db/src/schema.ts:563-628` action_type enum (no Composio entry); `.specs/stripe-early-fraud-warnings.md:50-52` rule 11 enumerates required ops without Composio.
- Severity: high.
- Mitigation: Add `composio_credential_revocation` action_type to the enum and to spec rule 11. Ensure org review path can trigger Composio revocation as part of remediation. Update the migration accordingly (regenerate via `pnpm drizzle generate`).

### 2.4 [PR2 design] Affiliate / referral payouts on org payments
- Scenario: Org spec 2 says "MUST NOT automatically reduce seat access, refund, …". The affiliate/referral changes (impact-affiliate-tracking.md update, impact-referrals.md update) only call out *enforced EFW refund* as adverse — and enforced EFWs are only personal. So an org-routed fraudulent payment will *not* trigger affiliate SALE reversal or referral cancellation until/unless a manual reviewer triggers a refund.
- Where: `.specs/impact-affiliate-tracking.md` rules 28–31 (only adverse "enforced EFW refund"); `.specs/impact-referrals.md` rules 159–163 (only "enforced EFW refund").
- Severity: high.
- Mitigation: For org cases reaching review and being reviewed-as-fraud, the manual refund decision MUST also queue affiliate SALE reversal and referral reward cancellation idempotently. Spec this explicitly. PR2 should add a manual-disposition path that dispatches the same action_types.

---

## 3. Soft-delete / GDPR linkage

### 3.1 [PR1] Soft-delete clears `blocked_reason` and `blocked_at` on a fraud-blocked user
- Scenario: User is fraud-blocked (block reason set by EFW enforcement), then GDPR-soft-deletes themselves. `softDeleteUser` overwrites `blocked_reason: 'soft-deleted at ...'` and sets `blocked_at: null`. The fact that they were *fraud-blocked specifically* is no longer obvious from the user row. Repeat-detection now depends entirely on (a) `stripe_customer_id` lookup, (b) signup_ip/email tombstones, (c) stytch_fingerprints. None of those are checked at signup time today by default.
- Where: `apps/web/src/lib/user/index.ts:899-925` (fields nulled), spec rule 16 forbids overwriting an earlier block reason.
- Severity: high.
- Mitigation: Either (a) preserve `blocked_reason` if it currently indicates fraud-enforcement, prefixing with "fraud-enforced; soft-deleted at ..."; or (b) maintain a separate `kilocode_users.fraud_block_at` timestamp column that is *not* cleared on soft-delete. Add a regression test in `apps/web/src/lib/user/index.test.ts`.

### 3.2 [PR1] Repeat-offender fingerprint coverage gap on the case row
- Scenario: After a user soft-deletes themselves, the EFW case still retains `stripe_customer_id`, `stripe_charge_id`, `stripe_payment_intent_id`, `stripe_early_fraud_warning_id` (good), but lacks **payment-method fingerprint, IP at signup, IP at charge, fraud_type, dispute_id (when later disputed), originating user agent / device fingerprint**. Re-detection on re-signup using *new* email and *new* card is impossible without these.
- Where: `packages/db/src/schema.ts:485-558`. Spec rule 13 forbids storing raw Stripe payloads but does NOT forbid storing safe fingerprints; rule 10 lists "safe payment correlation identifiers" as required.
- Severity: high.
- Mitigation: Add at least: `stripe_payment_method_fingerprint`, `stripe_dispute_id` (later), `fraud_type` (text — Stripe gives `fraudulent` / `card_never_received` / `unauthorized_use_of_card` / etc; safe non-PII), `signup_ip_inet` (or hash), `charge_ip_inet` (or hash). Hash if PII concerns.

### 3.3 [PR1] `kilo_user_id` ON DELETE set null with no separate "user_was" preservation
- Scenario: When the user row is *hard-deleted* (not soft-deleted), the FK rule sets `kilo_user_id` to null. There is no preserved breadcrumb for "this case was associated with USER:abc123" on the case row itself. Soft-delete also nulls explicitly. After deletion, the only link to the user is via `stripe_customer_id` ↔ kilocode_users.stripe_customer_id (preserved through soft-delete) — but if the user was hard-deleted, even that fades.
- Where: `packages/db/src/schema.ts:500-503` (`onDelete: 'set null'`); `apps/web/src/lib/user/index.ts:1263-1266` explicit null update.
- Severity: medium (today users are soft-deleted, not hard-deleted in normal flow; but defense-in-depth wants this).
- Mitigation: Add a `kilo_user_id_at_warning` text column (no FK) that is set when the case is created and is NEVER nulled. This is non-PII because it's just an opaque ID; it lets repeat-offender pivots survive any future hard-delete or migration.

### 3.4 [PR1] Soft-delete does not remove the user from the deleted_user_email_tombstones bypass class for fraudster
- Scenario: A fraudster soft-deletes themselves immediately after being EFW-enforced (or after being detected). The email tombstone hash prevents re-using *same* email to qualify as a "referee" but DOES NOT prevent re-signup with a *different* email. Combined with 3.1, fraudster can re-register with a fresh google account and a fresh card.
- Where: `apps/web/src/lib/user/index.ts:894-897`; tombstone schema `packages/db/src/schema.ts:635-638`.
- Severity: medium (existing system limitation, but EFW expands the attack surface that benefits from re-registration).
- Mitigation: Add a "fraud blocklist" lookup on signup keyed on (a) payment-method fingerprint when first card attached, (b) IP /24 within rolling window, (c) device fingerprint (already collected in stytch_fingerprints). Out of scope of this PR, but PR2 should require it.

### 3.5 [PR1] No FK from action ledger to kilocode_users (good — but means cascade of fraud user data is incomplete)
- Scenario: `result_reference_id` may store Stripe object IDs (`re_...`, `ch_...`); these are non-PII. Action rows survive soft-delete with no scrubbing — correct. But `failure_context` is a free-text column. If implementation writes user input or webhook payload bits into it, PII may leak.
- Where: `packages/db/src/schema.ts:589-590` (`failure_context: text()`); spec rule 13 says "non-sensitive failure context".
- Severity: medium.
- Mitigation: PR2 implementation must enforce a strict allow-list/redaction for `failure_context` writes (e.g., only result codes, no raw response body). Add a code-level check or wrapper. Also consider a `length(failure_context) <= 4096` CHECK constraint to bound abuse and accidental leaks.

---

## 4. Race conditions & timing

### 4.1 [PR2 design] Speed-run credit consumption before EFW arrives
- Scenario: EFW typically arrives 12h–7d after charge. A fraudster, knowing this, immediately consumes purchased credits on max-cost models or runs many KiloClaw instances. By EFW arrival, attributable value is consumed; spec rule 19 explicitly allows the resulting balance to be negative ("the resulting auditable balance MAY be negative") which is the right unwinding rule but provides no *cost* recovery.
- Where: `.specs/stripe-early-fraud-warnings.md:62-65` rule 19; rule 20 ("regardless of charge amount").
- Severity: high (financial blast radius scales with model spend).
- Mitigation: PR2 design must add velocity gates BEFORE EFW arrival — e.g., per-day cap on credit consumption for accounts with first-payment-age < 7 days, or a held portion of credits unlocked on age. This is product policy more than a spec rule, but the spec should reference and require such a policy.

### 4.2 [PR2 design] Race between EFW arrival and KiloClaw instance creation
- Scenario: EFW arrives mid-provision. Spec rule 22 says renewal MUST be canceled and compute MUST be suspended "promptly", but there is no contract on (a) what happens to in-flight provisioning, (b) what happens to instances created in the interval *after* containment claim is set but *before* the kiloclaw_suspension action runs.
- Where: `.specs/stripe-early-fraud-warnings.md:67-70` rules 21–24.
- Severity: medium.
- Mitigation: Spec must define: once containment is durable, the user's auto-top-up MUST be disabled (already in rule 16) AND new KiloClaw provisioning MUST refuse for the contained user (add a check in the provisioning path that consults the `users.blocked_at`/`blocked_reason` or a separate `efw_contained_at`).

### 4.3 [PR2 design] Race between refund and dispute_created
- Scenario: EFW arrives → enforcement issues refund → simultaneously, the issuer creates a dispute (chargeback). Stripe will post both events. Without idempotency keyed on the *charge*, the system might (a) attempt double refund, (b) double-fire affiliate SALE reversals (one from EFW path, one from dispute path), (c) double-cancel referral rewards.
- Where: `.specs/stripe-early-fraud-warnings.md:50-53` rule 12 ("converge under … later related Stripe events"); `.specs/impact-affiliate-tracking.md` rule 33; `.specs/impact-referrals.md` rule 163. These rules are stated but the persistence-layer enforcement is "case unique on EFW id" + "action unique on (case, type, target_key)". Cross-event dedup (EFW + dispute) is NOT in schema today.
- Severity: high.
- Mitigation: PR2 must dedupe across systems by `target_key = "charge:" + ch_id` for `affiliate_payout_reversal` and `referral_reward_reversal`, and require dispute handler to look for an existing reversal action with the same target_key before re-firing. Make this explicit in the spec: cross-event dedup is keyed on the underlying charge, not the EFW vs dispute event id.

### 4.4 [PR1] `processing_started_at` then `contained_at` ordering not constrained
- Scenario: Spec rule 15: "the system MUST durably claim the case before initiating destructive work". Schema has both `contained_at` and `processing_started_at` columns but no CHECK that `contained_at <= processing_started_at` or that one MUST be set before status transitions to `processing`/`contained`.
- Where: `packages/db/src/schema.ts:515-516`.
- Severity: low.
- Mitigation: Add CHECK constraints on status transitions, e.g. "status='contained' implies contained_at IS NOT NULL", "status='processing' implies processing_started_at IS NOT NULL". These could be partial CHECKs or enforced in app code; CHECKs are stronger.

### 4.5 [PR2 design] Concurrent worker double-claim of the same action
- Scenario: Two workers query the claim-path index, both pick up the same row in `queued`. The unique on `(case_id, action_type, target_key)` does not help because the row already exists; what's needed is `UPDATE ... WHERE status='queued' RETURNING` or a `claimed_at` race with `SELECT ... FOR UPDATE SKIP LOCKED`.
- Where: `packages/db/src/schema.ts:604-609`. The `claim_path` index is built but the locking story is not in the spec.
- Severity: medium (PR2 implementation concern).
- Mitigation: Spec MUST require an atomic claim with `FOR UPDATE SKIP LOCKED` or compare-and-swap on `status` from `queued` → `processing` keyed by `id`. Document in the spec; the schema is fine.

### 4.6 [PR2 design] Off-switch flip flop window
- Scenario: Operator toggles the kill switch off then on. EFWs received during the off window are queued as `review_required` (rule 30). When operator toggles back on, do those queued reviews auto-process, or remain review-only? Spec is silent.
- Where: `.specs/stripe-early-fraud-warnings.md:80-86` rules 29–33.
- Severity: medium.
- Mitigation: Spec must state that cases marked review_required during off-state remain review_required even after re-enable; new EFWs processed as normal. (This is the safe default; just make it explicit.)

---

## 5. Idempotency / duplicate handling

### 5.1 [PR1] Strong idempotency on EFW id; weak idempotency across charge
- Scenario: Two distinct EFWs for the same charge are theoretically possible (Stripe could re-issue), and a chargeback after EFW for the same charge. Each gets its own EFW id ⇒ each gets its own case row ⇒ duplicate work unless action `target_key` carries the charge id. The schema design encourages this (the unique is on `(case_id, action_type, target_key)` — case_id varies, so two cases can both refund the same charge).
- Where: `packages/db/src/schema.ts:598-602`.
- Severity: high.
- Mitigation: For action types that have *charge-level* effects (refund, payment_value_clawback, affiliate_payout_reversal, referral_reward_reversal, subscription_termination), idempotency MUST also be enforced by a *cross-case* lookup keyed on `target_key`. Either (a) a partial unique index `UNIQUE (action_type, target_key) WHERE action_type IN ('refund', 'payment_value_clawback', 'affiliate_payout_reversal', 'referral_reward_reversal')`, or (b) require the worker to consult prior actions across cases before claiming. (a) is stronger.

### 5.2 [PR1] No unique on `stripe_event_id`
- Scenario: Stripe webhook delivery retries deliver the same `evt_xxx` multiple times. The migration only uniques on `stripe_early_fraud_warning_id`, not on `stripe_event_id`. Two simultaneous webhook deliveries could attempt to insert two cases for the same EFW; one wins via the unique on EFW id, the other gets a unique-violation. That's correct, but a duplicate `evt_xxx` for *different* EFW ids (shouldn't happen, but defense in depth) would not be deduped.
- Where: `packages/db/src/migrations/0145_awesome_wild_child.sql:49`.
- Severity: low.
- Mitigation: Add a unique index on `stripe_event_id`. Worst case if Stripe re-sends a multi-EFW event we fail one insert and re-process the other — that's safe.

### 5.3 [PR1] `target_key` is opaque text — no normalization rule
- Scenario: Two callers writing different `target_key` strings for the same logical target (e.g. `charge:ch_X` vs `ch_X` vs `stripe_charge:ch_X`) bypass the unique. This is an implementation discipline issue.
- Where: `packages/db/src/schema.ts:577`.
- Severity: medium.
- Mitigation: Spec a canonical `target_key` format per action_type (e.g., `charge:<ch_id>` for refund, `subscription:<sub_id>` for termination, etc.). Optionally add a CHECK constraint per action_type with a regex.

### 5.4 [PR1] `failure_context` cardinality / unbounded text
- Scenario: Repeated retries can accumulate failure_context if implementation appends rather than replaces. No length CHECK; could be abused if implementation echoes external input.
- Where: `packages/db/src/schema.ts:590`.
- Severity: low.
- Mitigation: Cap length in CHECK. Spec must say "latest failure context only, replaced not appended".

### 5.5 [PR1] Unique key only on `case_id, action_type, target_key`, not on retry-set
- Scenario: An action that fails terminally (status='failed') and is then re-queued by an operator wanting to retry — there's no clean "create new attempt" because the unique is exact-tuple. Operator must mutate the same row.
- Where: schema unique tuple.
- Severity: low (probably intended).
- Mitigation: Document in spec that retries reuse the same row.

---

## 6. Webhook spoofing

### 6.1 [PR2 design] No mention of signature verification or replay window in the spec
- Scenario: PR1 ships no event handler, so the gap is technically future. But spec rules 1–4 talk about "newly received `radar.early_fraud_warning.created` events" without saying signature verification is required.
- Where: `.specs/stripe-early-fraud-warnings.md:34-39`.
- Severity: high (must be closed in PR2; reviewers should require it now).
- Mitigation: Add a spec rule: "EFW ingestion MUST verify the Stripe webhook signature with the active webhook secret AND reject events whose signature timestamp is older than a 5-minute skew window. The system MUST persist the verified `stripe_event_id` and reject duplicates by that id."

### 6.2 [PR2 design] Replay attack as DoS or as denial of legitimate charges
- Scenario: An attacker who obtains the webhook URL but not the secret cannot post valid events; but a former employee with the secret could replay old events, or a man-in-the-middle could replay fresh ones. Without a replay-protection guard (`stripe_event_id` dedup + signature timestamp window), an attacker can spam the endpoint causing CPU and DB load even if all are rejected.
- Where: same as 6.1.
- Severity: medium.
- Mitigation: As 6.1 plus rate-limit the endpoint and reject events whose signature timestamp is older than 5 minutes; add tests for replay rejection.

### 6.3 [PR2 design] Webhook secret rotation
- Scenario: After secret rotation, in-flight events signed by the old secret will be rejected. With EFW being destructive, missing one is bad. Spec is silent on rotation.
- Where: `.specs/stripe-early-fraud-warnings.md`.
- Severity: low.
- Mitigation: Spec dual-secret support during rotation.

---

## 7. Referral / Affiliate Exploitation

### 7.1 [PR2 design] Affiliate commission collected before EFW
- Scenario: Fraudster signs up via own affiliate link (or a partner), buys $100 of credit, Impact reports the SALE, affiliate is paid out (Impact terms can pay out within hours/days for some advertisers). EFW arrives later → spec requires SALE reversal (rules 28–33 of the affiliate spec, updated). However, Impact's reverse-action mechanism has a finite window; if exceeded, money is gone.
- Where: `.specs/impact-affiliate-tracking.md` updated rules 28–31.
- Severity: high.
- Mitigation: Spec a *hold period* for affiliate SALE submission (don't submit the SALE until N days post-charge) for high-risk attribution patterns. Or, accept loss and instrument metrics. PR2 must monitor and flag SALEs that pass Impact's reverse-action window.

### 7.2 [PR2 design] Self-referral via Impact Advocate
- Scenario: Fraudster signs up account A, buys credits with stolen card; account A's referral code is used by account B (controlled by same fraudster) — referral reward is applied. EFW arrives on A. Spec rule 27 says "pending or earned-but-unapplied … MUST be canceled; already-applied … MUST be routed to review". Already-applied rewards may have been spent.
- Where: `.specs/stripe-early-fraud-warnings.md:73-78` rule 27; `.specs/impact-referrals.md` updated rules 159–161.
- Severity: high.
- Mitigation: Implementation must claw back applied rewards retroactively if account B is fraud-linked (e.g., shares fingerprint with A), even if review-required prevents automatic clawback. Spec a reviewer-driven mass clawback path.

### 7.3 [PR2 design] Reversal identity gap
- Scenario: Affiliate spec rule 32 says reversals are required only when reversal identity exists; gaps must be operationally observable for non-automated follow-up. Adversarially: a fraudster who can manipulate attribution (e.g., using stale cookies, partial signups) might land in a gap class where reversal identity is missing → reviewer must manually act → time pressure, easy to miss.
- Where: `.specs/impact-affiliate-tracking.md` rule 32.
- Severity: medium.
- Mitigation: PR2 enforcement should generate a `review_required` action whenever reversal identity is missing, surfacing the gap clearly via the case dashboard.

### 7.4 [PR2 design] Adverse-payment reversal does not extend to org cases
- Scenario: Adverse SALE reversal in the affiliate spec only covers "personal KiloClaw SALE events and eligible Kilo Pass SALE events". Org seat purchases ⇒ spec covers seat billing for orgs but the EFW spec defers to manual review; the affiliate path may have already paid out.
- Where: `.specs/impact-affiliate-tracking.md:28-31` (note "personal KiloClaw SALE events"); `.specs/team-enterprise-seat-billing.md` review boundary.
- Severity: medium.
- Mitigation: Either confirm orgs cannot be referral-eligible (then call this out explicitly) or add a manual reviewer-driven affiliate reversal path for org cases.

---

## 8. Team / Enterprise seat abuse

### 8.1 [PR2 design] Mass seat purchase + invitation → org review-only
- Scenario: Bad-actor admin creates org, charges stolen card for many seats, sends invitations broadcasting Composio creds and free credits. EFW arrives → org case → review-only. Invitations may have been accepted; data created; outbound emails sent.
- Where: `.specs/team-enterprise-seat-billing.md` review boundary 1–3.
- Severity: high.
- Mitigation: Add an automatic non-destructive *org freeze*: pause new invitations, pause new KiloClaw provisioning, pause Composio injection, pause auto-top-up, leaving existing seats running until reviewer decides. This is a softer line than rule 7's "MUST NOT … cancel billing" and seems consistent.

### 8.2 [PR2 design] Pending invitations after EFW
- Scenario: Invitation links sent to non-members are external; once the email goes out, the link is valid until accepted/expired. EFW does not auto-revoke invitations. Even if reviewer later manually freezes, the invitations may convert.
- Where: `.specs/team-enterprise-seat-billing.md`; no action_type in the EFW action ledger covers invitation revocation.
- Severity: medium.
- Mitigation: Add an action_type `organization_invitation_revocation` (or include under `access_termination`); explicitly freeze unaccepted invitations on org review intake.

### 8.3 [PR2 design] Seat billing partial month cancellation
- Scenario: Org cancellation logic typically prorates. If the spec eventually allows org cases to refund, partial-month seat counts and data could be inconsistent. Today fully out of scope (review-only).
- Severity: low.
- Mitigation: Specify when org refunds occur in remediation — full refund or prorated.

---

## 9. KiloClaw credit / instance abuse

### 9.1 [PR2 design] Pre-EFW compute speed run
- Scenario: Spin up max instances at max size, run heavy compute (model usage paid via credits) — EFW spec rule 19 says only attributable value reversal (auditable balance may go negative). Compute cost is real money. Blast radius scales with throughput.
- Where: `.specs/stripe-early-fraud-warnings.md:62-65`.
- Severity: high.
- Mitigation: Add velocity caps on day-1 / week-1 spend per personal user; require Stytch novel-card-with-hold validation before high-spend mode (already a column on users — `has_validation_novel_card_with_hold`).

### 9.2 [PR2 design] Seven-day grace exploitable for data exfiltration
- Scenario: Spec rule 23: "fresh seven-day destruction grace after suspension and MUST NOT immediately destroy stored instance data". Compute is stopped (rule 22), but stored instance data is retained. If a fraudster has remote access to the storage (e.g., via leaked SSH keys, prior export, or bot tooling), they can still exfiltrate during the grace window.
- Where: `.specs/stripe-early-fraud-warnings.md:67-70` rule 23.
- Severity: medium.
- Mitigation: Confirm "compute suspended" includes blocking SSH/exec/network ingress to the instance; only block-storage retention. Spec this. (The intent is probably correct; make it explicit so PR2 implementation doesn't accidentally leave the door open.)

### 9.3 [PR2 design] In-flight model requests at suspension
- Scenario: Race between suspend and an active request. Without a kill mechanism, an in-flight $$$ inference still completes.
- Where: implicit; spec rule 22 says "promptly".
- Severity: low.
- Mitigation: Spec a hard cutoff (e.g., suspend includes terminating active model requests).

---

## 10. Notices & disclosure

### 10.1 [PR1] Spec rule 28 forbids disclosure — good, but need to verify implementation
- Scenario: Spec rule 28 explicitly forbids disclosing EFW, fraud-scoring detail, card detail, or abuse-service info. This is correct anti-tipping-off practice.
- Where: `.specs/stripe-early-fraud-warnings.md:73-78` rule 28.
- Severity: n/a (positive finding).
- Mitigation: PR2 code review must verify the actual notice template matches.

### 10.2 [PR2 design] Side-channel disclosure via support
- Scenario: User contacts support, support reads notes that reference the EFW / case ID / fraud signal. Support agent inadvertently confirms reason. Standard human-process risk.
- Severity: low.
- Mitigation: Add a "support communication script" guideline; do not surface fraud-specific reasons in admin notes that are user-facing.

### 10.3 [PR1] `reason` column is free-text on the case
- Scenario: `reason` stored on the case (`packages/db/src/schema.ts:512`) — used to record operational reason. If reason text is exposed to user (e.g., via an error message that leaks server-side reason), it could disclose fraud signals.
- Where: schema and any future user-facing code path.
- Severity: low (PR2 risk).
- Mitigation: Spec that `reason` is enum-like / from a closed list; never user-facing. PR2 must keep it server-only.

---

## 11. Manual review queue

### 11.1 [PR2 design] Reviewer flooding / noise
- Scenario: Adversary triggers many low-value EFWs (e.g., $1 charges) intentionally to fill the review queue, hiding a real fraud event among noise.
- Where: spec rule 20 ("regardless of charge amount").
- Severity: medium.
- Mitigation: Risk-rank review queue by amount, customer age, prior-EFW-history. PR2 dashboard should support filters.

### 11.2 [PR2 design] Social engineering reviewers via support
- Scenario: User in `review_required` state contacts support with fabricated story to push reviewer toward `remediated` state. Spec rule 32 requires "audited admin/support remediation decision" — good.
- Where: `.specs/stripe-early-fraud-warnings.md:80-86` rule 32.
- Severity: medium.
- Mitigation: Add reviewer training materials; require remediation decisions to capture the rationale text in the case (separate column suggested: `remediation_decision_actor_id`, `remediation_decision_rationale`).

### 11.3 [PR1] Schema lacks remediation actor / rationale columns
- Scenario: When a case transitions to `remediated`, the schema records `remediated_at` only. There is no actor user id, no rationale, no decision-timestamp linkage to an admin audit log.
- Where: `packages/db/src/schema.ts:519-520`.
- Severity: medium.
- Mitigation: Add `remediated_by_kilo_user_id` (text, FK to kilocode_users with set null on delete), `remediation_rationale` (text). Or, link to an `admin_audit_log_id` / `kiloclaw_admin_audit_log_id` UUID.

---

## 12. Deletion of audit history

### 12.1 [PR1] Soft-delete chain is not retained on the case row
- Scenario: A user is fraud-flagged, then GDPR-soft-deletes themselves; the case `kilo_user_id` is nulled. If the same user later re-registers (different google account, same payment method or device fingerprint), the existing case is still discoverable by `stripe_customer_id`/`stripe_charge_id` *if* the fraudster reuses the same Stripe customer (they won't — different google account ⇒ different customer). Effective re-detection requires fingerprint/IP.
- Where: `apps/web/src/lib/user/index.ts:1263-1266`. See 1.1, 3.2.
- Severity: high (the persistence model nominally retains history but the practical re-detection signal is weak).
- Mitigation: As 3.2 — add fingerprint-level columns and indexed lookup at signup.

### 12.2 [PR1] Hard-delete escape hatch
- Scenario: If anyone ever invokes `DELETE FROM kilocode_users WHERE id = ...` directly (not through `softDeleteUser`), the FK `set null` cascades and the case effectively detaches from the user. The `restrict` on actions FK protects the action ledger, but the case row's owner link is gone.
- Where: `packages/db/src/schema.ts:500-503`.
- Severity: medium.
- Mitigation: Add `kilo_user_id_at_warning` text column never nulled (3.3). Consider also flipping to `ON DELETE RESTRICT` on the user FK so that hard-delete is forced through `softDeleteUser`.

### 12.3 [PR1] Action `failure_context` deletion / mutation
- Scenario: Operators with DB-write permission could mutate the action ledger, e.g., flip a `failed` to `dismissed` and bypass real action. There is no append-only enforcement at DB level (no row-version, no audit trigger).
- Where: schema.
- Severity: low (insider threat).
- Mitigation: Out of scope for this PR; PR2 should use postgres triggers or admin audit logging when actions transition.

---

## 13. Edge cases in schema

### 13.1 [PR1] Multiple nullable columns with no XOR enforcement
- Scenario: Case row's `kilo_user_id` and `organization_id` are both nullable. For `owner_classification = 'personal'`, `kilo_user_id` SHOULD be set; for `'organization'`, `organization_id` SHOULD be set. There is no CHECK enforcing this.
- Where: `packages/db/src/schema.ts:499-507`.
- Severity: medium.
- Mitigation: Add CHECK constraints:
  - `(owner_classification != 'personal') OR (kilo_user_id IS NOT NULL OR status IN ('review_required', 'failed', 'dismissed'))` — careful, soft-delete null-out conflicts; perhaps only at insert.
  - `(owner_classification != 'organization') OR (organization_id IS NOT NULL OR status IN (...))`
  - `(owner_classification IN ('ambiguous','unmatched')) IMPLIES (kilo_user_id IS NULL AND organization_id IS NULL)` — questionable, but worth thinking through.
  - At minimum, document and test.

### 13.2 [PR1] `amount_minor_units` is `integer` (32-bit)
- Scenario: `integer` max is ~2.1B minor units. For USD that's $21,474,836.47 which is fine. For very low-value currencies (Vietnamese dong, Indonesian rupiah, etc.) per minor unit, this is approximately equivalent. Probably fine for EFW (Stripe limits per-charge), but worth flagging.
- Where: `packages/db/src/schema.ts:497`.
- Severity: theoretical.
- Mitigation: Use `bigint`. Cheap insurance. Other money columns in the schema use bigint (microdollars).

### 13.3 [PR1] `currency` is unconstrained text
- Scenario: No CHECK on length / shape, no normalization. Case-mismatch (`USD` vs `usd`) makes querying brittle. If implementation gets wrong-cased, downstream comparisons fail.
- Where: `packages/db/src/schema.ts:498`.
- Severity: low.
- Mitigation: Add CHECK `currency IS NULL OR (length(currency) = 3 AND currency = lower(currency))`.

### 13.4 [PR1] No CHECK on `stripe_early_fraud_warning_id` / `stripe_event_id` shape
- Scenario: An attacker who can inject rows (e.g., admin bug, or a bug in the webhook handler) could insert non-Stripe-shaped IDs. Stripe IDs follow `<prefix>_<base62>`. Not a security boundary by itself but reduces accidental footguns.
- Where: schema.
- Severity: low.
- Mitigation: Light regex CHECKs.

### 13.5 [PR1] `status='dismissed'` with `dismissed_at IS NULL` is not enforced
- Scenario: Status enum allows `dismissed`/`review_required`/`remediated` etc but no CHECK ties them to the corresponding `*_at` timestamp columns.
- Where: schema.
- Severity: low.
- Mitigation: Add CHECKs `status='dismissed' IMPLIES dismissed_at IS NOT NULL` etc.

### 13.6 [PR1] No tenant scoping / RLS on the new tables
- Scenario: Any future admin tool with generic DB access reads all cases. Org-scoped reviewers could see personal case detail.
- Where: schema (no RLS).
- Severity: medium (matches existing schema posture).
- Mitigation: Spec a "fraud reviewer" role boundary in the app layer; document the lack of DB-level RLS as accepted risk.

### 13.7 [PR1] Action `attempt_count` has no max CHECK
- Scenario: A bug or attacker (insider) could increment forever. Not a security primitive but operational risk.
- Where: schema.
- Severity: low.
- Mitigation: Add an upper bound CHECK or rely on app-side cap; spec the cap.

---

## 14. Dual-write / out-of-band data

### 14.1 [PR2 design] No requirement that EFW path is the *only* writer to cases/actions
- Scenario: An admin tool, a one-off SQL migration, or another webhook handler could insert/mutate rows directly, skipping spec invariants.
- Where: spec rule 12 says converge on retries but does not say "writes must originate only via the EFW ingestion / worker path".
- Severity: medium.
- Mitigation: Spec a "single-writer" rule for `cases` and `actions` (only the EFW orchestrator and approved admin remediation flows may write). Consider a postgres role separation.

### 14.2 [PR2 design] Manual refunds outside the EFW path bypass affiliate / referral reversal
- Scenario: A support agent issues a manual Stripe refund on a charge that *would have* been EFW-enforced (perhaps before EFW arrives). The affiliate spec only treats *enforced EFW refunds* as adverse; a manual support refund is not adverse for affiliate purposes.
- Where: `.specs/impact-affiliate-tracking.md` rule 28 ("enforced Stripe Early Fraud Warning handling").
- Severity: medium.
- Mitigation: Either broaden adverse classification to any fraud-tagged refund regardless of source, or constrain support refund tooling to require classifying the reason (fraud vs goodwill) and feed fraud-tagged refunds into the same reversal pipeline.

### 14.3 [PR2 design] Stripe dashboard manual refund
- Scenario: An operator refunds a charge directly in the Stripe dashboard (not via the app). EFW arrives later, action ledger creates a refund action for the same charge — Stripe will return "already refunded". Idempotency should converge, but action ledger may flag failed unless implementation handles this well.
- Where: spec rule 18.
- Severity: low.
- Mitigation: Implementation note: refund action must treat "already refunded for this amount" as success.

---

## 15. Currency / amount manipulation

### 15.1 [PR2 design] Micro-charge card testing
- Scenario: Card-testers run $0.50/$1.00 charges. EFWs may follow. Each generates a case and full action workload (containment, refund, notice). Spec rule 20 says "regardless of charge amount" — correct from a fairness standpoint, but means the system pays for every micro-EFW with full processing.
- Where: `.specs/stripe-early-fraud-warnings.md:62-65` rule 20.
- Severity: low (operational cost).
- Mitigation: Pre-charge protections (Stripe Radar, card-testing limits). Out of scope of this PR.

### 15.2 [PR2 design] Refund amount drift
- Scenario: Spec rule 18 says refund only the *remaining refundable amount* of the warned charge. If a partial refund was already issued (legit goodwill), enforcement refunds the rest — correct. But the action_type and target_key are `refund` + `charge:<id>`; subsequent partial events on same charge do NOT generate distinct actions. If implementation reads the desired amount from Stripe at action time (correct) it converges. If from a stale snapshot, could over-refund (impossible if Stripe enforces) or under-refund.
- Where: spec rule 18; implementation in PR2.
- Severity: low.
- Mitigation: Implementation note: refund amount must be computed at action execution time from live Stripe state.

### 15.3 [PR1] No currency-mismatch detection
- Scenario: Case stores `amount_minor_units` and `currency`. If mismatched, downstream value-reversal could over/undercredit.
- Where: schema.
- Severity: low.
- Mitigation: Implementation must validate currency matches charge currency before persisting.

### 15.4 [PR2 design] FX on attributable-value reversal
- Scenario: Charge in EUR; credits issued and consumed (denominated in microdollars). FX changes between charge and reversal. Spec rule 19 says "attributable value … the resulting auditable balance MAY be negative" — accepts that reversal is in *credit* terms, not currency terms. OK for personal accounts; less obvious for large orgs (out of scope).
- Where: spec rule 19.
- Severity: low.
- Mitigation: Document the policy clearly to support; reviewers should know reversal is in credits, not currency.

---

## 16. PII redaction

### 16.1 [PR1] Case columns are non-PII by design — verify implementation
- Scenario: Spec rule 13 requires no raw payloads, no card data, no billing email, no auth data, no secrets. Schema columns honor this (only Stripe IDs, amount, currency, owner-link). Good.
- Where: `.specs/stripe-early-fraud-warnings.md:50-54`; `packages/db/src/schema.ts:485-558`.
- Severity: positive finding (n/a).
- Mitigation: PR2 code review must verify the ingestion layer never persists raw payload to `failure_context`.

### 16.2 [PR1] `failure_context` and `reason` are free-text and could leak PII
- Scenario: As 3.5 / 10.3 / 5.4 above. The free-text columns rely on developer discipline.
- Severity: medium.
- Mitigation: Add length CHECK; require enum-ish reason; redact strings hitting failure_context.

### 16.3 [PR1] User-row-level PII linked indirectly
- Scenario: After soft-delete the case still links by `stripe_customer_id` to the user row, which is anonymized but retains `stripe_customer_id` (intentional, for fraud detection). That's correct, but means PII is one join away if user row is later un-anonymized (it shouldn't be, but worth mentioning).
- Severity: low.
- Mitigation: Document that `stripe_customer_id` retention is part of GDPR justified-interest exemption for fraud prevention.

### 16.4 [PR1] Notice content out of scope of this PR
- Scenario: Spec rule 28 prohibits disclosure but PR1 ships no template. PR2 must include the template review.
- Severity: deferred.

---

## Cross-cutting recommendations

These cut across categories and are worth surfacing for the human reviewer:

1. **Add payment-method fingerprint to the case row.** This single change strengthens 1.1, 1.4, 1.5, 3.2, 12.1, 12.2 — it is the single highest-value mitigation for repeat-offender detection across re-registrations and is consistent with spec rule 10's "safe payment correlation identifiers".

2. **Add cross-case action-level idempotency for charge-keyed effects.** Specifically a partial unique on `(action_type, target_key)` for refund / payment_value_clawback / affiliate_payout_reversal / referral_reward_reversal. Closes 4.3, 5.1, and the cross-event dedup story for dispute-after-EFW.

3. **Spec a non-destructive org freeze.** Without this, org-routing is a near-total automation bypass (1.2, 2.1, 8.1).

4. **Pin owner classification to charge time.** Closes 1.3 and 2.2.

5. **Spec webhook signature + replay protection.** Closes 6.1–6.3 ahead of PR2 implementation.

6. **Preserve fraud-block on soft-delete.** Closes 3.1 — small, targeted fix in `softDeleteUser`.

7. **Add CHECK constraints tying `status` ↔ `*_at` and ownership ↔ `owner_classification`.** Closes 4.4, 13.1, 13.5 with cheap DB-level guarantees.

8. **Add `kilo_user_id_at_warning` (non-nullable, never nulled).** Closes 3.3, 12.2.

9. **Add `composio_credential_revocation` action_type.** Closes 2.3.

10. **Add `remediated_by_kilo_user_id` + `remediation_rationale`.** Closes 11.3.

---

## Out-of-scope notes

- This PR does not include the EFW ingestion handler or worker — most "PR2 design risk" findings are advisory for the next PR.
- Several PRs of related context (Composio creds, Impact reverse-action) are referenced but not modified here.
- The DESIGN.md and bot-related changes in the diff appear unrelated to EFW persistence and are not reviewed here.
