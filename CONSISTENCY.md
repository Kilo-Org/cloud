# PR #3552 Design Consistency Review

PR title: `feat(stripe): add early fraud warning persistence foundation`
Branch: `pr-3552` (vs `main`)
Reviewer: automated consistency pass

## Summary

This PR introduces the persistence-only foundation for Stripe Early Fraud
Warning (EFW) enforcement: a new spec (`.specs/stripe-early-fraud-warnings.md`),
two new tables (`stripe_early_fraud_warning_cases` and
`stripe_early_fraud_warning_actions`) plus four new TS enums, a single
generated migration (`0145_awesome_wild_child.sql`), GDPR soft-delete
coverage that nulls the case→user FK while retaining audit history, and
cross-spec alignment edits in `impact-affiliate-tracking.md`,
`impact-referrals.md`, `kiloclaw-billing.md`, `kiloclaw-datamodel.md`, and
`team-enterprise-seat-billing.md`.

Overall the schema, migration, enum types, schema test, and soft-delete code
agree with each other tightly — the migration mirrors the schema essentially
verbatim, and the schema-test enum registry exhaustively covers all four new
enums. The cross-spec edits are mostly self-consistent. Findings below
are mostly low/medium-severity terminology, formatting, or scope-tightness
issues, with one notable medium-severity gap (no field on the case row that
records the operational off-switch / paused state called out in the EFW
spec) and one low-severity scope creep (a stylistic em-dash → `--`
conversion in `kiloclaw-datamodel.md` that is unrelated to the feature).

No critical or high-severity inconsistencies found.

---

## Spec ↔ Spec

### F1. "Block" vs "contain" vs "cancel" terminology drift across specs (low)

- `.specs/stripe-early-fraud-warnings.md:65` (rule 16) uses "MUST immediately
  block the canonical personal account locally".
- `.specs/stripe-early-fraud-warnings.md` Definitions (line ~22) defines a
  **Case** but does **not** define "block" or "containment" as terms,
  even though the case-status enum in schema includes `contained` and an
  action type `containment` is reified.
- `.specs/kiloclaw-billing.md:842-843` ("Fraud-Enforcement Cancellation
  Exception", rule 2) phrases the same operation as "immediately cancel
  renewal". `.specs/kiloclaw-datamodel.md` ("Fraud-Enforcement Mutations")
  uses "cancel or suspend".
- `.specs/team-enterprise-seat-billing.md` ("Early Fraud Warning Review
  Boundary", rule 2) uses "block an individual member".

The same operational concept is named "block", "contain", "cancel", and
"suspend" in different specs. The schema chose `contained_at` /
`containment` — locking in "contain"/"containment" as the canonical term.
**Suggested resolution**: add a Definitions entry in
`stripe-early-fraud-warnings.md` for *Containment* explicitly tying it
to local account block + auto-top-up disable, and prefer that term in
the other specs (or at least cross-reference). Severity: **low**.

### F2. "Adverse" vs "Disputed" naming alignment between affiliate and referral specs (low)

- `.specs/impact-affiliate-tracking.md` renames the term to
  "Adverse eligible sale" (definitions section, lines ~58-62), and adds
  an "Adverse Payment Reversals" subsection.
- `.specs/impact-referrals.md` does **not** introduce an analogous
  "adverse payment" term in its Definitions — it adds an
  "Enforced EFW refund" definition only, and the Refunds/Reversals/Fraud
  subsection still uses the heading "Refunds, Reversals, and Fraud"
  rather than "Adverse" naming.

Not contradictory but stylistically inconsistent across two specs that
collaborate on the same fraud case. **Suggested resolution**: either
mirror the "adverse" term into `impact-referrals.md` definitions, or
acknowledge that referrals retain the per-event vocabulary. Severity:
**low**.

### F3. Rule 14 PII boundary uses "fraud-correlation identifiers" but never enumerates them (low/nit)

- `.specs/stripe-early-fraud-warnings.md:60` (rule 14): "retained
  case/action audit history and fraud-correlation identifiers MAY remain,
  but direct user linkage and other directly identifying fields MUST be
  anonymized or removed".

The schema retains `stripe_customer_id`, `stripe_charge_id`,
`stripe_payment_intent_id`, `stripe_event_id`,
`stripe_early_fraud_warning_id`, and `result_reference_id` after soft
delete (the test confirms this via `softDeleteUser`). All of these are
Stripe-side correlation identifiers, which is consistent with the spec's
"fraud-correlation identifiers MAY remain", but the spec never spells
that out and a reader could reasonably argue `stripe_customer_id` is
"directly identifying" since it links Kilo's deleted user back to their
billing identity in Stripe. **Suggested resolution**: add a
non-normative bullet to the EFW spec listing which Stripe identifier
columns are explicitly considered fraud-correlation rather than direct
PII (charge, intent, customer, event, warning, refund). Severity: **low**.

### F4. Persistence-only deployability invariant has no operational off-switch column (medium)

- `.specs/stripe-early-fraud-warnings.md` Status (line 9) and rules 4,
  29-30 establish an "operational off switch" that, when off, MUST keep
  newly received EFWs operator-visible as "paused or review-required"
  state and MUST NOT perform containment.
- Schema's `StripeEarlyFraudWarningCaseStatus` includes:
  `queued`, `contained`, `processing`, `completed`, `review_required`,
  `failed`, `remediated`, `dismissed` — but **no `paused` value**.

If the off-switch is satisfied entirely by routing new cases into
`review_required` then this is fine, but the spec language explicitly
distinguishes "paused or review-required". A future reader (or this
release if/when ingestion ships) may want a distinct paused state to
disambiguate "EFW kill-switch is currently flipped" from "ownership
ambiguous, needs human". **Suggested resolution**: either add a `paused`
status enum value now (cheap while persistence is inert), or amend the
spec to commit to "paused = `review_required` with a documented
`reason` value". Severity: **medium**.

### F5. Spec rule 15 "durably claim the case" not represented at the case level (low)

- `.specs/stripe-early-fraud-warnings.md:64` (rule 15): "the system MUST
  durably claim the case before initiating destructive work".
- Schema `stripe_early_fraud_warning_cases` has `processing_started_at`
  but no `claimed_at` / claim-token / lease columns; only the
  `stripe_early_fraud_warning_actions` table has `claimed_at`.

This may be deliberate — the case is "claimed" by being moved to
status=`processing` with `processing_started_at` set, while individual
actions are leased with `claimed_at`. But the spec rule reads at the
case level, and the schema represents the claim only at the action
level. **Suggested resolution**: clarify in the spec that case-level
claim is realised by the `processing` status transition and
`processing_started_at` write, or add a case-level `claimed_at` for
symmetry with the action ledger. Severity: **low**.

### F6. No uniqueness on `stripe_event_id` despite duplicate-webhook idempotency requirement (low)

- `.specs/stripe-early-fraud-warnings.md:60` (rule 12): "Each operation
  MUST converge under duplicate webhook delivery". Rule 9 enforces
  per-warning case uniqueness.
- Schema only enforces `unique` on `stripe_early_fraud_warning_id`;
  `stripe_event_id` has only an `IDX_..._event_id` index, no unique
  constraint.

Multiple events can refer to the same warning, so this is technically
correct. However, if the implementation later needs an
"event-already-processed" idempotency table it will live elsewhere; the
case row's `stripe_event_id` is the *original* triggering event id only.
The spec doesn't explicitly require event-level uniqueness, so this
is probably fine, but worth flagging because a casual reader of the
schema might assume `stripe_event_id` is the idempotency key. Severity:
**low/nit**. Suggested resolution: a comment near the column or a
sentence in the spec clarifying that idempotency is keyed by warning id,
and `stripe_event_id` is purely a debugging breadcrumb of the first
triggering event.

### F7. KiloClaw billing exception rule 2 vs EFW spec rule 21 wording mismatch (low)

- `.specs/stripe-early-fraud-warnings.md` rule 21 lists "personal
  auto-top-up and recognized personal recurring subscriptions".
- `.specs/kiloclaw-billing.md:843` rule 2 says "every current personal
  KiloClaw subscription belonging to the contained user, including
  Stripe-funded, hybrid, and pure-credit renewal state".

These do not contradict, but the EFW spec frames the unit as
"personal recurring access" and KiloClaw billing frames it as
"personal KiloClaw subscription" categories. Worth a quick sentence
cross-linking that "recognized personal recurring subscriptions"
includes hybrid/credit-funded KiloClaw rows. Severity: **low**.

### F8. Organization-owned EFW rule duplicated across three specs with slightly different scopes (low/nit)

- `.specs/stripe-early-fraud-warnings.md` rule 7 / 8 lists what MUST NOT
  happen for organization-owned warnings.
- `.specs/team-enterprise-seat-billing.md` "Early Fraud Warning Review
  Boundary" rules 1-3 add the operator-review and
  "authorized manual review decision" rule.
- `.specs/kiloclaw-billing.md` rule 6 ("This exception MUST NOT apply
  to organization-managed KiloClaw subscriptions...") and
  `.specs/kiloclaw-datamodel.md` ("Organization-managed subscription
  and instance rows MUST NOT be mutated automatically...") restate
  the same rule.

All four agree, but each phrases the carve-out slightly differently
(seat access, refund organization billing, organization-managed
subscriptions, organization-managed instance rows). No contradiction.
**Suggested resolution**: pick the EFW spec as the canonical statement
and have the others say "see EFW spec rules 7-8" rather than restating.
Severity: **low/nit**.

---

## Spec ↔ Schema

### F9. Spec rule 11 maps to two action types per category — well represented (info / no finding)

Spec: "containment, exact-charge refund, attributable-value reversal,
subscription/access termination, KiloClaw suspension, payout or reward
handling, the user notice".

Schema action_type enum (`schema-types.ts:265-281`):
`containment`, `refund`, `payment_value_clawback`,
`subscription_termination`, `access_termination`, `kiloclaw_suspension`,
`affiliate_payout_reversal`, `referral_reward_reversal`, `user_notice`.

Mapping:
- containment → `containment` ✓
- exact-charge refund → `refund` ✓
- attributable-value reversal → `payment_value_clawback` ✓ (different
  word in TS — see F12)
- subscription/access termination → `subscription_termination` +
  `access_termination` ✓ (split, fine)
- KiloClaw suspension → `kiloclaw_suspension` ✓
- payout or reward handling → `affiliate_payout_reversal` +
  `referral_reward_reversal` ✓ (split, fine)
- user notice → `user_notice` ✓

No finding here.

### F10. Spec rule 10: required correlation fields all present (info / no finding)

Spec rule 10: "safe payment correlation identifiers, amount/currency
when available, owner classification, optional canonical owner links,
lifecycle status, operational reason, timestamps, and non-sensitive
failure context".

Schema has: `stripe_charge_id`, `stripe_payment_intent_id`,
`stripe_customer_id`, `amount_minor_units`, `currency`,
`owner_classification`, `kilo_user_id`, `organization_id`, `status`,
`reason`, `failure_context`, plus all timestamps. ✓

### F11. Naming mismatch: `payment_value_clawback` vs spec's "attributable-value reversal" (low)

- `.specs/stripe-early-fraud-warnings.md` rule 19 calls it "reverse
  only attributable value derived from the warned payment".
- `schema-types.ts` enum value: `payment_value_clawback`.

These describe the same thing but the words don't match. "clawback"
vs "reversal" and "payment value" vs "attributable value" can confuse
operators reading dashboards or logs. **Suggested resolution**: rename
the enum value to `attributable_value_reversal` (or amend the spec to
use "clawback" terminology) before any data is written, since this
is the inert persistence release. Severity: **low**.

### F12. Spec mentions "personal automatic top-up" disable but no separate action type (low/nit)

- `.specs/stripe-early-fraud-warnings.md` rule 16: "MUST immediately
  block the canonical personal account locally and disable personal
  automatic top-up capability".

The action enum has `containment` which presumably covers both
operations atomically. That is an acceptable design (one durable
"contain" action that performs both the block and the auto-top-up
disable transactionally), but the spec rule 11 list also says
"containment, exact-charge refund, ... and the user notice" which
could be read as a single containment step. Worth confirming in the
spec or in code comments that `containment` covers both
"local block" and "disable auto-top-up" effects. Severity: **low/nit**.

### F13. `failure_context` is an unstructured `text` column on both tables (low)

- `.specs/stripe-early-fraud-warnings.md` rule 13 forbids storing raw
  Stripe payloads, card data, billing email, auth data, secrets, or
  sensitive failure output.
- `failure_context text` in both tables is unstructured and will rely
  on convention to keep PII out.

This is acceptable — schema cannot enforce content rules — but a
reviewer should note the rule needs to be reinforced at the call
sites. Severity: **low**. Suggested: add a `// MUST NOT contain raw
Stripe payloads, card data, ...` comment on the schema column for the
benefit of future implementers.

### F14. Both tables use `idPrimaryKeyColumn` shape but inline (low/nit)

- `packages/db/src/schema.ts:2307-2310` defines a shared
  `idPrimaryKeyColumn` constant (uuid + default + primaryKey + notNull).
- The two new tables open-code the same shape inline rather than
  reusing the helper.

Trivial DRY drift but harmless. Severity: **nit**.

---

## Schema ↔ Migration

### F15. Migration file missing trailing newline (nit)

- `packages/db/src/migrations/0145_awesome_wild_child.sql` ends with
  `\ No newline at end of file` per `git diff`.

Drizzle-generated SQL traditionally ends without a trailing newline, so
this is consistent with the rest of the migrations directory; flagging
only for completeness. Severity: **nit**.

### F16. Migration ↔ schema parity (info / no finding)

Spot-checked every column and constraint. The migration faithfully
mirrors the schema for both tables:

| Aspect | Schema | Migration |
|---|---|---|
| `cases` PK uuid default `gen_random_uuid()` | yes | yes |
| `cases.stripe_early_fraud_warning_id` UNIQUE | `UQ_..._warning_id` | `UQ_..._warning_id` |
| `cases.kilo_user_id` FK → kilocode_users ON DELETE SET NULL ON UPDATE CASCADE | yes | yes |
| `cases.organization_id` FK → organizations ON DELETE SET NULL ON UPDATE CASCADE | yes | yes |
| `cases.status` default `queued` not null | yes | yes |
| `cases` enum check on `owner_classification` and `status` | yes | yes (member lists match enum types) |
| `cases.amount_minor_units` non-negative-or-null check | yes | yes |
| `actions.case_id` FK ON DELETE RESTRICT ON UPDATE CASCADE | yes | yes |
| `actions` UNIQUE(case_id, action_type, target_key) | yes | yes |
| `actions.attempt_count >= 0` check | yes | yes |
| `actions.target_key` length > 0 check | yes | yes |
| `actions` claim-path index `(status, coalesce(next_retry_at, '-infinity'::timestamptz), created_at, id)` | yes | yes |
| All seven `cases` indexes | yes | yes |

No findings.

### F17. Snapshot enum-check ordering matches migration & types (info / no finding)

`packages/db/src/migrations/meta/0145_snapshot.json` `*_check.value`
strings list enum members in the same order as the migration SQL and
the TS enum object literals. Sorted comparison in the schema test
(`schema.test.ts:303-312`) makes ordering irrelevant for that test,
but visual ordering is also consistent across files. No finding.

---

## GDPR / soft-delete

### F18. `softDeleteUser` covers cases but does not touch actions; aligns with spec rule 14 (info / no finding)

- `apps/web/src/lib/user/index.ts:1260-1264` nulls
  `stripe_early_fraud_warning_cases.kilo_user_id`.
- `stripe_early_fraud_warning_actions` rows are retained verbatim, which
  matches spec rule 14 ("retained case/action audit history ... MAY
  remain"). Actions table has no `kilo_user_id` field, only `case_id`,
  so there is nothing user-specific to scrub there. Test
  (`apps/web/src/lib/user/index.test.ts:1840-1853`) explicitly asserts
  the action row remains intact (`result_reference_id` retained,
  `case_id` unchanged). No finding.

### F19. JSDoc on `softDeleteUser` lists the EFW table in **both** the "kept" and "scrubbed" sections (low)

- `apps/web/src/lib/user/index.ts:794-795`: "stripe_early_fraud_warning_cases/actions
  (retained enforcement and financial audit history; case user
  ownership link is nulled)" — under **What is kept**.
- `apps/web/src/lib/user/index.ts:815`:
  "stripe_early_fraud_warning_cases direct user ownership link
  (FK nulled)" — under **What is scrubbed/deleted**.

Both bullets are individually true, but together they read awkwardly
because the same table is referenced twice and the "FK nulled" claim
under *scrubbed* is the same fact as the parenthetical under *kept*.
Other dual-purpose tables (e.g., `transactional_email_log`,
`payment_methods`) appear in only one section. Suggested resolution:
keep the "kept" bullet; remove or merge the "scrubbed" bullet to read,
e.g., "(FK link to user nulled — see retained section)". Severity:
**low**.

### F20. Test inserts use raw enum string literals ("personal", "completed", "refund") rather than the new TS enums (low/nit)

- `apps/web/src/lib/user/index.test.ts:1812-1842` uses
  `owner_classification: 'personal'`, `status: 'completed'`,
  `action_type: 'refund'`, `status: 'completed'`.
- AGENTS.md test exception allows `as` casts in tests, but using the
  exported `StripeEarlyFraudWarningOwnerClassification.Personal` etc.
  would survive enum renames safely. Other tests in this file likewise
  often pass raw strings, so this is consistent with the local style.
  Severity: **nit**.

---

## Naming & terminology

### F21. "Block" appears in EFW spec rule 16 and team-enterprise rule 2 but the case status is `contained` (low)

See F1. Severity duplicate.

### F22. "Case" vs "Warning" usage (low)

- The spec defines **Case** as the retained record and **Warning** as
  the Stripe event. Schema and migration consistently use `case` in
  table names, action FK, and indexes (good).
- However, the case row's primary natural identifier column is
  `stripe_early_fraud_warning_id` (= the issuing fraud warning id).
  This is correct, but reads slightly oddly because the column is on
  the *case* table while named after the *warning*. Worth keeping —
  it's the unique idempotency key — but a one-line comment in the
  schema would help. Severity: **low/nit**.

### F23. "Refund" vs "exact-charge refund" (info / no finding)

The spec deliberately calls out "exact-charge refund" to distinguish
from invoice-level refunds. Schema enum value is plain `refund`, with
the more precise meaning carried by the `target_key` column (e.g.,
`charge:ch_...`). The test uses `target_key: 'charge:ch_deleted_user'`
which establishes that convention. No finding, but a comment on
`target_key` describing the `<scope>:<id>` convention would help future
maintainers.

---

## Style / formatting

### F24. `.specs/kiloclaw-datamodel.md` includes unrelated em-dash → `--` conversions (low)

The diff shows two purely stylistic dash conversions in
`.specs/kiloclaw-datamodel.md` that have nothing to do with EFW:

- `Draft — created 2026-04-15.` → `Draft -- created 2026-04-15.`
  (Status line ~22)
- `instance — either` → `instance -- either` (Definitions section)

Other specs in the repo are split (some use em-dashes, some use `--`).
This PR's stripe spec uses `--`, so the conversion is *consistent
with the new spec*, but mixing it into this PR widens the diff and
risks objections in code review. **Suggested resolution**: either
revert these two stylistic edits to keep the PR focused, or do a
separate pass that normalizes dashes across all specs. Severity:
**low**.

### F25. Spec uses `Initial delivery is sequenced` paragraph but no Status state transitions are listed elsewhere (low/nit)

`.specs/stripe-early-fraud-warnings.md` Status section says only
"Draft -- created 2026-05-28." Most other Kilo specs include a
short bullet history of past status transitions. This is a brand-new
spec so there is nothing to list yet, but matching the
"Status" subsection format used by `subscription-center.md` or
`kiloclaw-billing-lifecycle.md` would help. Severity: **nit**.

### F26. `.specs/stripe-early-fraud-warnings.md` BCP-14 conventions block is a single paragraph (nit)

Other specs (e.g., `kiloclaw-billing.md`) place BCP-14 keywords on
their own lines or in a list; the new spec uses one paragraph. Stylistic
only. Severity: **nit**.

### F27. No tables in any of the modified specs need padding fixes (info / no finding)

Per AGENTS.md MD-table rule, padding must be single-space. The new
spec adds no tables. The other modified specs do not introduce
tables in their diff regions. No finding.

### F28. Consistent numbered-rule restart across spec edits (info / no finding)

`.specs/kiloclaw-billing.md` "Fraud-Enforcement Cancellation Exception"
restarts numbering at 1 (consistent with the file's other subsections,
each of which restarts numbering). `.specs/team-enterprise-seat-billing.md`
"Early Fraud Warning Review Boundary" likewise restarts at 1. The new
EFW spec uses a single global numbering 1-33 (consistent within itself).
No finding.

---

## Field naming (snake_case in DB, camelCase in TS)

### F29. Schema-types ↔ schema enum naming (info / no finding)

- TS enum object: `StripeEarlyFraudWarningOwnerClassification.Personal = 'personal'` etc.
- Schema column: `owner_classification: text().$type<StripeEarlyFraudWarningOwnerClassification>()`.

Pattern matches existing enums (e.g., `KiloClawSubscriptionStatus`).
PascalCase enum, snake_case column, kebab/snake_case literal values.
No finding.

### F30. `case_id`/`target_key`/`result_reference_id` use snake_case correctly (info / no finding)

All new column names are snake_case. The TS types
(`StripeEarlyFraudWarningCase`, `NewStripeEarlyFraudWarningCase`,
`StripeEarlyFraudWarningAction`, `NewStripeEarlyFraudWarningAction`)
are correctly inferred from the table. No finding.

---

## Nullability consistency (spec ↔ schema ↔ migration)

### F31. Spec rule 10 says "amount/currency when available" — schema makes both nullable (info / no finding)

- `amount_minor_units integer` — nullable in both schema and migration.
- `currency text` — nullable in both.
- Non-negative check tolerates `IS NULL`.

Matches "when available". No finding.

### F32. Spec rule 10 says "optional canonical owner links" — schema makes both nullable (info / no finding)

- `kilo_user_id text` — nullable.
- `organization_id uuid` — nullable.

Matches. No finding.

### F33. Required: `owner_classification`, `status`, `created_at`, `updated_at`, `stripe_event_id`, `stripe_early_fraud_warning_id` — all NOT NULL (info / no finding)

Matches the spec's "owner classification, lifecycle status, ...
timestamps". `stripe_event_id` is required (i.e., we always know which
event triggered the case row) which is consistent with rule 1's
"originate only from newly received [...] events" requirement. No finding.

### F34. `stripe_early_fraud_warning_actions.case_id` is NOT NULL with ON DELETE RESTRICT (info / no finding)

This is intentionally protective — actions cannot be orphaned and
cases cannot be deleted while actions exist. Aligns with spec rule 14
which requires retention of action history. No finding.

---

## Other

### F35. The PR also touches `apps/web/src/lib/bot/*` and `.kilo/design`, which are outside the EFW scope (low / out of scope for this review)

Per the user's brief, the consistency review is for the EFW additions
listed. Noting only that the diff includes:

- `.gitmodules` (+3 lines) and `.kilo/design` symlink/submodule (+1)
- `DESIGN.md` rework (~395-line diff)
- `apps/web/src/lib/bot/agent-runner.ts`,
  `apps/web/src/lib/bot/run.ts`,
  `apps/web/src/lib/bot/images.ts`,
  removal of `apps/web/src/lib/bot/attachments.{ts,test.ts}`,
  `apps/web/src/lib/bot/tools/spawn-cloud-agent-session*.ts`

These appear unrelated to EFW persistence and may belong to a separate
change. Worth confirming with the PR author whether these slipped in
from a rebase or are intentional in this PR. Severity: **low** (scope
hygiene, not consistency).

### F36. Test does not assert that `softDeleteUser` keeps `stripe_customer_id` on the case (low/nit)

`apps/web/src/lib/user/index.test.ts:1840-1846` asserts retention of
`stripe_early_fraud_warning_id` and `stripe_charge_id` after soft-delete,
but does not explicitly assert that `stripe_customer_id` is also
retained. Given F3's nuance about whether `stripe_customer_id` should
be retained, an explicit assertion either way would lock in intent.
Severity: **nit**.

### F37. Test cleanup ordering correct (info / no finding)

`apps/web/src/lib/user/index.test.ts:133-134` deletes
`stripe_early_fraud_warning_actions` before
`stripe_early_fraud_warning_cases` — matches the FK ON DELETE RESTRICT
relationship. No finding.

### F38. `failure_context` retained on actions even after soft-delete (low/nit)

Per F13, `failure_context` is unstructured text. After soft-delete the
column on retained action rows is not scrubbed. If an implementer ever
violates rule 13 and writes PII into `failure_context`, soft-delete
will not catch it. Suggested: add a defensive nulling of
`stripe_early_fraud_warning_actions.failure_context` (and the
case-level `failure_context`) at soft-delete time, since the spec rule
13 makes this content "non-sensitive" by contract — nulling on
soft-delete is essentially free insurance. Severity: **low**.

---

## Severity rollup

| Sev | Count | IDs |
|---|---|---|
| critical | 0 | — |
| high | 0 | — |
| medium | 1 | F4 |
| low | 14 | F1, F2, F3, F5, F6, F7, F11, F13, F19, F22, F24, F35, F36, F38 |
| nit/info | 23 | F8, F9, F10, F12, F14, F15, F16, F17, F18, F20, F21, F23, F25, F26, F27, F28, F29, F30, F31, F32, F33, F34, F37 |

Top items to consider before merging the *next* slice (event ingestion):
1. F4 — decide whether to add a `paused` status now or commit the spec
   to using `review_required` for the off-switch state.
2. F11 — rename `payment_value_clawback` to match the spec's
   "attributable-value reversal" while no data is written.
3. F1 / F21 — pin down "containment" as the canonical operation name in
   all five touched specs.
4. F19 — clean up the JSDoc duplication on `softDeleteUser`.
5. F35 — confirm the unrelated `apps/web/src/lib/bot/*`,
   `.kilo/design`, and `DESIGN.md` edits belong in this PR.
