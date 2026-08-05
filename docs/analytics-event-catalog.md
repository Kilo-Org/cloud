# Analytics Event Catalog

Authoritative catalog for the shared analytics event contract
(`packages/app-shared/src/analytics/`, P1-A-07a / DEC-05). The map and its
strict Zod schemas live in `event-map.ts`; this document records the
operational contract: identity, privacy, delivery, retention, deletion, and
the recorded exclusions.

## Scope and authority

- One source of truth for event names and payload shapes:
  `ANALYTICS_EVENT_SCHEMAS` in `packages/app-shared/src/analytics/event-map.ts`.
  The inferred `AnalyticsEventMap` types drive the typed capture helpers in
  the mobile app (`apps/mobile/src/lib/analytics/posthog.ts`) and the web app
  (`apps/web/src/lib/analytics-outbox/capture.ts`) and the durable-outbox
  insert validation (`packages/db`, Wave 2).
- Every object schema is `.strict()`; values are restricted to stable enum
  strings, integer counts, `duration_ms` integers, and booleans. The single
  exception is `app_startup`, a bounded record of numeric timing marks.
- New event names are snake_case. Existing names are grandfathered verbatim in
  `LEGACY_EVENT_NAMES` (frozen, no additions) — the kebab-case KiloClaw
  onboarding names are locked to AppsFlyer dashboards.

## Identity

- `distinct_id` is the user's email, matching the existing cross-platform
  convention: mobile `identifyUser(email)` and the web provider identify by
  email, so one person is not double-counted across platforms.
- `distinct_id` is the identity channel, **not** an event property. The DEC-05
  property deny-list does not apply to it.
- The deterministic outbox `event_uuid` (Wave 2) is event identity for
  at-least-once delivery and deduplication; it is a property carve-out in the
  deny-list predicate because it is identity, not content.

## Privacy deny-list (DEC-05)

Prohibited in analytics payloads (enforced by schema and test): raw prompts,
message content, URLs, repository names, comments, emails, tokens, secrets,
transaction IDs, and resource IDs. The predicate (`privacy.ts`) rejects any
property key named `email`, `url`, `repo`, `prompt`, `content`, `token`,
`secret`, `transaction`, or any key ending in `_id` (except `event_uuid`).
Allowed: stable enum strings, integer counts, `duration_ms` integers, and
booleans.

Two enforcement layers:

- Compile time: the strict object schemas cannot carry a prohibited key.
- Runtime: `captureUncataloged` (mobile, AppsFlyer mirror only) and the
  `app_startup` record payload redact prohibited keys before capture.

## Delivery model

| Phase | Event class | Delivery | Duplication semantics | Owner of truth |
|---|---|---|---|---|
| Accepted | Every non-`*_settled` event | Best-effort: client SDK direct (mobile) or `captureCatalogEvent` after the response (web). No outbox row. | Client SDKs and PostHog deduplicate where supported; best-effort may drop under transport failure. | Authoritative boundary of the underlying action (e.g. UI action, post-commit acceptance). Never an outcome authority. |
| Terminal | `*_settled` events | Durable outbox (Wave 2): insert in the same transaction as the ledger settle, drained by the web cron. | At-least-once. Deterministic `event_uuid` (UUIDv5) dedupes; duplicates possible only in the crash window between send and mark. | The authoritative acceptance boundary per domain (see event table). |

`phase: 'accepted'` events are explicitly best-effort and never insert outbox
rows. Only terminal outcomes get durable delivery. `session_created` fires
after `prepareSession` returns and is cataloged as accepted-phase metadata,
not a terminal outcome.

## Retention and deletion (DEC-01)

- Ledger rows (`operation_ledgers`): expire 30 days after `admitted_at`.
- Outbox rows (`analytics_event_outbox`): delivered rows purge after 7 days,
  terminal-failed after 30 days. The cron purges both and settles expired
  non-terminal ledger rows as `failed` (`expired_unsettled`, no outbox event).
- User deletion: `softDeleteUser` in `apps/web/src/lib/user/index.ts` deletes
  `operation_ledgers` rows by `kilo_user_id` and `analytics_event_outbox`
  rows by `distinct_id` **before** email anonymization (the outbox
  `distinct_id` is the email).
- Events delivered directly by client SDKs (accepted-phase) follow the
  PostHog project retention policy; they carry no PII by schema.

## Event table

Columns: name — owner — business question — authoritative source boundary —
privacy class — delivery. "Best-effort (SDK)" means the mobile PostHog SDK
captures at the client action. "Best-effort (server)" means
`captureCatalogEvent` on the web.

### Existing mobile events (grandfathered names and shapes)

| Event | Owner | Business question | Source boundary | Privacy class | Delivery |
|---|---|---|---|---|---|
| `session_viewed` | Mobile app | Which sessions are opened, and how? | Client: session detail rendered with `via` known | Enums only (`surface`, `via`) | Best-effort (SDK) |
| `message_sent` | Mobile app | How many messages are sent per surface? | Client: send succeeded | Enums only (`surface`) | Best-effort (SDK) |
| `session_created` | Mobile app | How often is a cloud session created? | Client: `prepareSession` returned — accepted-phase metadata, not a terminal outcome | Literal enum (`surface`) | Best-effort (SDK) |
| `permission_responded` | Mobile app | How do users answer permission requests? | Client: response submitted | Enums only (`surface`, `response`) | Best-effort (SDK) |
| `question_answered` | Mobile app | How often do users answer vs skip questions? | Client: answer/reject submitted | Enum + boolean (`surface`, `skipped`) | Best-effort (SDK) |
| `conversation_created` | Mobile app | How often are KiloClaw conversations started? | Client: conversation created | Literal enum (`surface`) | Best-effort (SDK) |
| `instance_action` | Mobile app | Which instance lifecycle actions do users take? | Client: action issued | Enums only (`surface`, `action`) | Best-effort (SDK) |
| `feedback_submitted` | Mobile app | What is the feedback sentiment mix? | Client: feedback submitted | Enum only (`sentiment`) | Best-effort (SDK) |
| `organization_member_invited` | Mobile app | How often are members invited, and to which role? | Client: invite succeeded | Enum only (`role`) | Best-effort (SDK) |
| `kilo_pass_purchase_started` | Mobile app | How often do purchase flows start? | Client: purchase request issued | None (`{}`) | Best-effort (SDK) |
| `kilo_pass_purchase_completed` | Web + mobile | Purchase completion precedent (see Exclusions) | Post-commit acceptance boundary, untouched | None (`{}`) | Best-effort (server, existing call sites) |
| `kilo_pass_purchase_failed` | Mobile app | How often do purchase flows fail? | Client: purchase error | None (`{}`) | Best-effort (SDK) |
| `app_startup` | Mobile app | How long does cold start take per gate? | Client: first launch drain | Record of numeric marks + `outcome` enum; keys runtime-checked against the deny-list | Best-effort (SDK) |

### KiloClaw onboarding events (legacy kebab-case, AppsFlyer-locked)

Names are locked because they feed AppsFlyer dashboards; do not rename.
Captured through the AppsFlyer SDK and mirrored into PostHog via
`captureUncataloged`.

| Event | Owner | Business question | Source boundary | Privacy class | Delivery |
|---|---|---|---|---|---|
| `onboarding-entered` | KiloClaw onboarding | Onboarding starts | Client: onboarding screen | None (`{}`) | AppsFlyer + best-effort mirror |
| `provision-requested` | KiloClaw onboarding | Provision requests | Client: provision issued | None (`{}`) | AppsFlyer + best-effort mirror |
| `provision-succeeded` | KiloClaw onboarding | Successful provisions | Client: provision success | None (`{}`) | AppsFlyer + best-effort mirror |
| `provision-failed` | KiloClaw onboarding | Provision failures by category | Client: provision failure | Enum only (`category`) | AppsFlyer + best-effort mirror |
| `access-required-shown` | KiloClaw onboarding | Access-blocked screens by subcase | Client: access-required UI shown | Enum only (`subcase`) | AppsFlyer + best-effort mirror |
| `completion-reached` | KiloClaw onboarding | Onboarding completion | Client: completion screen | None (`{}`) | AppsFlyer + best-effort mirror |
| `claw_weather_location_selected` | KiloClaw onboarding | Weather location selection | Client: location chosen | None (`{}`) | AppsFlyer + best-effort mirror |
| `claw_weather_location_skipped` | KiloClaw onboarding | Weather location skip | Client: location skipped | None (`{}`) | AppsFlyer + best-effort mirror |

### AppsFlyer mirror

| Event | Owner | Business question | Source boundary | Privacy class | Delivery |
|---|---|---|---|---|---|
| `login` | Auth (mobile) | Login funnel visibility in product analytics | Client: AppsFlyer auth mirror | None (`{}` today; dynamic properties redacted at runtime) | AppsFlyer + best-effort mirror |

### Terminal outcome events (durable outbox, Wave 2)

These are the only events the durable outbox may emit. They carry the DEC-05
base fields (`source`, `surface`, `phase: 'terminal'`, `outcome`) and bounded
metric fields. Emitted at the authoritative acceptance boundary, never at HTTP
receipt.

| Event | Owner | Business question | Source boundary | Privacy class | Delivery |
|---|---|---|---|---|---|
| `session_create_settled` | cloud-agent-next handler | Did cloud session creation settle, and how? | Durable DO registration + initial admission succeeded; allocation-failure stages; takeover reconcile | Enums + counts + `duration_ms` + boolean | Durable outbox |
| `pr_operation_settled` | github-pr-review router | Did the PR operation (merge/review/comment) settle? | GitHub committed response; ambiguity reconciled (or `unresolved`) | Enums + `duration_ms` | Durable outbox |
| `security_command_settled` | security-sync worker + web handler | Did the security command (sync/dismiss) settle? | Command status transition to terminal; pre-acceptance definitive failure | Enums + counts + `duration_ms` | Durable outbox |
| `organization_write_settled` | organization-members router | Did the member role change or removal settle? | Helper's committed transaction; takeover read-back | Enums only | Durable outbox |

## Recorded exclusions

- `kilo_pass_purchase_completed` precedent: post-commit acceptance boundary,
  existing call sites, untouched by the outbox work. Cataloged as accepted
  phase; not an outcome authority.
- Remote (CLI) session creation emits no `session_create_settled` in this
  package: the authoritative boundary is the session-ingest Durable Object,
  which has no Postgres path in scope. Duplicate-admission safety is still
  delivered by the DO `mutationId` dedupe; terminal analytics for remote
  creation is future work.
- `session_created` fires after `prepareSession` returns; it is accepted-phase
  metadata, never a terminal outcome, and is not moved or renamed.
- `app_startup` payload stays a bounded record of numeric timing marks (the
  single record-schema exception); its keys are checked against the deny-list
  at runtime capture.
- `captureUncataloged` (mobile) is sanctioned for the AppsFlyer mirror path
  only (`appsflyer.ts` `trackEvent`, which forwards arbitrary locked funnel
  names). No other caller may use it; it applies consent, generation, and
  privacy redaction.
- KiloClaw component call sites keep calling the typed `captureEvent`; their
  event names have exact map entries and compile unedited. KiloClaw files are
  never edited by the analytics contract.
- `login` is a raw string at the auth call site (AppsFlyer-mirrored); it is
  cataloged with an empty schema because the mirror values are dynamic and
  runtime-redacted.
- `interrupted` and `superseded` outcomes are structurally unused for the
  Security domain in this package; the shared enum reserves them for other
  domains.

## Adding an event

1. Add a snake_case name constant and a strict Zod schema to
   `event-map.ts`; the map and the inferred `AnalyticsEventMap` extend
   automatically.
2. Every new terminal outcome event carries the DEC-05 base fields.
3. Add the row to this catalog with owner, business question, source
   boundary, privacy class, delivery, and duplication semantics.
4. Do not add to `LEGACY_EVENT_NAMES`; it is frozen.
