# Service fee end-to-end validation

## Status and authority

Browser-and-database validation contract for `.plans/service-fees/GOAL.md` and
`.plans/service-fees/SPEC.md`.

`GOAL.md` is authoritative for product behavior. `SPEC.md` is authoritative for
technical design. This file is authoritative for **how we prove the behavior
with a real local app, a real Stripe test-mode Checkout, the local PostgreSQL
database, and a video of each journey**.

This is not a substitute for the unit, database, webhook, and Stripe sandbox
suites in `SPEC.md`. Those remain required. This file covers only what a person
(or an agent driving a browser) can honestly observe by acting as a user or
admin and then inspecting durable state.

Implementation is present, but the browser/database/video evidence pack is not yet complete.
Labels, routes, and table names below reflect the current app plus the spec. If implementation
changes a user-visible label or a column name, update this file in the same change.

## What "done" means here

A journey passes only when all four are true:

1. An operator followed the listed actor steps in a real browser session.
2. The UI showed the expected customer or admin outcome.
3. Local PostgreSQL contained the expected assessment, credit, exemption, or
   revenue rows.
4. Each required clip was produced by loading and following the
   `video-evidence` skill, and that skill's output contract is attached to the
   journey evidence pack.

A screenshot, a unit test, or a mocked Stripe client is not evidence for this
file. Stripe Dashboard or CLI output is supporting evidence, not a replacement
for the browser session. An unedited raw WebM, a screen recording that includes
login or debugging, or a file written inside the repository is not a passing
video artifact.

## What this file does not cover

These are required by `SPEC.md` and must stay in automated tests. They are not
honest user journeys:

- Pure rounding and pretax-line arithmetic
- Concurrent assessment-key inserts
- Webhook retry / idempotency storms
- `invoice.created` racing a Kilo-owned auto-top-up invoice
- Slack alert payload shape and Slack-failure isolation
- Restricted-coupon scheduled audit script
- Store-managed App Store / Google Play Kilo Pass
- Manual or sales-assisted organization Kilo Pass agreements

Hybrid journeys (renewal, dispute, operator partial refund) still start from a
browser-created purchase. The non-browser step is named and then the result is
verified again in the browser and the database.

---

## 1. Environment

### 1.1 Local stack

Reuse the current worktree session. Do not start a second stack.

```bash
pnpm dev:status --json
```

Required:

| Service | Why |
| --- | --- |
| Web app on the reported port | Every browser step |
| Worktree Postgres from `.env.local` `POSTGRES_URL` | Assessment, credit, exemption, revenue checks |
| Stripe webhook forwarder | Settlement, emails, subscription activation |
| Applied service-fee migration | Assessment and exemption tables exist |

Confirm webhook forwarding is live (`pnpm --filter web stripe` if `dev:start`
skipped it). Without it, Checkout can succeed and the database will stay empty.
`pnpm dev:status --json` may report the portless Stripe listener as `down` even
while `stripe listen` is forwarding correctly. Check the actual listener
process and its `--forward-to` URL. The URL must use this worktree's web port.

Read the web port from `pnpm dev:status`. Never assume `3000`. Worktree
PostgreSQL also uses a worktree-specific port; use `POSTGRES_URL` rather than a
root-worktree or default `5432` value.

```text
BASE=http://localhost:<web-port>
```

### 1.2 Activation clock

Fees apply only to billing objects created at or after
`2026-09-01T00:00:00Z` (`SERVICE_FEE_ACTIVATION_UNIX_SECONDS`).

| Wall clock | How to run this file |
| --- | --- |
| On or after 2026-09-01 UTC | Use the committed constant. Run V30 only if a pre-activation fixture still exists. |
| Before 2026-09-01 UTC | Keep the committed constant for V30. For every "fee applies" journey, use a **local uncommitted** override of `SERVICE_FEE_ACTIVATION_UNIX_SECONDS` to `0`. Record the override in the run log. Revert it before any commit. |

There is no production runtime switch. The override is a validation-only local
edit. If a journey is run before activation without the override, a
`pre_activation` outcome is a pass for V30 and a fail for every fee-applies
journey.

Treat the override as a guarded local fault:

1. Record the committed value in `evidence/RUN.md` before changing it.
2. Run V30 before applying the override when the wall clock permits.
3. Keep the override uncommitted and mark it clearly in the source line.
4. Before pausing, handing off, committing, or ending the run, restore the
   committed value.
5. Restart the web process after restoration. If restart cannot complete,
   stop the process and record that it is stopped; do not leave a process
   running with the override loaded.
6. Confirm the source diff no longer contains the override.

### 1.3 Stripe test mode

Use the account already configured in `.env.local`.

| Item | Value |
| --- | --- |
| Success card | `4242 4242 4242 4242` |
| Expiry | Any future month |
| CVC | Any 3 digits |
| ZIP | Any 5 digits |
| Decline card | `4000 0000 0000 0341` (negative payment only; not a fee journey) |

Before V8, V9, and V32, create these Stripe test-mode promotion codes. They are
operator fixtures, not product features:

| Code | Coupon | Restriction |
| --- | --- | --- |
| `VALIDATE20` | 20% off, unrestricted, redeemable on Checkout | None |
| `VALIDATE100` | 100% off, unrestricted | None |
| `VALIDATEKPONLY` | 20% off, `applies_to` = Personal Kilo Pass product only | Must not apply to the fee product |

Never leave `VALIDATEKPONLY` on a live coupon that customers can discover.
Delete it after V32.

If Stripe Tax is enabled on the test account, Checkout totals include tax.
Assert pretax line amounts and assessment columns, not the Checkout grand
total.

#### 1.3.1 Price tax-behavior audit

Before any Kilo Pass journey, retrieve every configured Kilo Pass Price used by
the run. Each Price must have an explicit Stripe `tax_behavior` of `inclusive`
or `exclusive`. `unspecified` is a release blocker: the service-fee code must
fail open because it cannot mirror an unknown product treatment.

```bash
stripe prices retrieve <price_...> \
  | jq '{id,active,product,unit_amount,currency,recurring,tax_behavior}'
```

Audit all monthly and yearly tier Prices, not only the tier selected in V7.
Record the IDs and results in `evidence/v0.md`. A successful local journey with
a replacement Price does not clear the release blocker for configured
production or shared test Prices.

Do not mutate a shared Price merely to make validation pass. If a configured
test Price is `unspecified`, create a disposable test-mode Price only after the
intended explicit tax behavior is known. It must use the same product,
currency, amount, and recurrence. Override only the ignored local environment,
restart the web process, record the original and replacement IDs, and archive
the disposable Price and remove the override after the Kilo Pass journeys.

An unpaid Checkout that exercises the `unspecified` path is diagnostic
evidence only. Expire it, verify no entitlement or payment was created, and
record the expected `missed` assessment separately from accepted journey
evidence.

#### 1.3.2 Kilo Pass payment fingerprints

Kilo Pass has an intentional duplicate-card anti-abuse path. A fresh user is
not sufficient isolation: reusing the same Stripe test-card fingerprint across
V7, V8, V9, or V32 can block the later user, cancel the subscription, and
refund the charge before entitlement issuance.

Assign a different Stripe test payment method to every Kilo Pass buyer. Use
Stripe-documented test methods and verify the resulting
`payment_method_details.card.fingerprint` differs from earlier Kilo Pass
charges. Record only the non-secret test method label and fingerprint in
`evidence/v0.md`; never record real payment data. If duplicate-card protection
fires, preserve the refund/reconciliation evidence, mark the journey
`BLOCKED`, and repeat with a fresh user and a genuinely different fingerprint.
Do not disable anti-abuse logic to force a pass.

### 1.4 Personas

Create fresh fake users for each validation run. Do not reuse leftover Stripe
customers from earlier experiments. V7, V8, V9, and V32 each require a separate
user with no Kilo Pass and a separate payment fingerprint. Add those
supplemental personas to the run log; do not overload `P-PERSONAL` after V7.

| Persona | Fake email pattern | Role |
| --- | --- | --- |
| `P-ADMIN` | `kilo-<user>-<timestamp>@admin.example.com` | Platform admin |
| `P-OWNER` | `kilo-<user>-<timestamp>-owner@example.com` | Org owner / billing |
| `P-MEMBER` | `kilo-<user>-<timestamp>-member@example.com` | Org member, no billing |
| `P-CHILD` | `kilo-<user>-<timestamp>-child@example.com` | Owner of a child org |
| `P-PERSONAL` | `kilo-<user>-<timestamp>-solo@example.com` | No org, personal top-ups |
| `P-V7` | `kilo-<user>-<timestamp>-v7@example.com` | Fresh Personal Kilo Pass buyer |
| `P-V8` | `kilo-<user>-<timestamp>-v8@example.com` | Fresh 20% promo buyer |
| `P-V9` | `kilo-<user>-<timestamp>-v9@example.com` | Fresh 100% promo buyer |
| `P-V32` | `kilo-<user>-<timestamp>-v32@example.com` | Fresh restricted-coupon buyer |

Login:

```text
$BASE/users/sign_in?fakeUser=<email>&callbackPath=<path>
```

Wait until the account-creation spinner finishes. If `/customer-source-survey`
appears, click `Skip`.

Admin bootstrap requires the `@admin.example.com` suffix. A fake
`someone@kilocode.ai` is not an admin.

### 1.5 Organizations

Create from `$BASE/organizations/new` while signed in as `P-OWNER`:

| Org | Name | Purpose |
| --- | --- | --- |
| `ORG-A` | `Fee Validate A <timestamp>` | Fee-paying org |
| `ORG-B` | `Fee Validate B <timestamp>` | Exemption target |
| `ORG-CHILD` | created from `ORG-B` admin hierarchy as a child | Proves exemptions do not inherit |

After creating `ORG-A` and `ORG-B`, invite `P-MEMBER` to `ORG-B` as a member
without billing permission. Create `ORG-CHILD` from
`/admin/organizations/<ORG-B id>` hierarchy controls, then make `P-CHILD` its
owner.

Record each org UUID in the run log. All later SQL uses those IDs.

### 1.6 Historical exemptions and release audits

Browser journeys prove that exemption management and coupon detection work;
they do not populate or clear production release gates.

Before production activation:

1. A platform admin must enter every approved historical organization
   exemption and its reason through the Admin UI. Do not infer exemptions from
   plan, seats, sponsorship, hierarchy, trial state, or a source-controlled
   allowlist.
2. A second operator must verify each current exemption against the approved
   source and confirm that the newest exemption row is the expected state.
   Record the organization IDs, exemption IDs, and verification time without
   copying contract text or unrelated customer data into the evidence pack.
3. Run the read-only Kilo Pass classification audit using the service-fee
   runbook in `kilo-org/on-call` against the release environment.
4. Run the read-only restricted-coupon audit from that runbook. A finding is a
   release blocker. Delete or replace the unsafe coupon and rerun until clean.
5. Never add mutating flags or turn the audit into an implicit cleanup tool.
   Dashboard coupon changes require the audit to be rerun.

Record command names, environment, timestamps, exit status, and redacted
findings in `evidence/RUN.md`. Local `VALIDATEKPONLY` evidence does not satisfy
or replace the live read-only audit.

### 1.7 Database access

```bash
set -a && source .env.local && set +a
psql "$POSTGRES_URL"
```

Do not use port `5432` unless `POSTGRES_URL` says so. A worktree database is
empty until migrated.

Identifying the current actor:

```sql
SELECT id, google_user_email, is_admin
FROM kilocode_users
WHERE google_user_email LIKE 'kilo-%@%'
ORDER BY created_at DESC;
```

---

## 2. Recording and evidence

### 2.1 Video is produced only through the `video-evidence` skill

Every required clip in this file **must** be captured, edited, and validated by
loading and following the `video-evidence` skill. Do not improvise a recording
procedure, and do not treat a raw `agent-browser record` WebM as the final
artifact.

Before any browser command for a clip:

1. Load the `video-evidence` skill and follow it completely. Do not invent a
   shorter recording procedure from this file.
2. From that skill, load the installed agent-browser workflow so commands
   match that version: `agent-browser skills get core --full`.
3. Follow the skill for workspace, shot list, dry-run, capture, inspection,
   edit, technical validation, privacy, and the output contract.

The skill is the source of truth for how video is made. This file only names
which clips exist, what each clip must prove, and what it does not prove.

Non-negotiable mappings from that skill onto this validation run:

- One source take per final clip. Split personas, permissions, and unrelated
  scenarios. A journey that needs an admin action and a customer action is at
  least two clips.
- Dry-run the journey without recording. Record only after selectors, Stripe
  redirect, settlement wait, and final UI are known to work.
- Do not record service startup, seeding, fake login, account or org creation,
  Stripe promo-code setup, SQL, logs, selector repair, or failed attempts.
  Navigate to the ready starting page, then start recording.
- Keep media outside the repository. Use the skill's temporary working
  directory. Do not write raw or final video under `.plans/`, `apps/`, or any
  other repo path unless a later human explicitly asks to commit a specific
  file.
- Final artifact is the skill's validated H.264 MP4 (`yuv420p`, even
  dimensions, `+faststart`), not the raw WebM.
- Stripe test card `4242…` is non-secret test data and may appear. Never record
  real card numbers, auth cookies, `POSTGRES_URL`, webhook secrets, or live
  customer data.
- If a recorded take needed troubleshooting or material intervention, discard
  it, restore state, and record a clean take. Editing must not turn an assisted
  run into apparent success.
- Start a clean take by giving `record start` the ready starting URL. Recorder
  startup may reload the page or close a transient dialog. Refresh the
  accessibility snapshot after recording starts, then open the dialog or
  perform the first action on camera. A coordinate click is acceptable only
  when it targets the same visible control and the reason is documented; all
  subsequent interaction should use refreshed semantic references.
- Use a 1440x1200 viewport for hosted Checkout unless the journey explicitly
  tests another size. If Stripe opens Link, choose `Pay without Link`. Leave
  the optional phone field empty and enter the billing address manually.
- Stripe Checkout conditionally renders controls. Use `check`, not a plain
  click, for the first AI-agent checkbox, refresh the snapshot, then check the
  newly rendered acknowledgment. Refresh references after every conditional
  state change rather than reusing stale refs.
- If Stripe presents a local-currency conversion, select USD when available so
  the source amounts are readable. Stripe API and PostgreSQL minor units remain
  authoritative when the hosted page still shows converted amounts.
- A browser-command timeout during a static redirect or processing wait does
  not prove payment failure. Check the current URL, Stripe Session or invoice,
  assessment state, and final Kilo UI before deciding the outcome.
- Inspect video locally. Use `ffprobe`, full-decode checks, targeted frames,
  scene/freeze analysis, and local OCR. Do not send full-resolution frames or
  contact sheets to the model. If an image is ever necessary, use only a
  targeted low-resolution frame, normally 480 px wide and below about
  1000x800. Keep original-resolution evidence on disk.
- Cuts may remove static setup, redirect, or processing waits, but must preserve
  chronology. Do not reorder events or combine actions from different
  commercial events.
- If cross-origin capture or animation prevents one clip from showing the whole
  result, use complementary clips only when they refer to the same durable
  event. Record the shared Stripe or assessment identity and state exactly what
  each clip proves. Do not imply that either clip alone proves the full journey.
- A failed product outcome may be kept as diagnostic evidence. It still needs
  the skill's output contract and must be labeled `FAIL` or `BLOCKED`, not
  edited into a pass.

Checkout-specific proof points the skill's shot list must include when the
journey charges or omits a fee:

1. Kilo starting page with the purchase control visible.
2. Initiating click (`$100`, `Buy now`, `Enable automatic top up`, and so on).
3. Stripe Checkout or hosted invoice with every relevant line readable,
   including `Service fee (5%)` or its proven absence.
4. Return to Kilo and the user-visible result (credits, subscription, toast,
   exemption state).
5. A reload or revisit when persistence is part of the claim.

State in the shot list what the clip does **not** prove (other accounts,
webhooks, SQL, emails not shown, other orgs).

### 2.2 Evidence pack

Written notes may live in `.plans/service-fees/evidence/<journey-id>.md`.
Video files must not.

```markdown
# <journey-id>
- Started: <ISO-8601>
- Actor emails:
- Org IDs:
- Stripe Checkout / invoice / charge IDs:
- Assessment id / key:
- Result: PASS | FAIL | N/A | BLOCKED
- Notes:

## Video-evidence output record
Paste one skill output contract per clip:

path:
label:
claim:
limits:
source_duration:
final_duration:
size_bytes:
format:
validation:
repository_state: not committed
```

Paste the SQL result and the Stripe line summary into that file. The video
`path` is the absolute path returned by the skill, outside the repository.
Keep diagnostic events, dry runs, and accepted commercial events distinct. A
dry run that proves selectors or a failure path does not become PASS evidence
for a later successful event, even if its Stripe amounts were correct.

### 2.3 Shared browser session names

| Session | Persona |
| --- | --- |
| `sf-admin` | `P-ADMIN` |
| `sf-owner` | `P-OWNER` |
| `sf-member` | `P-MEMBER` |
| `sf-child` | `P-CHILD` |
| `sf-personal` | `P-PERSONAL` |

Reuse a named session across journeys for the same persona so login is not
repeated on camera. Authenticate and land on the starting page **before**
`record start`. Each clip still gets its own raw take and final MP4.

---

## 3. Shared verification helpers

Run these after every payment journey. Values in angle brackets come from that
journey.

### 3.1 Wait for settlement

Do not query immediately after Stripe says paid. The success page polls; the
webhook may still be in flight.

Poll up to 30 s:

```sql
SELECT assessment_key, flow, outcome,
       currency,
       eligible_subtotal_minor, expected_fee_minor, charged_fee_minor,
       settled_product_minor, gross_paid_minor,
       refunded_product_minor, refunded_fee_minor,
       disputed_product_minor, disputed_fee_minor,
       stripe_checkout_session_id, stripe_invoice_id,
       stripe_payment_intent_id, stripe_charge_id,
       failure_code, settled_at, exemption_id
FROM stripe_service_fee_assessments
WHERE kilo_user_id = '<user-id>'
   OR organization_id = '<org-id>'
ORDER BY created_at DESC
LIMIT 5;
```

A journey that expects a charged fee is not settled until `outcome = 'charged'`,
`settled_at IS NOT NULL`, and `stripe_charge_id` or `stripe_invoice_id` is set.

### 3.2 Credits must equal principal

```sql
SELECT id, amount_microdollars, stripe_payment_id, description, created_at
FROM credit_transactions
WHERE kilo_user_id = '<user-id>'
   OR organization_id = '<org-id>'
ORDER BY created_at DESC
LIMIT 5;
```

`amount_microdollars` is principal only. A `$100.00` top-up is `100000000`,
never `105000000`. Join to the assessment with:

```sql
SELECT a.assessment_key, a.settled_product_minor, a.charged_fee_minor,
       a.gross_paid_minor, ct.amount_microdollars,
       ct.stripe_payment_id
FROM stripe_service_fee_assessments a
JOIN credit_transactions ct
  ON ct.stripe_payment_id IN (
    a.stripe_charge_id,
    a.stripe_invoice_id,
    a.stripe_payment_intent_id
  )
WHERE a.id = '<assessment-id>';
```

Expect `ct.amount_microdollars = a.settled_product_minor * 10000` for top-ups
(microdollars vs minor units). Kilo Pass entitlement is not this table; check
the Kilo Pass UI and `kilo_pass` subscription state instead.

### 3.3 Stripe line item

From the assessment's Checkout or invoice ID:

```bash
stripe checkout sessions retrieve <cs_...>
stripe invoices retrieve <in_...>
```

Pass only if there is exactly one line whose description is `Service fee (5%)`
and whose amount equals `charged_fee_minor` after settlement. Exempt,
pre-activation, zero-rounded, and missed events must have **zero** such lines.
Stripe must not show a `$0.00` or "waived" fee line.

### 3.4 Top-up email

Local mail is written under `dev/logs/emails/`, not sent.

```bash
ls -lt dev/logs/emails | head
```

Open the newest HTML for that user. Fee-positive mails must contain rows
labelled `Credits added`, `Service fee (5%)`, and `Total paid`.
Fee-free mails omit the fee row and must not mention exemption, activation, or
failure.

### 3.5 One assessment per commercial event

```sql
SELECT assessment_key, count(*)
FROM stripe_service_fee_assessments
WHERE stripe_checkout_session_id = '<cs_...>'
   OR stripe_invoice_id = '<in_...>'
   OR stripe_payment_intent_id = '<pi_...>'
   OR stripe_charge_id = '<ch_...>'
GROUP BY assessment_key;
```

Expect one row and one key. Related Stripe IDs enrich that row.

### 3.6 Amount cheat sheet

| Principal | Expected fee | Customer pays before tax |
| ---: | ---: | ---: |
| $10.00 | $0.50 | $10.50 |
| $20.00 | $1.00 | $21.00 |
| $49.00 | $2.45 | $51.45 |
| $50.00 | $2.50 | $52.50 |
| $100.00 | $5.00 | $105.00 |
| $500.00 | $25.00 | $525.00 |
| $1,000.00 | $50.00 | $1,050.00 |
| $49.00 with 20% unrestricted coupon | $1.96 collected | $41.16 |
| $49.00 with 100% coupon | $0.00 | $0.00 |
| $0.01 | $0.00; omit line | $0.01 |

`FIRST_TOPUP_BONUS_AMOUNT` is currently `0`. If that changes, credits may
include a bonus; the fee base is still the paid principal, not the bonus.

### 3.7 Post-journey cleanup checkpoint

After every completed, failed, or abandoned payment attempt:

1. Expire every open Checkout Session that will not be paid.
2. Confirm whether Stripe created a payment, invoice, subscription, refund, or
   dispute before retrying. Do not infer failure from the browser alone.
3. Verify no assessment remains `pending`:

```sql
SELECT id, assessment_key, flow, outcome, stripe_checkout_session_id,
       stripe_invoice_id, failure_code, created_at
FROM stripe_service_fee_assessments
WHERE outcome = 'pending'
ORDER BY created_at;
```

4. Record abandoned and diagnostic assessments in the journey notes. Do not
   delete them or count them as the accepted commercial event.
5. Verify a failed Kilo Pass attempt did not leave an active subscription or
   entitlement. If anti-abuse canceled and refunded it, verify both the Stripe
   refund and the assessment's refund columns.
6. Before recording a retry, create a clean commercial event. Do not splice a
   diagnostic take into the accepted clip.

Run database-backed Jest suites sequentially during this validation work.
Concurrent suites can collide on shared test-database names and create false
failures.

---

## 4. Journey index

| ID | Journey | Invariant |
| --- | --- | --- |
| V0 | Fixtures: users, orgs, Stripe promos | Later journeys have clean actors |
| V1 | Personal $100 top-up | Fee $5; credits $100 |
| V2 | Organization $100 top-up | Fee $5; org credits $100 |
| V3 | Personal auto-top-up setup | Initial charge includes fee; credits = principal |
| V4 | Subsequent personal auto-top-up | Off-session invoice has one fee; credits = principal |
| V5 | Organization auto-top-up setup | Same as V3 for the org |
| V6 | Subsequent organization auto-top-up | Same as V4 for the org |
| V7 | Personal Kilo Pass $49 monthly | Recurring product + one-time fee; entitlement unchanged |
| V8 | Personal Kilo Pass + 20% promo | Fee discounted proportionally to $1.96 |
| V9 | Personal Kilo Pass + 100% promo | Charged, zero product, zero fee, not missed |
| V10 | Org Kilo Pass on existing seats | Fee only on Kilo Pass, never seats |
| V11 | Seat increase with org Kilo Pass | Fee only on Kilo Pass proration |
| V12 | Seat-only purchase | No assessment, no fee line |
| V13 | Direct KiloClaw subscribe | N/A — new provisioning deprecated |
| V16 | Admin grants exemption | Reason required; history visible only to admin |
| V17 | Exempt org top-up | No fee line; outcome `exempt`; credits = principal |
| V18 | Member personal top-up while org exempt | Personal fee still charged |
| V19 | Child org top-up while parent exempt | Child is charged |
| V20 | Revoke exemption, then org top-up | New purchase is charged |
| V21 | Non-admin exemption access | Hidden / unauthorized |
| V22 | Customer org surfaces | No exemption fields or copy |
| V23 | Fee-positive top-up email | Credits added, fee, total paid |
| V24 | Fee-free top-up email | Fee row omitted |
| V25 | Billing history vs Stripe invoice | Kilo shows gross; Stripe itemizes fee |
| V26 | Admin revenue dashboard | Product, collected fee, gross, leakage |
| V27 | Admin cancel-and-refund Kilo Pass | Full product + fee refunded |
| V28 | Operator partial refund in Stripe | Assessment follows runbook; no auto-correcting refund |
| V29 | Chargeback then win | Dispute columns set then cleared; outcome stays `charged` |
| V30 | Pre-activation purchase | No fee; outcome `pre_activation` |
| V32 | Product-restricted coupon | Effective rate > 5%; deviation recorded; no corrective charge |
| V33 | Fail-open (local fault) | Payment succeeds; outcome `missed`; Slack attempt |

V13 (new KiloClaw provisioning), V14 (store Kilo Pass), and V15 (manual org
agreement) cannot be performed in this web app. Record them as `N/A` with the
reason. Do not fake them. Existing KiloClaw invoices stay fee-exempt in
classifier tests; do not invent a Checkout.

Acceptance-criteria map from `GOAL.md`:

| Goal criterion | Journeys |
| --- | --- |
| 1 Activation boundary | V30, and any fee-applies journey after the override or after 2026-09-01 |
| 2 Eligible flows | V1–V7, V10 |
| 3 Excluded flows | V12; V13 N/A; V14/V15 N/A |
| 4 Mixed seat + Kilo Pass | V10, V11 |
| 5 Discounts reduce fee; seat discounts do not | V8, V10, V11 |
| 7 Credits use principal | V1–V6, V17 |
| 8 Existing subscriptions after activation | V4, V6, plus a renewal if a test clock is used |
| 9 Exact-org exemption | V16–V22 |
| 10 One assessment across Stripe objects | every payment journey, helper 3.5 |
| 13 Dashboard settled-only | V26 |
| 15 Refunds | V27, V28, V29 |
| 16 Top-up emails | V23, V24 |
| 17 Billing history unchanged | V25 |

---

## 5. Journeys

Each journey uses the same shape: actor, preconditions, browser steps, UI
expect, database expect, supporting Stripe/email expect, video-evidence clips,
pass rule. Every **Video** block is a required `video-evidence` clip list.
Produce those clips only through that skill.

### V0 — Fixtures

**Actor:** operator, then each persona.

**Steps**

1. Confirm section 1.
2. Fake-login each persona. Skip the survey.
3. As `P-OWNER`, create `ORG-A` and `ORG-B` at `/organizations/new`.
4. Invite `P-MEMBER` to `ORG-B`.
5. As `P-ADMIN`, open `/admin/organizations`, open `ORG-B`, create `ORG-CHILD`,
   and assign `P-CHILD`.
6. Create the three Stripe promotion codes in section 1.3.
7. Audit all configured Kilo Pass Price tax behaviors as described in 1.3.1.
8. Create fresh V7, V8, V9, and V32 users. Assign each a different documented
   Stripe test payment method and record the observed fingerprints after use.

**UI expect:** each persona lands on `/profile` or an organization page. Admin
can open `/admin/organizations`.

**Database expect:** all nine persona rows listed in section 1.4 and three
organizations.

**Video:** none. V0 is setup (login, account creation, org seeding, Stripe
promo codes). The `video-evidence` skill forbids recording that work. Note the
IDs and promo codes in `evidence/v0.md` only.

---

### V1 — Personal $100 credit top-up

**Invariant:** customer pays $105 before tax, receives $100 credits, Stripe
shows `Service fee (5%)` $5.00, one `personal_top_up` assessment settles
charged.

**Actor:** `P-PERSONAL`.

**Steps**

1. Sign in as `P-PERSONAL` with `callbackPath=/credits` **before recording**.
2. Start the `video-evidence` take on `/credits` with Buy Credits visible.
3. Click `$100`.
4. On Stripe Checkout, hold until the credit line and `Service fee (5%)`
   `$5.00` are readable, then pay with `4242…`.
5. Wait through `Processing Payment` on `/payments/topup/success`.
6. Land on `/credits?transaction_id=<id>` and hold the success card.

**UI expect**

- Checkout shows principal $100.00 and `Service fee (5%)` $5.00.
- Kilo pre-purchase buttons still show `$100`, not `$105`.
- Success card: `$100.00 in credits added`.
- Current balance increases by $100.00, not $105.00.
- `/invoices` shows a paid row whose displayed total is the gross (at least
  $105.00 before any tax). The row is not itemized.

**Database expect**

| Column | Value |
| --- | --- |
| `flow` | `personal_top_up` |
| `outcome` | `charged` |
| `eligible_subtotal_minor` | `10000` |
| `expected_fee_minor` | `500` |
| `charged_fee_minor` | `500` |
| `settled_product_minor` | `10000` |
| `gross_paid_minor` | `10500` plus tax if present |
| `organization_id` | `NULL` |
| `kilo_user_id` | `P-PERSONAL` |
| `settled_at` | non-null |

Matching `credit_transactions.amount_microdollars = 100000000`.

**Stripe expect:** one fee line, metadata `type=kilo-service-fee`.

**Email:** V23 may reuse this mail.

**Video** (`video-evidence`, one clip)

- label: `V1 personal $100 top-up`
- claim: Checkout shows `$100.00` plus `Service fee (5%)` `$5.00`, and Kilo
  then shows `$100.00 in credits added`.
- limits: Does not prove other amounts, org top-ups, emails, or revenue KPI.

**Pass:** UI credits $100 and DB charged $5. Fail if credits are $105 or Checkout
has no fee line.

---

### V2 — Organization $100 credit top-up

**Invariant:** same economics as V1, owned by `ORG-A`.

**Actor:** `P-OWNER`.

**Steps**

1. Sign in with `callbackPath=/organizations/<ORG-A>`.
2. Click `Buy More Credits` (or open `/organizations/<ORG-A>/payment-details`
   and use the $100 preset).
3. Complete Stripe Checkout. Confirm the fee line before paying.
4. Return to the organization. Balance / toast should show $100, not $105.

**UI expect:** organization balance +$100. Payment history gross includes the
fee. `View` opens the Stripe invoice with the fee line.

**Database expect:** `flow = organization_top_up`, `organization_id = ORG-A`,
`kilo_user_id` may be `P-OWNER`, amounts as V1.

**Video** (`video-evidence`, one clip)

- label: `V2 organization $100 top-up`
- claim: Org Checkout shows the $5.00 fee, and the organization balance rises
  by $100.00.
- limits: Does not prove personal top-ups, exemption, or auto-top-up.

---

### V3 — Personal auto-top-up setup

**Invariant:** enabling auto-top-up performs an immediate verification charge
of the selected principal plus 5%. Credits equal the principal.

**Actor:** `P-PERSONAL` after V1 (already has a Stripe customer).

**Steps**

1. Open `/profile` or `/credits`.
2. Click `Configure automatic top-up`.
3. Leave the default amount `$50` unless the UI forces another listed amount.
4. Click `Enable automatic top up`. If redirected to Stripe, complete Checkout
   and confirm the fee line.
5. Return to `/profile?auto_topup_setup=success` (or equivalent). Reload until
   the toggle shows auto-top-up on.

**UI expect:** auto-top-up enabled. Balance increased by the principal ($50),
not $52.50. Kilo settings still show `$50`, not `$52.50`.

**Database expect**

| Column | Value |
| --- | --- |
| `flow` | `personal_auto_top_up_setup` |
| `outcome` | `charged` |
| `eligible_subtotal_minor` | `5000` |
| `expected_fee_minor` / `charged_fee_minor` | `250` |
| `settled_product_minor` | `5000` |

`auto_top_up_configs` for the user is enabled with `amount_cents = 5000`.

**Video** (`video-evidence`, one clip)

- label: `V3 personal auto-top-up setup`
- claim: Enabling auto-top-up charges principal plus 5%, and the balance rises
  by the principal only.
- limits: Does not prove a later off-session auto-top-up.

---

### V4 — Subsequent personal auto-top-up

**Invariant:** the off-session invoice is Kilo-owned, carries exactly one fee,
and grants principal only. `invoice.created` must not attach a second fee.

**Actor:** `P-ADMIN`, then `P-PERSONAL`.

**Preconditions:** V3 passed. Personal balance is above $5.

**Steps**

1. As `P-ADMIN`, open `/admin/users`, find `P-PERSONAL`, use
   `Grant / Decrement Credits` to reduce purchased balance below $5.00. Use a
   reason `service-fee validation drain`.
2. As `P-PERSONAL`, open `/credits`. Loading balance triggers
   `maybePerformAutoTopUp`.
3. Wait and reload until purchased credits increase by the configured
   principal.

**UI expect:** balance rises by $50 (or the configured amount), not $52.50.
No second Checkout. No error toast.

**Database expect:** a new row, `flow = personal_auto_top_up`, `outcome =
charged`, `stripe_invoice_id` set, `stripe_checkout_session_id` null, amounts
matching the configured principal. Exactly one assessment for that invoice.
`charged_fee_minor` equals `expected_fee_minor`.

**Stripe expect:** invoice has principal item + one `Service fee (5%)` item.
Invoice metadata `type = auto-topup`.

**Video** (`video-evidence`, two clips; split personas)

1. label: `V4 admin drain below auto-top-up threshold`
   claim: Admin decrements the user's purchased credits below $5.00.
   limits: Does not prove the subsequent charge.
2. label: `V4 personal subsequent auto-top-up`
   claim: Reloading `/credits` credits the configured principal, not principal
   plus fee, with no second Checkout.
   limits: Does not prove invoice-line ownership; confirm that in Stripe/SQL.

**Pass:** one fee, principal credits. Fail if two fee items exist or credits
include the fee.

---

### V5 — Organization auto-top-up setup

Same shape as V3 on `/organizations/<ORG-A>/payment-details`.

Default principal is `$500` (`50000` cents) → fee `$25.00`.

`flow = organization_auto_top_up_setup`.

**Video** (`video-evidence`, one clip)

- label: `V5 organization auto-top-up setup`
- claim: Enabling org auto-top-up charges principal plus 5%, and org balance
  rises by the principal only.
- limits: Does not prove a later off-session org auto-top-up.

---

### V6 — Subsequent organization auto-top-up

Same shape as V4. Admin nullifies `ORG-A` credits from
`/admin/organizations/<ORG-A>` (`Confirm Nullification`). As the owner, open
`/organizations/<ORG-A>/app-builder`. Its organization eligibility check reads
the member's organization balance and schedules the off-session auto-top-up.
A plain reload of the organization details or payment-details page does not
exercise that balance boundary and is not a valid trigger.

After the invoice settles, reload `/organizations/<ORG-A>` or payment-details
to confirm the new balance.

`flow = organization_auto_top_up`. Invoice metadata `type = org-auto-topup`.
Exactly one fee item.

**Video** (`video-evidence`, two clips; split personas)

1. label: `V6 admin nullify org credits`
   claim: Admin nullifies `ORG-A` credits.
   limits: Does not prove the subsequent charge.
2. label: `V6 organization subsequent auto-top-up`
   claim: Opening organization App Builder triggers the configured off-session
   top-up, and the organization page then shows the configured principal.
   limits: Does not prove invoice-line ownership; confirm that in Stripe/SQL.

---

### V7 — Personal Kilo Pass, $49 monthly

**Invariant:** Checkout has a recurring Kilo Pass price plus a one-time
`Service fee (5%)` $2.45. Entitlement follows the tier, not $51.45.

**Actor:** a fresh personal user, or `P-PERSONAL` if they have no Kilo Pass.

**Preconditions:** the selected recurring Kilo Pass Price has explicit Stripe
`tax_behavior`. The actor's planned payment fingerprint has not been used by
another Kilo Pass validation buyer.

**Steps**

1. Open `/subscriptions/kilo-pass` or `/profile`.
2. Select the $49 monthly tier. Click `Buy now`.
3. On Stripe Checkout confirm: Kilo Pass $49.00 recurring, `Service fee (5%)`
   $2.45 one-time. Do not enter a promotion code.
4. Pay. Wait on `/payments/kilo-pass/awarding`.
5. Open `/subscriptions/kilo-pass` and confirm the active card.

**UI expect:** Kilo UI still advertises $49. Active subscription is the $49
tier. Credit grant / threshold matches the $49 tier, not $51.45.

**Database expect**

| Column | Value |
| --- | --- |
| `flow` | `personal_kilo_pass` |
| `outcome` | `charged` |
| `eligible_subtotal_minor` | `4900` |
| `expected_fee_minor` | `245` |
| `charged_fee_minor` | `245` |
| `settled_product_minor` | `4900` |

One assessment. Checkout session, subscription invoice, PaymentIntent, and
charge all point at it.

**Video** (`video-evidence`, one clip)

- label: `V7 personal Kilo Pass $49`
- claim: Checkout shows recurring $49.00 plus one-time `Service fee (5%)`
  $2.45, and Kilo activates the $49 tier.
- limits: Does not prove renewals, discounts, or org Kilo Pass.

---

### V8 — Personal Kilo Pass with unrestricted 20% promo

**Invariant:** hosted promotion-code entry remains. Product and fee both drop
20%. Collected fee is $1.96. Outcome stays `charged`. No deviation alert.

**Actor:** a user with no Kilo Pass. Do not reuse V7's user or payment
fingerprint.

**Preconditions:** verify the planned test payment method has a fingerprint
different from V7 and any prior Kilo Pass purchase. If duplicate-card
protection fires, the discount allocation may still be valid supporting
evidence, but V8 is `BLOCKED` until a clean attempt retains the active `$49`
tier entitlement.

**Steps**

1. Repeat V7 through Stripe Checkout.
2. Enter `VALIDATE20`. Apply.
3. Confirm Kilo Pass $39.20, fee $1.96, total $41.16 before tax.
4. Pay and wait for the active subscription.

**UI expect:** Checkout shows the discounted fee. Kilo still grants the $49
tier entitlement, not a discounted entitlement.

**Database expect:** `expected_fee_minor = 245` (list). `charged_fee_minor =
196`. `settled_product_minor = 3920`. `outcome = charged`. No
`service_fee_rate_deviation` in `metadata` / `failure_code`.

**Video** (`video-evidence`, one clip)

- label: `V8 personal Kilo Pass 20% promo`
- claim: Applying `VALIDATE20` shows Kilo Pass $39.20 and fee $1.96 before
  pay, then the $49 tier activates.
- limits: Does not prove restricted coupons or 100% off.

**Fail if:** fee stays $2.45 after the code, or entitlement is reduced, or the
assessment is `missed`.

---

### V9 — Personal Kilo Pass with 100% promo

**Actor:** a fresh user with no Kilo Pass. Do not reuse a V7/V8 user or payment
fingerprint. If Stripe does not collect a payment method for the zero-dollar
subscription, record that provider behavior rather than trying to manufacture
a fingerprint.

**Steps:** same as V8 with `VALIDATE100`. Both lines become $0.00.

**Database expect:** `outcome = charged`, `charged_fee_minor = 0`,
`settled_product_minor = 0`. This is not `missed` and not `zero_rounded`.

**UI expect:** subscription still activates if a 100% coupon is a valid
purchase in Stripe test mode. If Stripe refuses a $0 subscription, record the
provider behavior in `evidence/v9.md` and stop; do not invent a workaround.

**Video** (`video-evidence`, one clip)

- label: `V9 personal Kilo Pass 100% promo`
- claim: Applying `VALIDATE100` zeroes product and fee lines, and the
  assessment is not presented as a failed payment.
- limits: Does not prove Stripe will always accept a $0 subscription.

---

### V10 — Organization Kilo Pass on existing seats

**Invariant:** mixed invoice. Fee base is Kilo Pass only.

**Preconditions:** `ORG-A` has a paid Teams/Enterprise seat subscription from
V12, or buy seats first without asserting V12 if V12 is run later. Prefer
running V12 immediately before this journey on `ORG-A` if it has no seats.

**Actor:** `P-OWNER`.

**Steps**

1. Open `/organizations/<ORG-A>/subscriptions`.
2. Click `Add Kilo Pass`.
3. On `/organizations/<ORG-A>/subscriptions/kilo-pass/setup` choose the lowest
   tier, keep current paid seats, click `Purchase Kilo Pass`.
4. Complete Stripe / `handleNextAction` if shown.
5. Land on `/organizations/<ORG-A>/subscriptions/kilo-pass`.
6. Open the Stripe invoice from org billing history `View`.

**UI expect:** Kilo Pass is active. Invoice total is seats (if present on the
same invoice) + Kilo Pass + 5% of Kilo Pass only. Hosted invoice contains
exactly one `Service fee (5%)` line. That line equals 5% of the Kilo Pass
amount, not 5% of seats.

**Database expect:** `flow = organization_kilo_pass`, `charged_fee_minor =
round_half_up(kilo_pass_subtotal * 5%)`, `settled_product_minor` equals the
Kilo Pass net, not seats.

**Video** (`video-evidence`, two clips if the hosted invoice opens a new
context)

1. label: `V10 org Kilo Pass purchase`
   claim: Purchasing org Kilo Pass succeeds and the product is active.
   limits: Does not by itself prove the fee base excluded seats.
2. label: `V10 org Kilo Pass hosted invoice`
   claim: The hosted invoice has exactly one `Service fee (5%)` line equal to
   5% of Kilo Pass, not of seats.
   limits: Does not prove later capacity changes.

---

### V11 — Seat increase while organization Kilo Pass is attached

**Invariant:** increasing seats prorates both products. Fee applies only to
the Kilo Pass proration.

**Actor:** `P-OWNER` on `ORG-A` after V10.

**Steps**

1. Open `/organizations/<ORG-A>/subscriptions/seats`.
2. Increase paid seats by 1. Confirm. Complete SCA if asked.
3. Open the new invoice.

**UI expect:** success toast `Seats updated successfully!`. Hosted invoice fee
equals 5% of the Kilo Pass proration line(s), not the seat proration.

**Database expect:** new `organization_kilo_pass` assessment.
`settled_product_minor` matches Kilo Pass proration only. Seat-only negative
control: if the Kilo Pass proration nets to less than $0.10, outcome may be
`zero_rounded` and there is no fee line.

**Video** (`video-evidence`, one or two clips if the invoice is a separate
page)

- label: `V11 org seat increase with Kilo Pass`
- claim: Increasing seats succeeds, and the new invoice fee equals 5% of the
  Kilo Pass proration only.
- limits: Does not prove a seat-only subscription.

---

### V12 — Seat-only purchase (excluded)

**Actor:** `P-OWNER` on an org with no Kilo Pass. Use `ORG-B` if `ORG-A` already
has Kilo Pass, or run this before V10 on `ORG-A`.

**Steps**

1. Open `/organizations/<org>/subscriptions`.
2. Choose Teams, monthly, 1 seat. Click `Purchase Teams Plan`.
3. Complete Stripe Checkout.
4. Confirm seats are active.

**UI expect:** Checkout has seat lines only. No `Service fee (5%)`.

**Database expect:** no `stripe_service_fee_assessments` row for the Checkout
session, invoice, PaymentIntent, or charge.

**Video** (`video-evidence`, one clip)

- label: `V12 seat-only purchase`
- claim: Teams seat Checkout has no `Service fee (5%)` line and seats become
  active.
- limits: Does not prove mixed seat + Kilo Pass invoices.

---

### V13 — Direct KiloClaw subscribe (excluded) — N/A

New KiloClaw instance provisioning is deprecated. `/claw` and
`/subscriptions#kiloclaw` tell a fresh user that new instances are unavailable
and that a current subscription is required. There is no PlanSelectionDialog or
Stripe Checkout to inspect.

Record `N/A`. Do not create a leftover instance or point the local stack at a
KiloClaw API to force a Checkout. Classifier tests remain the proof that a
KiloClaw invoice line is not fee-bearing.

---

### V16 — Admin grants an exemption

**Actor:** `P-ADMIN`. Target: `ORG-B`.

**Steps**

1. Open `/admin/organizations`, search `Fee Validate B`, open the record.
2. Find the service-fee card near billing controls. Current state `Fees apply`.
3. Click `Grant exemption`.
4. In the dialog, leave reason blank and try to confirm. Expect validation.
5. Enter reason `Validation grant: contracted prepaid 2026`. Confirm.
6. Confirm current state `Exempt`. History shows the grant, actor, reason, and
   a local-time timestamp.

**UI expect:** reason is required (min 3, max 500). Controls disable while
saving. Escape closes the dialog without saving when cancelled. Layout works
at 375 px; long reasons wrap.

**Database expect**

```sql
SELECT id, is_exempt, reason, changed_by_kilo_user_id, created_at
FROM organization_service_fee_exemptions
WHERE organization_id = '<ORG-B>'
ORDER BY created_at DESC, id DESC;
```

Newest row has `is_exempt = true` and a non-empty reason. No new row in
`organization_audit_logs` exists for this action.

**Video** (`video-evidence`, one clip)

- label: `V16 grant organization exemption`
- claim: An admin must enter a reason, then the org card shows `Exempt` and
  history lists the grant.
- limits: Does not prove a later purchase is fee-free.

---

### V17 — Exempt organization top-up

**Actor:** `P-OWNER` on `ORG-B` after V16.

**Steps:** repeat V2 against `ORG-B`.

**UI expect:** Checkout has **no** `Service fee (5%)` line. Total is $100
before tax. Org balance +$100.

**Database expect:** `flow = organization_top_up`, `outcome = exempt`,
`expected_fee_minor = 500`, `charged_fee_minor = 0`, `exemption_id` = the V16
exemption row, `settled_at` non-null after
payment. Credits $100.

**Email:** reuse for V24.

**Video** (`video-evidence`, one clip)

- label: `V17 exempt organization top-up`
- claim: Exempt org Checkout has no fee line, and org balance rises by $100.
- limits: Does not prove personal or child-org purchases.

---

### V18 — Member personal purchase while org is exempt

**Actor:** `P-MEMBER`, who belongs to exempt `ORG-B`.

**Steps:** personal $20 top-up from `/credits`. Do not use org purchase.

**UI expect:** Checkout fee $1.00. Personal balance +$20.

**Database expect:** `flow = personal_top_up`, `organization_id IS NULL`,
`outcome = charged`, `charged_fee_minor = 100`. No exemption link.

**Video** (`video-evidence`, one clip)

- label: `V18 member personal top-up while org exempt`
- claim: The member's personal Checkout still shows a 5% fee.
- limits: Does not prove org billing for that member.

---

### V19 — Child organization does not inherit exemption

**Actor:** `P-CHILD` on `ORG-CHILD`. Parent `ORG-B` is exempt.

**Steps:** $100 org top-up for `ORG-CHILD`.

**UI expect:** fee $5.00 present.

**Database expect:** `organization_id = ORG-CHILD`, `outcome = charged`,
`exemption_id IS NULL`.

**Video** (`video-evidence`, one clip)

- label: `V19 child org top-up while parent exempt`
- claim: Child-org Checkout shows a $5.00 fee.
- limits: Does not prove parent exemption state beyond this purchase.

---

### V20 — Revoke exemption, then charge

**Actor:** `P-ADMIN`, then `P-OWNER`.

**Steps**

1. Admin opens `ORG-B`, clicks `Revoke exemption`, reason
   `Validation revoke: contract ended`.
2. History shows grant then revoke. Current state `Fees apply`.
3. Owner buys another $100 org top-up for `ORG-B`.

**UI expect:** this Checkout has the $5.00 fee. The earlier V17 invoice is
unchanged.

**Database expect:** second assessment `outcome = charged`, `charged_fee_minor
= 500`. V17 row remains `exempt`. The exemption log has two rows and its
newest row is the revoke row with `is_exempt = false`.

**Video** (`video-evidence`, two clips; split personas)

1. label: `V20 revoke organization exemption`
   claim: Admin revokes with a reason; current state is `Fees apply`.
   limits: Does not prove the next purchase.
2. label: `V20 org top-up after revoke`
   claim: The next `ORG-B` Checkout shows a $5.00 fee.
   limits: Does not prove the earlier V17 invoice changed.

---

### V21 — Non-admin cannot manage exemptions

**Actor:** `P-OWNER`.

**Steps**

1. Open `/admin/organizations/<ORG-B>`. Expect redirect to
   `/admin/unauthorized` or no admin shell.
2. Open `/organizations/<ORG-B>` and `/organizations/<ORG-B>/payment-details`.

**UI expect:** no `Grant exemption`, no `Exempt` / `Fees apply` service-fee
card, no exemption history.

**Database expect:** no new exemption history rows from this actor.

**Video** (`video-evidence`, one clip)

- label: `V21 non-admin exemption hidden`
- claim: A non-admin cannot open the admin exemption controls or see exemption
  copy on customer org pages.
- limits: Does not prove API payload absence; that is the supporting network
  note in V22.

---

### V22 — Customer organization APIs do not expose exemption

**Actor:** `P-OWNER` on `ORG-B` (exempt or not).

**Steps**

1. After login, start the `video-evidence` take on `/organizations/<ORG-B>`.
2. Open org settings, billing, members, and audit log pages.
3. Search the pages for `exempt`, `service fee exemption`, and the V16 reason.

**UI expect:** no matches.

**Supporting check (not a substitute for the browser):** in DevTools network,
org tRPC responses must not contain exemption fields. Note the request names
in `evidence/v22.md`. Do not record DevTools.

**Video** (`video-evidence`, one clip)

- label: `V22 customer org surfaces hide exemption`
- claim: Customer org settings, billing, members, and audit log show no
  exemption copy.
- limits: Does not prove tRPC payload shape; that is the written network note.

---

### V23 — Fee-positive top-up email

**Actor:** operator, using the V1 or V2 mail.

**Steps**

1. Open the newest `dev/logs/emails/*.html` for that purchase in the browser
   **before recording**.
2. Start the `video-evidence` take on that tab and hold the itemized rows.

**UI expect:** rows `Credits added` $100.00, `Service fee (5%)` $5.00, and
`Total paid` $105.00 (plus tax if present).

**Video** (`video-evidence`, one clip)

- label: `V23 fee-positive top-up email`
- claim: The captured top-up email itemizes `Credits added`, `Service fee (5%)`,
  and `Total paid`.
- limits: Does not prove provider delivery; local capture only.

---

### V24 — Fee-free top-up email

Use the V17 mail.

**UI expect:** principal and credits, no `Service fee (5%)` row, no
"exempt" / "waived" / "error" explanation.

**Video** (`video-evidence`, one clip)

- label: `V24 fee-free top-up email`
- claim: The exempt top-up email has no `Service fee (5%)` row and does not
  explain why.
- limits: Does not prove other fee-free reasons (pre-activation, missed).

---

### V25 — Billing history stays coarse; Stripe itemizes

**Actor:** `P-PERSONAL` after V1, and `P-OWNER` after V2.

**Steps**

1. Open `/invoices` (personal) and org `Payment History`.
2. Confirm Kilo shows a single gross amount and status. No fee breakdown.
3. Click `View`. On the Stripe hosted invoice, confirm the fee line.
4. Optionally click `PDF` and confirm the same line.

**Video** (`video-evidence`, two clips if Stripe hosted invoice is a separate
context)

1. label: `V25 Kilo billing history is gross only`
   claim: `/invoices` or org payment history shows a single gross amount with
   no fee breakdown.
   limits: Does not prove Stripe line items.
2. label: `V25 Stripe hosted invoice itemizes the fee`
   claim: `View` opens a Stripe invoice that includes `Service fee (5%)`.
   limits: Does not prove PDF contents unless the PDF is opened in this clip.

---

### V26 — Admin revenue dashboard

**Actor:** `P-ADMIN` after V1, V2, V17, and ideally V8.

**Steps**

1. Open `/admin/revenue`.
2. Set the range to include today. If the dashboard excludes today by default
   ("ends yesterday"), use Custom and include the validation day.
3. Read product revenue, collected service fee, gross, missed, exempted,
   disputed, and counts.
4. Export CSV if the button exists.

**UI expect**

- Product revenue and collected fee are separate.
- Gross ≈ product + collected fee.
- V17 contributes to exempted fee ($5.00) and not to collected fee.
- V1/V2 contribute $5.00 each to collected fee and $100.00 each to product.
- Abandoned / unpaid Checkouts from a cancelled attempt do not appear.
- Empty-state does not crash if you pick a date range with no data. Check that
  by switching to a future-empty custom range, then switch back.

**Database expect:** dashboard figures match

```sql
SELECT
  sum(settled_product_minor - refunded_product_minor - disputed_product_minor)
    AS product_minor,
  sum(charged_fee_minor - refunded_fee_minor - disputed_fee_minor)
    AS collected_fee_minor,
  sum(CASE WHEN outcome = 'missed' THEN expected_fee_minor ELSE 0 END)
    AS missed_fee_minor,
  sum(CASE WHEN outcome = 'exempt' THEN expected_fee_minor ELSE 0 END)
    AS exempt_fee_minor
FROM stripe_service_fee_assessments
WHERE settled_at IS NOT NULL
  AND settled_at::date = CURRENT_DATE;
```

Unpaid rows must not be in those sums.

**Video** (`video-evidence`, one clip)

- label: `V26 admin revenue dashboard`
- claim: The dashboard shows separate product, collected fee, gross, and
  leakage values for the validation day, and an empty range does not crash.
- limits: Does not prove SQL arithmetic beyond what is on screen.

---

### V27 — Admin full cancel-and-refund of Personal Kilo Pass

**Invariant:** existing Kilo-initiated full refund returns product and fee.
No new partial-refund UI is added.

**Actor:** `P-ADMIN`. Target: the V7 user (undiscounted $49 + $2.45).

**Steps**

1. Open `/admin/users/<V7 user>`.
2. On the Kilo Pass card, cancel and refund with a reason
   `service-fee validation full refund`.
3. Confirm the toast includes a refund amount of $51.45 (plus tax if charged).
4. As the customer, reload `/subscriptions/kilo-pass` and `/invoices`.

**UI expect:** subscription cancelled / blocked per existing admin behavior.
Stripe invoice or receipt shows product and fee refunded.

**Database expect:** same assessment, `outcome` remains `charged`,
`refunded_product_minor = 4900`, `refunded_fee_minor = 245`. Refund columns
never decrease after this.

**Video** (`video-evidence`, two clips; split personas)

1. label: `V27 admin cancel and refund Kilo Pass`
   claim: Admin cancel-and-refund reports about $51.45 (plus tax if charged).
   limits: Does not prove the customer UI.
2. label: `V27 customer Kilo Pass after full refund`
   claim: The customer subscription/invoice state reflects the cancellation
   and refund.
   limits: Does not prove partial refunds.

---

### V28 — Operator partial refund in Stripe

**Invariant:** this product does not add a partial-refund Admin UI. An
operator refunds in Stripe. The assessment records what can be allocated and
does not silently issue a second refund.

**Actor:** operator in Stripe Dashboard / CLI, then `P-ADMIN` / customer.

**Preconditions:** a settled V2 charge that has not been refunded.

**Steps**

1. In Stripe test mode, refund **$20.00** of the V2 charge without a credit
   note that allocates lines, unless the runbook says otherwise.
2. Wait for `charge.refunded`.
3. Reload org payment history and `/admin/revenue`.

**Database expect:** follow the operator runbook in `kilo-org/on-call`. If the
refund cannot be allocated to product vs fee, `refund_allocation_unresolved`
is recorded, `refunded_fee_minor` is unchanged, and Stripe shows only the
$20.00 refund the operator created — no second automatic refund.

If the operator instead issues a credit note that refunds $20.00 product and
$1.00 fee, the assessment should show `refunded_product_minor = 2000` and
`refunded_fee_minor = 100`.

**Video** (`video-evidence`, two clips; split Stripe Dashboard vs Kilo)

1. label: `V28 operator partial refund in Stripe`
   claim: The operator issues the documented partial refund.
   limits: Does not prove Kilo assessment state.
2. label: `V28 Kilo after partial refund`
   claim: Org history and revenue reload without a second automatic refund.
   limits: Does not prove every runbook allocation case.

---

### V29 — Chargeback then win

**Actor:** HITL operator in Stripe Dashboard (test mode), then admin in Kilo.
The Stripe CLI cannot attach a dispute to an existing charge. Do not use
`stripe trigger charge.dispute.created` — that creates a new unrelated charge.

**Preconditions:** a settled fee-positive assessment that has not been refunded
or disputed. Prefer a dedicated `$100` personal top-up if V1's user was later
blocked (V27 Nuke Pass). Record the charge id, assessment key, and whether
`/credits` is reachable.

**Steps**

1. In Stripe Dashboard test mode, open the target Payment and create a test
   dispute. Advance it until `charge.dispute.funds_withdrawn` is forwarded.
2. Reload `/credits` if the user is not blocked, and `/admin/revenue` with a
   Custom range that includes the settlement day.
3. Close the dispute in Kilo's favor (Dashboard win / submit evidence so
   status becomes `won` and `charge.dispute.closed` fires).
4. Reload revenue.

**UI expect:** customer credits are not silently increased by the fee. Revenue
collected-fee drops after withdrawal and returns after the win. Product
revenue follows the same pattern.

**Database expect:** after withdrawal, `disputed_product_minor = 10000`,
`disputed_fee_minor = 500`, `outcome = charged`, refund columns unchanged.
After a win, both dispute columns are `0`.

**Video** (`video-evidence`, two or three clips; do not record Stripe helper
setup in the Kilo clip)

1. label: `V29 revenue after funds withdrawn`
   claim: After the dispute withdrawal, collected fee on `/admin/revenue`
   drops for the V1 payment.
   limits: Does not prove the Stripe dispute UI.
2. label: `V29 revenue after dispute won`
   claim: After a win, collected fee is restored and the assessment remains
   charged.
   limits: Does not prove refund-column monotonicity; that is SQL.

---

### V30 — Pre-activation purchase

**Invariant:** a billing object created before `2026-09-01T00:00:00Z` is
fee-free even if it pays later.

**How to run**

- If wall-clock is before activation: **remove** any local activation
  override, then repeat V1.
- If wall-clock is after activation: do not fake this in production data.
  Create one Checkout with a local override of the constant to the future,
  or keep a pre-recorded pre-activation fixture. Document which method was
  used.

**UI expect:** Checkout has no fee line. Credits equal the button amount.

**Database expect:** `outcome = pre_activation`, `expected_fee_minor = 500`
for a $100 top-up,
`charged_fee_minor = 0`, `settled_at` set after pay.

**Video** (`video-evidence`, one clip)

- label: `V30 pre-activation personal top-up`
- claim: Checkout has no fee line, and Kilo credits the button amount.
- limits: Does not prove post-activation behavior.

---

### V32 — Product-restricted coupon (operational defect signature)

**Invariant:** a coupon that discounts only Kilo Pass overcharges relative to
the published 5%. The system does not "fix" the customer. It settles observed
amounts and alerts.

**Actor:** a fresh user. Operator created `VALIDATEKPONLY`. Do not reuse a
V7/V8/V9 user or payment fingerprint.

**Steps**

1. Start Personal Kilo Pass Checkout as in V7.
2. Apply `VALIDATEKPONLY`.
3. Confirm product $39.20 and fee still $2.45 (effective 6.25%).
4. Pay.

**UI expect:** Checkout shows the uneven discount. Kilo grants the normal $49
tier. No extra charge or refund appears later.

**Database expect:** `charged_fee_minor = 245`, `settled_product_minor = 3920`,
`outcome = charged`. Deviation recorded (`service_fee_rate_deviation` in
metadata or the agreed column). No second assessment and no automatic refund.

**Video** (`video-evidence`, one clip)

- label: `V32 product-restricted coupon`
- claim: `VALIDATEKPONLY` discounts Kilo Pass and leaves the fee at $2.45;
  the $49 tier still activates with no later corrective charge.
- limits: Does not prove the Slack deviation alert; note that in SQL/logs.

Delete `VALIDATEKPONLY` after the take.

---

### V33 — Fail open (local fault)

**Invariant:** a fee-domain failure must not block payment.

This is the one journey that may use a local uncommitted fault. Preferred
fault: make `tax.ts` throw during tax-behavior resolution, or point the Price retrieve at an
invalid price, then create a top-up.

**Steps**

1. Introduce the fault. Restart web if needed.
2. Repeat V1.
3. Remove the fault immediately after the take.

**UI expect:** Checkout has **no** fee line. Payment succeeds. Credits $100.

**Database expect:** `outcome = missed`, `expected_fee_minor = 500`,
`charged_fee_minor = 0`, `failure_code = fee_application_failed`,
`settled_at` set after pay.

**Supporting:** Admin Slack attempt is logged. Slack failure, if simulated,
still leaves the payment successful.

**Video** (`video-evidence`, one clip; do not record injecting or reverting
the local fault)

- label: `V33 fail-open top-up`
- claim: With the fee fault in place, Checkout has no fee line, payment
  succeeds, and Kilo credits $100.
- limits: Does not prove Slack delivery or the failure code; those are SQL
  and logs.

If a safe local fault cannot be introduced without risking other journeys,
mark V33 `BLOCKED` and rely on the SPEC webhook tests. Do not skip the note.

---

## 6. Hybrid renewal (optional, recommended before activation)

Existing Personal and org Kilo Pass subscriptions must pick up the fee on the
first invoice created after activation. That invoice is Stripe-owned.

**Mechanism:** Stripe test clock on the V7 or V10 subscription, advance to
renewal, then:

1. Customer opens `/invoices` or org billing history.
2. `View` the renewal invoice.
3. Confirm one `Service fee (5%)` line, `discountable = false` on the invoice
   item, amount = 5% of that invoice's Kilo Pass net.

**Database:** new assessment, `assessment_key = invoice:<id>`, not a second
`checkout:*` row. `charged_fee_minor = expected_fee_minor`.

**Video** (`video-evidence`, one clip; do not record advancing the test clock)

- label: `V-renewal hosted invoice`
- claim: The post-activation renewal invoice shows one `Service fee (5%)`
  line equal to 5% of that invoice's Kilo Pass net.
- limits: Does not prove test-clock setup or pre-activation invoices.

If test clocks are unavailable, schedule this as the first production
activation check in `SPEC.md` Phase 6 rather than inventing a clock in app
code.

---

## 7. Suggested run order

Execute the run in this order so later journeys can reuse state. Produce each
journey's `video-evidence` clips only after that journey's dry-run succeeds:

1. V0 fixtures, including the Kilo Pass Price tax audit and distinct Kilo Pass
   payment-method plan
2. V30 if wall-clock is before activation and the real constant is still set
3. Apply the local activation override if needed and restart the web process
4. V1, V23, V25 (personal path)
5. V3, V4
6. V2, V5, V6
7. V12 then V10 then V11 on `ORG-A`
8. V7, V27
9. V8, V9, V32 on fresh users
10. V16, V17, V24, V18, V19, V20, V21, V22 on `ORG-B` / child / member
11. V13 is N/A (deprecated new KiloClaw provisioning); record the reason
12. V26
13. V28, then V29 with HITL Dashboard access
14. V33 last, because it mutates local code
15. Expire abandoned Checkouts and confirm no assessment remains `pending`
16. Revert any activation override, local Price-ID override, and V33 fault;
    restart or stop the web process so it cannot retain a local mutation
17. Archive disposable Stripe fixtures when no remaining journey needs them
18. Enter and independently verify approved historical exemptions
19. Run the release-environment read-only Kilo Pass classification and
    restricted-coupon audits; all findings must be cleared
20. Optional renewal test clock

Do not parallelize journeys that share an organization or Stripe customer.
Run DB-backed test suites sequentially.

---

## 8. Run log template

Copy to `.plans/service-fees/evidence/RUN.md` at the start of a validation
run.

```markdown
# Service fee validation run

- Date:
- Operator:
- Web base URL:
- Postgres (host/port only, no password):
- Stripe mode: test
- Activation constant used for fee-applies journeys:
- Original activation constant:
- Activation override restored and web process restarted/stopped:
- Activation override committed? no
- Configured Kilo Pass Price tax audit:
- Disposable Price IDs and local overrides, if any:
- Abandoned Checkout Sessions expired:
- Pending assessment count at pause/handoff:
- Historical exemptions entered and independently verified:
- Kilo Pass classification audit environment/time/result:
- Restricted-coupon audit environment/time/result:

## Personas
| Persona | Email | User id |
| --- | --- | --- |
| P-ADMIN |  |  |
| P-OWNER |  |  |
| P-MEMBER |  |  |
| P-CHILD |  |  |
| P-PERSONAL |  |  |
| P-V7 |  |  |
| P-V8 |  |  |
| P-V9 |  |  |
| P-V32 |  |  |

## Kilo Pass test payment methods
| Journey | Non-secret test method label | Observed card fingerprint |
| --- | --- | --- |
| V7 |  |  |
| V8 |  |  |
| V9 |  |  |
| V32 |  |  |

## Organizations
| Org | Name | UUID |
| --- | --- | --- |
| ORG-A |  |  |
| ORG-B |  |  |
| ORG-CHILD |  |  |

## Video workspace
- video-evidence workdir (outside repo):
- repository_state: not committed

## Results
| ID | Result | video-evidence labels | Assessment key | Notes |
| --- | --- | --- | --- | --- |
| V0 |  |  |  |  |
| V1 |  |  |  |  |
| V2 |  |  |  |  |
| V3 |  |  |  |  |
| V4 |  |  |  |  |
| V5 |  |  |  |  |
| V6 |  |  |  |  |
| V7 |  |  |  |  |
| V8 |  |  |  |  |
| V9 |  |  |  |  |
| V10 |  |  |  |  |
| V11 |  |  |  |  |
| V12 |  |  |  |  |
| V13 |  |  |  |  |
| V16 |  |  |  |  |
| V17 |  |  |  |  |
| V18 |  |  |  |  |
| V19 |  |  |  |  |
| V20 |  |  |  |  |
| V21 |  |  |  |  |
| V22 |  |  |  |  |
| V23 |  |  |  |  |
| V24 |  |  |  |  |
| V25 |  |  |  |  |
| V26 |  |  |  |  |
| V27 |  |  |  |  |
| V28 |  |  |  |  |
| V29 |  |  |  |  |
| V30 |  |  |  |  |
| V32 |  |  |  |  |
| V33 |  |  |  |  |
```

A validation run is complete when every row is `PASS`, `N/A` with reason, or
`BLOCKED` with a SPEC-test pointer. Any `FAIL` blocks calling the feature
done, even if automated suites are green.

---

## 9. Implementation notes for later

When the feature exists, drive the browser with `agent-browser` and produce
every required clip by loading and following the `video-evidence` skill. Do
not use Playwright for these journeys, and do not submit a raw WebM or an
in-repo recording as evidence. Current `apps/web/tests/e2e` coverage is
visual/accessibility and does not complete Stripe Checkout.

If a user-visible label in this file is wrong after UI implementation, change
this file. Do not weaken a database assertion to match a product bug.

Do not add a runtime fee kill switch to make validation easier. The only
allowed local mutations are the uncommitted activation override, a documented
ignored local Kilo Pass Price-ID replacement for explicit-tax test fixtures,
and the V33 fault. Revert all of them before commit or handoff. Restart the web
process after reverting; if restart fails, stop it and record that state rather
than leaving a process with stale validation configuration.
