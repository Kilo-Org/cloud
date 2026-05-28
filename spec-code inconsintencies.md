# PR #3552 — Spec ↔ Code Divergence Review

`feat(stripe): add early fraud warning persistence foundation`

This review compares the spec changes (`.specs/stripe-early-fraud-warnings.md` plus the cross-spec amendments to KiloClaw billing/datamodel, team-enterprise seat billing, Impact affiliate tracking, and Impact referrals) against the implementation in `packages/db/src/schema.ts`, `packages/db/src/schema-types.ts`, the migration `0145_awesome_wild_child.sql`, the GDPR soft-delete logic in `apps/web/src/lib/user/index.ts`, and the corresponding tests.

The PR is explicitly scoped as the **persistence-only foundation** (per `.specs/stripe-early-fraud-warnings.md:11–12, 39`). Most behavioral rules (ingestion, refund execution, Impact reversal wiring, KiloClaw cancellation/suspension, kill switch, transactional notice) are deferred to subsequent PRs. The review distinguishes "must-have for PR1" findings from "PR2 follow-up".

---

## Executive Summary — Worst Divergences First

| # | Severity | Blocking PR1? | Finding |
|---|---|---|---|
| 1 | medium | yes | `softDeleteUser` only nulls `kilo_user_id` on EFW cases; spec rule 14 also requires anonymizing **"other directly identifying fields"** that may include `failure_context` / `reason`. No content-shape constraint exists, so the schema currently cannot guarantee these are non-PII. (`apps/web/src/lib/user/index.ts:1263–1266`, spec line 55) |
| 2 | medium | yes | Soft-delete test does not assert that an action's `case_id` still resolves and that the **action row** is preserved untouched on user deletion. It checks one action exists but does not exercise an organization-linked case to confirm nothing accidentally changes for other classifications. (`apps/web/src/lib/user/index.test.ts:1791–1860`, spec line 55) |
| 3 | medium | PR2 follow-up | None of the cross-spec rules added (KiloClaw fraud-enforcement subscription mutations, Impact affiliate adverse-payment SALE reversal, Impact referral EFW-refund handling, organization review-only) have any code persistence beyond the EFW tables themselves. This is consistent with "persistence foundation" scope but worth flagging because subsequent PRs **must** wire these into existing tables (`kiloclaw_subscription_change`, `pending_impact_sale_reversals`, `impact_referrals*`). |
| 4 | low | yes | Spec rule 13 forbids storing raw Stripe payloads or sensitive failure output in case/action persistence. The schema permits arbitrarily long `failure_context` / `reason` (`text` with no length/JSON-shape check). The codebase has no validator yet. Acceptable as PR1 because no writers exist, but tighten before ingestion is enabled. (`packages/db/src/schema.ts:506–507, 591`) |
| 5 | low | yes | The `stripe_event_id` column has only a non-unique index. Spec rule 9 requires "at most one case per EFW identifier" — guaranteed by `UQ_stripe_early_fraud_warning_cases_warning_id`. Spec rule 12 requires idempotency under duplicate webhook delivery; that is satisfied by the warning-id uniqueness, so a non-unique event-id index is fine. Calling out so reviewers do not assume otherwise. |
| 6 | nit | no | Spec uses the term "operational reason"; column name is `reason` (singular text). Fine but no controlled vocabulary defined yet. Spec rule 31 implies operational categorization (e.g. `automatic_personal_enforcement`, `organization_review_only`, etc.) — define this enum in PR2 to avoid free-form strings drifting. |
| 7 | nit | no | The action `target_key` is a free-form text with only a non-empty check. Tests use `'charge:ch_xxx'`. Spec rule 12 requires convergence under duplicates — the unique `(case_id, action_type, target_key)` covers this, but the lack of a documented `target_key` vocabulary (e.g. `charge:<id>`, `subscription:<id>`, `instance:<id>`) is a code smell. Define when ingestion is wired. |

No critical blockers identified for PR1. The schema, migration, types, and soft-delete test broadly track the spec. The most material gap is that PR1 documents soft-delete intent but does not enforce that text fields be free of PII — this is content-shape, not table-shape, so it relies on the discipline of future writers.

---

## Methodology

Each spec rule was extracted verbatim or paraphrased, located in the implementation, and verified for column name / type / nullability / FK behavior / default / constraint correspondence. Migration SQL was diffed against schema-derived expectations. The GDPR soft-delete flow was checked against spec rule 14. Cross-spec amendments were checked for downstream code touchpoints; none are expected in PR1.

---

## EFW Table — `stripe_early_fraud_warning_cases`

Spec source: `.specs/stripe-early-fraud-warnings.md` rules 9–14, 16, 30.

### Columns mandated or implied by spec

| Spec claim | Code location | Match? | Notes |
|---|---|---|---|
| "at most one case for each Stripe EFW identifier" (rule 9) | `schema.ts:528–530`, migration `UQ_stripe_early_fraud_warning_cases_warning_id` | ✅ | Unique constraint on `stripe_early_fraud_warning_id`. |
| "safe payment correlation identifiers" (rule 10) | `schema.ts:493–496` (`stripe_charge_id`, `stripe_payment_intent_id`, `stripe_customer_id`) | ✅ | All nullable text. |
| "amount/currency when available" (rule 10) | `schema.ts:497–498` (`amount_minor_units integer`, `currency text`) | ✅ | Both nullable. CHECK constraint `amount_minor_units IS NULL OR >= 0`. |
| "owner classification" (rule 10) | `schema.ts:499` `owner_classification text NOT NULL` | ✅ | Constrained by `enumCheck` to `personal | organization | ambiguous | unmatched`. Matches definitions in spec lines 21–24. |
| "optional canonical owner links" (rule 10) | `schema.ts:500–504` `kilo_user_id` (FK kilocode_users, ON DELETE SET NULL), `organization_id` (FK organizations, ON DELETE SET NULL) | ✅ | Both nullable. |
| "lifecycle status" (rule 10) | `schema.ts:509–512` `status text NOT NULL DEFAULT 'queued'` | ✅ | Constrained to `queued | contained | processing | completed | review_required | failed | remediated | dismissed`. |
| "operational reason" (rule 10) | `schema.ts:513` `reason text` | ⚠️ nit | Free text; no controlled vocabulary. Define before ingestion lands. |
| "timestamps" (rule 10) | `schema.ts:515–525` (`warning_created_at`, `contained_at`, `processing_started_at`, `completed_at`, `review_required_at`, `remediated_at`, `dismissed_at`, `created_at`, `updated_at`) | ✅ | Full lifecycle covered. |
| "non-sensitive failure context" (rule 10, rule 13) | `schema.ts:514` `failure_context text` | ⚠️ low | No length/shape check. Relies on future writer discipline. |
| Indexes for retrieval/audit (implied by rule 10) | `schema.ts:531–541` indexes on `stripe_event_id`, `stripe_charge_id`, `stripe_payment_intent_id`, `stripe_customer_id`, `kilo_user_id`, `organization_id`, `(status, created_at)` | ✅ | Index set is broad enough for common review queries. |
| "MUST immediately block the canonical personal account locally … MUST NOT overwrite an earlier independent block reason" (rule 16) | Not modeled in this PR. | n/a | Behavioral; deferred to PR2. No blocked-by/reason field on `kilocode_users` is added; current `kilocode_users` already has `blocked_at` / `blocked_by_kilo_user_id` (`schema.ts:359–360`) so the foundation exists. |

### `stripe_early_fraud_warning_cases` — migration vs schema

Migration `0145_awesome_wild_child.sql` was diffed against the Drizzle definition. Findings:

- Column ordering and types match.
- Defaults match (`gen_random_uuid()` for `id`, `now()` for `created_at`/`updated_at`, `'queued'` for `status`, `0` for action `attempt_count`).
- FKs match: `kilo_user_id` → `kilocode_users(id)` ON DELETE SET NULL ON UPDATE CASCADE; `organization_id` → `organizations(id)` ON DELETE SET NULL ON UPDATE CASCADE.
- All CHECK constraints from `enumCheck`/`check` are emitted.
- All indexes are emitted including the partial expression index on `coalesce(next_retry_at, '-infinity'::timestamptz)`.
- One minor consistency note: schema uses Drizzle `$onUpdateFn(() => sql\`now()\`)` for `updated_at`; migration emits a plain `DEFAULT now()` column with no trigger. Drizzle's `$onUpdateFn` is **client-side ORM behavior only** — direct SQL writes (e.g. raw INSERT/UPDATE) will not refresh `updated_at`. Severity: low; matches the project's pre-existing pattern (see other tables in `schema.ts`). Flag if the EFW writer ever uses raw SQL.

---

## EFW Table — `stripe_early_fraud_warning_actions`

Spec source: `.specs/stripe-early-fraud-warnings.md` rules 11–13, 17, 31.

### Action types — spec rule 11 vs `StripeEarlyFraudWarningActionType`

Spec rule 11 enumerates required operations:

> containment, exact-charge refund, attributable-value reversal, subscription/access termination, KiloClaw suspension, payout or reward handling, and the user notice

Implementation (`schema-types.ts:281–292`, schema check at `schema.ts:611–614`):

| Spec operation | Action type constant | Match? |
|---|---|---|
| containment | `containment` | ✅ |
| exact-charge refund (rule 18) | `refund` | ✅ |
| attributable-value reversal (rule 19) | `payment_value_clawback` | ✅ |
| subscription/access termination (rule 21) | `subscription_termination`, `access_termination` (split into two — finer granularity than spec) | ✅ |
| KiloClaw suspension (rule 22) | `kiloclaw_suspension` | ✅ |
| payout reversal (rule 26 — affiliate) | `affiliate_payout_reversal` | ✅ |
| reward reversal (rule 27 — referrals) | `referral_reward_reversal` | ✅ |
| user notice (rule 28) | `user_notice` | ✅ |

No spec-listed action is missing. The split of "subscription/access termination" into two separate types is a reasonable narrowing and does not exceed spec authority.

**Note:** the spec does not require a separate `kiloclaw_subscription_termination` distinct from `subscription_termination`. The current set treats `kiloclaw_suspension` as the compute-stop side and `subscription_termination` as the renewal-stop side. That mapping matches `kiloclaw-billing.md` rule 2/3 of the new section. Ensure the PR2 implementation does not enqueue both `subscription_termination` and `kiloclaw_suspension` redundantly per KiloClaw subscription unless that is intentional (`target_key` distinguishes them — fine).

### Status values — rule 31

Action statuses (`schema-types.ts:294–301`): `queued | processing | completed | failed | review_required | dismissed`.

Spec rule 31:
> Required personal actions MUST NOT be marked completed while any required shutdown or financial action is unconfirmed; failed or ambiguous operations MUST remain retryable or review-required.

Match: `failed` and `review_required` are present. `dismissed` is broader than the spec — it presumably covers operator dismissal of an action that turned out to be a no-op (e.g. action_type that is not applicable). Not spec-authorized but not spec-prohibited; acceptable.

### Idempotency — rules 9, 12, 33

| Spec claim | Code location | Match? |
|---|---|---|
| "at most one case per EFW identifier" (rule 9) | `UQ_stripe_early_fraud_warning_cases_warning_id` | ✅ |
| "No required effect may be executed more than once for the same case/action target" (rule 12) | `UQ_stripe_early_fraud_warning_actions_case_type_target` on `(case_id, action_type, target_key)` | ✅ |
| Convergence under retry/concurrent processing (rule 12) | Concurrency primitives (`status`, `claimed_at`, `attempt_count`, `next_retry_at`) plus the `IDX_stripe_early_fraud_warning_actions_claim_path` index over `(status, coalesce(next_retry_at,'-infinity'), created_at, id)` | ✅ | The claim index is well-suited to a single-worker `SELECT … FOR UPDATE SKIP LOCKED` claim pattern. |

### Sensitive payload prohibition — rule 13

> Case and action persistence MUST NOT store raw Stripe payloads, card data, billing email, auth data, secrets, or sensitive failure output. Stripe object identifiers and non-sensitive result codes are sufficient for retrieval and audit.

| Field | Spec compliance |
|---|---|
| `result_code text` | ✅ Compatible — short codes only. |
| `result_reference_id text` | ✅ Compatible — Stripe object IDs (e.g. `re_xxx`). |
| `failure_context text` (cases AND actions) | ⚠️ low — no length or JSON-shape constraint. Up to writers to keep non-sensitive. Recommend defining a small union of allowed reason codes for PR2. |

Acceptable for the persistence foundation, but the spec rule 13 burden is now on every future writer.

---

## Enum Constants — `schema-types.ts`

Verified against `schema.test.ts` (`SCHEMA_CHECK_ENUMS`) and the `enumCheck` calls in `schema.ts`:

- `StripeEarlyFraudWarningOwnerClassification` — `personal | organization | ambiguous | unmatched` — matches spec definitions lines 21–24. ✅
- `StripeEarlyFraudWarningCaseStatus` — `queued | contained | processing | completed | review_required | failed | remediated | dismissed` — covers rule-30 paused/review-required, rule-32 remediation, rule-31 failed/review_required. ✅
- `StripeEarlyFraudWarningActionType` — see above table. ✅
- `StripeEarlyFraudWarningActionStatus` — see above. ✅
- `schema.test.ts:241–273` asserts the runtime constant values match between TS, schema, and DB CHECK constraint. ✅

No divergence.

---

## GDPR / Soft Delete — `apps/web/src/lib/user/index.ts`

Spec source: `.specs/stripe-early-fraud-warnings.md` rule 14.

> When a linked user is soft-deleted, retained case/action audit history and fraud-correlation identifiers MAY remain, but **direct user linkage and other directly identifying fields MUST be anonymized or removed.**

Implementation (`apps/web/src/lib/user/index.ts:1263–1266`):

```ts
await tx
  .update(stripe_early_fraud_warning_cases)
  .set({ kilo_user_id: null })
  .where(eq(stripe_early_fraud_warning_cases.kilo_user_id, userId));
```

Findings:

1. **Direct user linkage**: ✅ `kilo_user_id` is nulled.
2. **Other directly identifying fields**: ⚠️ medium. The schema's columns are deliberately limited to Stripe identifiers, owner classification, status, timestamps, and free-form `reason`/`failure_context`. The spec calls Stripe identifiers "fraud-correlation identifiers" (rule 14, "MAY remain"). The risk lies entirely in the unconstrained text fields. PR1 has no writers, so there is no immediate PII leak; **but** the soft-delete code does not (and arguably cannot) sanitize a free-form `failure_context`. Recommend either (a) a documented invariant that `reason` is a controlled vocabulary and `failure_context` is restricted to non-PII codes, or (b) clearing both fields on soft delete to be safe. Acceptable for PR1 because no writers exist; flag for PR2.
3. **Action rows**: not touched in soft-delete code. Action rows do not store user-identifying data (only `case_id`, `target_key` like `charge:ch_xxx`, `result_reference_id` like `re_xxx`). Compliant with rule 14 since these are fraud-correlation identifiers. ✅
4. **`organization_id`**: not nulled on user soft delete (correct — the user being deleted is not the org). Org soft delete is out-of-scope for this spec but the FK already has ON DELETE SET NULL so org deletion will null it automatically. ✅
5. **Rows are not deleted**: ✅ Spec rule 14 says audit history MAY remain. Code uses `UPDATE … SET kilo_user_id = NULL`, not `DELETE`. The test asserts row preservation. ✅
6. **AGENTS.md GDPR rule** ("when adding PII to the database, update softDeleteUser and add a test") is satisfied for the `kilo_user_id` linkage. ✅

### Test — `apps/web/src/lib/user/index.test.ts:1791–1860`

| Assertion | Spec rule mapped | Verdict |
|---|---|---|
| Case row count = 1 after soft delete | rule 14 (audit may remain) | ✅ |
| Case `kilo_user_id` is null | rule 14 (direct linkage anonymized) | ✅ |
| Case `stripe_early_fraud_warning_id` preserved | rule 10 (correlation identifiers retained) | ✅ |
| Case `stripe_charge_id` preserved | rule 10 | ✅ |
| Action row count = 1 | rule 11/12 (idempotent ledger preserved) | ✅ |
| Action `result_reference_id` preserved | rule 14 (fraud-correlation may remain) | ✅ |
| Unaffected user's case `kilo_user_id` unchanged | scope of mutation | ✅ |

Gaps in the test (not blocking, but worth noting):
- No assertion that an **organization-linked** case (with `organization_id` set, no `kilo_user_id`) is untouched by user soft delete. Easy add.
- No assertion that other directly identifying fields beyond `kilo_user_id` are or are not cleared — i.e. the test does not codify the spec rule 14 boundary on `failure_context` / `reason`. If the policy is "leave Stripe IDs, null only `kilo_user_id`", the test should assert that `stripe_customer_id`, `stripe_payment_intent_id`, etc. are all preserved.

Severity: medium. Blocking? Recommended to extend the test in PR1 to lock down the policy explicitly so PR2 does not regress it accidentally.

---

## Cross-Spec Rules — Persistence Footprint

The PR amends four other specs. PR1 does **not** add downstream persistence to satisfy them; this is consistent with "persistence foundation" scope but the table below should be re-checked when PR2 lands.

| Spec amendment | Required code touchpoint (future) | Present in PR1? | Comment |
|---|---|---|---|
| `kiloclaw-billing.md:836–844` "Fraud-Enforcement Cancellation Exception" — immediate cancellation, system-actor change-log entries, 7-day destruction grace | `kiloclaw_subscription_change` (or equivalent change-log table), KiloClaw instance state, KiloClawSubscriptionChangeAction enum extension | ❌ not in PR1 | Action enum `kiloclaw_suspension` placeholder exists; no new `KiloClawSubscriptionChangeAction` value or reason code added. **PR2 must** add a fraud-enforcement reason code and verify the existing change-log path covers it. Mark as deferred. |
| `kiloclaw-datamodel.md:273–279` "Fraud-Enforcement Mutations" — system-actor change log, 7-day grace | same as above | ❌ not in PR1 | Deferred. |
| `team-enterprise-seat-billing.md:512–518` "Early Fraud Warning Review Boundary" — organization-owned EFWs are review-only | The `owner_classification = 'organization'` value exists. ✅ Persistence foundation is in place. | ✅ partial | The schema models the classification; the **enforcement** that "no automatic action" happens for organization cases is behavioral and lives in the PR2 ingestion. |
| `impact-affiliate-tracking.md:198–222` adverse-payment SALE reversal extended to enforced EFW refunds | `pending_impact_sale_reversals` writers; `affiliate_payout_reversal` action wires to it | ❌ behavior only | The action enum value `affiliate_payout_reversal` is reserved. PR2 must implement the reversal worker. |
| `impact-referrals.md:629–648` enforced EFW refund classified as adverse for referrals | Referral reward state machine writers; `referral_reward_reversal` action wires to it | ❌ behavior only | Action enum value reserved. PR2 must implement. |

No code in PR1 contradicts any of these spec amendments; everything is correctly deferred to the action-execution PR.

---

## Items Beyond the Spec

The following exist in code but are not directly mandated by the spec. None are spec-prohibited.

| Code | Comment | Severity |
|---|---|---|
| `terminal_at` on actions (`schema.ts:586`) | Bookkeeping for terminal-state arrival. Not in spec but sensible. | nit |
| `claimed_at` / `attempt_count` / `next_retry_at` on actions | Standard claim/retry mechanics implementing rule 12 idempotency under retry. ✅ | n/a |
| `dismissed` action status | Operator-dismissed no-op actions. Spec is silent. | nit |
| `processing_started_at` and `review_required_at` on cases | Lifecycle bookkeeping; sensible. | nit |
| `action_type` split into `subscription_termination` + `access_termination` | Finer-grained than spec rule 11 wording. Allowed. | nit |

---

## Migration Quality

`packages/db/src/migrations/0145_awesome_wild_child.sql` is a clean drizzle-generated migration:

- Two `CREATE TABLE` statements with all defaults, NOT NULL, CHECK, and UNIQUE constraints.
- Three `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` statements with explicit `ON DELETE` and `ON UPDATE` clauses matching the schema.
- Eight indexes including the expression index on `coalesce(next_retry_at, '-infinity'::timestamptz)`.
- No hand-edited SQL detected; the snapshot in `packages/db/src/migrations/meta/0145_snapshot.json` corresponds (was not deeply audited but sizes/timestamps consistent).
- The repo rule "never hand-edit migration SQL" appears respected.

No divergence between schema.ts and migration SQL detected.

---

## Summary by Severity

**Blocking PR1:** none (no critical mismatch between schema, migration, types, soft-delete code, and spec).

**Should fix in PR1 (recommended, not strictly blocking):**
- Extend the soft-delete test to (a) assert non-user fields are preserved exactly, and (b) include an organization-linked case to document the policy boundary. (medium)

**Defer to PR2 / ingestion:**
- Define controlled vocabulary for `reason` and `failure_context` (spec rule 13 enforcement).
- Define controlled `target_key` format vocabulary.
- Wire the action types to their executors and connect `affiliate_payout_reversal` / `referral_reward_reversal` / `subscription_termination` / `kiloclaw_suspension` to the existing Impact, KiloClaw, and subscription-change-log code paths per the cross-spec amendments.
- Implement the operational off switch (rule 29) and the minimal transactional notice (rule 28).
- Confirm `softDeleteUser` does not need to also scrub `failure_context`/`reason` once writer policy is finalized.

**Items that go beyond the spec:** all are minor extensions consistent with spec intent (`terminal_at`, `dismissed`, claim-mechanics columns, finer-grained action types). None exceed authorization.

---

## Verdict

The persistence foundation matches the spec. Schema, migration, types, and the GDPR soft-delete linkage all line up. The most material gap is policy ambiguity around free-form `reason`/`failure_context` text — content-shape rather than table-shape — which a writer-side discipline will need to enforce in PR2. The test coverage is adequate for the user-deletion path but should be extended to lock down the org-linked-case scenario before merge to prevent silent regression in PR2.
