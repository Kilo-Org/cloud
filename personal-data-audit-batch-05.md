# Personal data audit — batch 05

## Scope, date, and sources

- Date: 2026-09-03.
- Scope: `pgTable` declarations **#161–200 inclusive** in `packages/db/src/schema.ts`, from `cloud_agent_feedback` through `model_experiment_variant`: **40 tables and 415 physical columns**. This is one continuation of the remaining PostgreSQL inventory after batches 01/02, not the entire remainder. Every physical column appears once in its table's inventory, in declaration order; JSON members are evidence, not additional columns. Next is **#201 `model_experiment_variant_version`**, at `packages/db/src/schema.ts:9794`.
- Sources: root `AGENTS.md`, `packages/db/AGENTS.md`, batch 02 introduction and representative rows, `packages/db/src/schema.ts:8101–9783`, the helper at `:3160–3163`, and the local type definitions cited below. Root and database package manifests were read before JavaScript verification. Table citations identify declaration starts in this checkout.
- This is a **source-only preliminary audit**, using the broad definition of personal data as **any data about a user**, not merely conventional identifying details. No live rows, secrets, application writers, runtime payloads, deployed database catalogs, or retention/deletion execution were inspected or validated. Source comments describe intended behavior, not verified execution. This is not a legal determination.
- Types describe PostgreSQL columns. `timestamptz` means `timestamp({ withTimezone: true, mode: 'string' })`; `date` uses string mode. `bigint (number mode)` preserves the declared JavaScript representation; there are no decimal precision/scale declarations in this scope. `text[]` is a physical array, whereas JSON annotations containing `[]` remain single `jsonb` columns. `uuid (idPrimaryKeyColumn)` resolves the reused helper to `uuid` at `packages/db/src/schema.ts:3160–3163`. Text after `;` gives the declared TypeScript `$type`, with `or` replacing union separators. Nullability/defaults are omitted. The explicit physical-name argument `text('locale')` at `:9445` is inventoried as `locale`; other names follow their declaration keys. User identifiers are arbitrary text, not necessarily UUIDs.
- `exa_usage_log` is inventoried once under its parent-table schema declaration. The comment at `packages/db/src/schema.ts:9562–9564` describes monthly partitioning on `created_at`; this document does not invent or verify a deployed child-partition inventory.

## Classification legend

| Classification | Meaning |
| --- | --- |
| High | High confidence of direct or indirect personal relevance: user/external/opaque/hashed/encrypted identifiers, user-related financial data, activity, preferences, content, lifecycle timestamps, or staff identity/actions. Confidence, not a sensitivity ranking. |
| Medium | Personal content or natural-person ownership is uncertain: generic diagnostics, unrestricted shared text/JSON, shared credential ownership, or organization-only context requiring further inspection. |
| Other | Genuinely shared configuration/vocabulary or narrow plumbing without independent personal meaning established here. It is not a statement that the enclosing record is safe to publish or can be excluded from privacy handling. |

Row linkage matters. Instance children join `kiloclaw_instances.user_id`; subscription history joins its user-owned subscription; bot sessions join `bot_requests.created_by`; scheduled notifications join targets with `user_id`. Their timestamps, selected software, processing outcomes, and content describe identifiable activity even when technically named. Scheduled actions and stages also record work attributable to `created_by`; their outcome counts are staff-action history, not anonymous analytics. Nullable foreign keys, encryption, tokenization, and absent SQL foreign keys do not establish anonymity.

Organization references remain Medium where they establish organizational context rather than a verified natural-person membership or ownership relationship. User-linked rows remain personal independently of that uncertainty. Shared image/model/content catalogs are distinguished from their use on a particular user's instance/request: a global version or routing weight can be Other, while the version applied to an identifiable instance is High. A catalog's recorded editor and attributable edit time are High without treating every global configuration value as that editor's personal preference. Retry counters and a stage ordinal are narrow plumbing exceptions; personal request outcomes, consumption counters, and callback progress are not automatically Other.

## Local JSON/type evidence

- `recent_messages`: inline `{ role: string; text: string; ts: number }[]` at `packages/db/src/schema.ts:8122` establishes message text, role, and numeric timestamp fields within user-session feedback, not their actual contents or timestamp units.
- `admin_size_override`: untyped `jsonb` at `packages/db/src/schema.ts:8170`; the nearby comment at `:8164–8169` describes `size` (`cpus`, `memory_mb`, optional `cpu_kind`), `reason`, `actorId`, `actorEmail`, and `setAt`. This is comment evidence, not a declared JSON validator. Its user-instance and staff-action context independently supports High.
- `KiloClawGoogleOAuthGrantsBySource`: `packages/db/src/schema.ts:8218–8221` has optional `legacy` and `oauth` string arrays. It records grants for the identifiable connected Google account; no undeclared token/email members are assumed. Connection status and credential-profile unions are at `:8216–8217`.
- Admin audit `metadata` is `Record<string, unknown>` (`packages/db/src/schema.ts:8420`); subscription `before_state` and `after_state` are `Record<string, unknown> or null` (`:8915–8916`). Their user/staff action context establishes personal relevance without claiming specific embedded members.
- `BotRequestStep`: `packages/db/src/schema.ts:9097–9103` declares `stepNumber`, `finishReason`, optional `toolCalls` with `name` and arbitrary `args`, optional `toolResults` with `name` and unknown `result`, and optional usage token counts. Tool inputs/results and activity relate to the requesting user; runtime payloads remain unverified.
- `EncryptedData`: `packages/db/src/schema-types.ts:1214–1218` declares only `iv`, `data`, and `authTag`. The coding-plan inventory's ciphertext is High because keys can be assigned to a user and linked from user subscriptions, not because plaintext was inspected. Unassigned inventory and plaintext ownership require follow-up.
- `CustomLlmMetadata`: `packages/db/src/schema-types.ts:2065–2072` declares `context_length`, `max_completion_tokens`, optional `supports_image_input`, and optional `opencode_settings`. Nested settings at `:2037–2042` contain provider/family/prompt enums and a string-keyed `variants` record; variant values contain optional verbosity and reasoning options (`:2025–2033`). Supporting enums are at `:1983–2023`. There is no declared user prompt body or API credential in this type; arbitrary variant keys and actual stored JSON warrant Medium rather than invented personal members.
- Supporting text annotations were read in `packages/db/src/schema-types.ts:236–353` (provider, plans, subscription/failure states and actions), `:775–916` (coding plans, admin actions, scheduled-action states/channels), and `packages/db/src/kiloclaw-pricing-catalog.ts:4–12` (price versions). Inline status/mode/platform unions appear in their cited table declarations. TypeScript `$type` annotations do not prove runtime validation.

## Table summary

Classification totals: **337 High**, **30 Medium**, **48 Other** (415 columns).

| # | Table | Columns | High | Medium | Other |
| --- | --- | ---: | ---: | ---: | ---: |
| 161 | cloud_agent_feedback | 12 | 11 | 1 | 0 |
| 162 | kiloclaw_instances | 13 | 12 | 1 | 0 |
| 163 | kiloclaw_google_oauth_connections | 18 | 17 | 1 | 0 |
| 164 | kiloclaw_inbound_email_reserved_aliases | 2 | 0 | 2 | 0 |
| 165 | kiloclaw_inbound_email_aliases | 4 | 4 | 0 | 0 |
| 166 | kiloclaw_morning_briefing_configs | 7 | 7 | 0 | 0 |
| 167 | kiloclaw_admin_audit_logs | 9 | 9 | 0 | 0 |
| 168 | kiloclaw_access_codes | 7 | 7 | 0 | 0 |
| 169 | kiloclaw_image_catalog | 14 | 2 | 1 | 11 |
| 170 | discord_gateway_listener | 4 | 0 | 0 | 4 |
| 171 | kiloclaw_version_pins | 7 | 7 | 0 | 0 |
| 172 | kiloclaw_scheduled_actions | 18 | 18 | 0 | 0 |
| 173 | kiloclaw_scheduled_action_stages | 11 | 10 | 0 | 1 |
| 174 | kiloclaw_scheduled_action_targets | 11 | 10 | 1 | 0 |
| 175 | kiloclaw_scheduled_action_notifications | 8 | 7 | 1 | 0 |
| 176 | kiloclaw_earlybird_purchases | 6 | 6 | 0 | 0 |
| 177 | kiloclaw_subscriptions | 30 | 29 | 0 | 1 |
| 178 | kiloclaw_subscription_change_log | 9 | 9 | 0 | 0 |
| 179 | kiloclaw_terminal_renewal_failures | 15 | 13 | 1 | 1 |
| 180 | kiloclaw_email_log | 6 | 6 | 0 | 0 |
| 181 | transactional_email_log | 6 | 5 | 1 | 0 |
| 182 | bot_requests | 16 | 14 | 2 | 0 |
| 183 | app_min_versions | 4 | 0 | 0 | 4 |
| 184 | bot_request_cloud_agent_sessions | 19 | 17 | 2 | 0 |
| 185 | kiloclaw_cli_runs | 10 | 10 | 0 | 0 |
| 186 | coding_plan_key_inventory | 16 | 14 | 1 | 1 |
| 187 | coding_plan_subscriptions | 20 | 20 | 0 | 0 |
| 188 | coding_plan_terms | 11 | 11 | 0 | 0 |
| 189 | coding_plan_availability_intents | 4 | 4 | 0 | 0 |
| 190 | user_push_tokens | 8 | 8 | 0 | 0 |
| 191 | user_activity_tokens | 8 | 7 | 1 | 0 |
| 192 | user_notification_preferences | 11 | 11 | 0 | 0 |
| 193 | exa_monthly_usage | 9 | 8 | 1 | 0 |
| 194 | exa_usage_log | 9 | 8 | 1 | 0 |
| 195 | security_advisor_scans | 12 | 11 | 1 | 0 |
| 196 | security_advisor_check_catalog | 8 | 0 | 2 | 6 |
| 197 | security_advisor_kiloclaw_coverage | 8 | 0 | 3 | 5 |
| 198 | security_advisor_content | 7 | 0 | 2 | 5 |
| 199 | model_experiment | 12 | 5 | 3 | 4 |
| 200 | model_experiment_variant | 6 | 0 | 1 | 5 |
| | **Total** | **415** | **337** | **30** | **48** |

## 161. cloud_agent_feedback

Source: `packages/db/src/schema.ts:8101`.
Purpose: feedback and recent conversation context for a user's cloud-agent session; a nulled user reference does not remove session/content linkage.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of user-session feedback. |
| `kilo_user_id` | text | High | Identifies the feedback author. |
| `cloud_agent_session_id` | text | High | Correlates feedback with a user's session. |
| `session_type` | text | High | Kind of session used by this user. |
| `organization_id` | uuid | Medium | Organization context; personal membership/ownership unverified. |
| `model` | text | High | Model used in the user's session. |
| `repository` | text | High | Repository associated with the user's work; may also encode owner identity. |
| `is_streaming` | boolean | High | State of the user's session when feedback was recorded. |
| `message_count` | integer | High | User-session activity volume. |
| `feedback_text` | text | High | User-authored feedback content. |
| `recent_messages` | jsonb; { role: string; text: string; ts: number }[] | High | User-session messages with declared role, text, and timestamp fields. |
| `created_at` | timestamptz | High | Time of identifiable feedback activity. |

## 162. kiloclaw_instances

Source: `packages/db/src/schema.ts:8137`.
Purpose: user-linked sandbox instances, optionally organization-owned, including software state and administrative hardware overrides.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Instance identifier joining user-associated child records. |
| `user_id` | text | High | User linked to the instance even when organization-owned. |
| `sandbox_id` | text | High | Sandbox identifier correlatable with the user's environment. |
| `provider` | text; KiloClawProvider | High | Hosting provider used for this user's instance. |
| `organization_id` | uuid | Medium | Organization ownership context; individual relationship requires confirmation. |
| `name` | text | High | Name of the user's environment; may contain identifying text. |
| `inbound_email_enabled` | boolean | High | Email feature preference/state for the user's instance. |
| `inactive_trial_stopped_at` | timestamptz | High | Inactivity-related enforcement time for the user's trial. |
| `created_at` | timestamptz | High | Instance creation activity. |
| `destroyed_at` | timestamptz | High | User-instance destruction marker, not proof of erasure. |
| `tracked_image_tag` | text | High | Software version associated with the user's instance. |
| `instance_type` | text | High | Service/hardware tier of the user's instance. |
| `admin_size_override` | jsonb | High | User-instance override and described staff identity/action metadata; runtime shape unverified. |

## 163. kiloclaw_google_oauth_connections

Source: `packages/db/src/schema.ts:8223`.
Purpose: Google account credentials, grants, and connection lifecycle joined to the instance's user.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a linked account connection. |
| `instance_id` | uuid | High | Joins the connection to a user's instance. |
| `provider` | text | High | Authentication provider connected by this account. |
| `account_email` | text | High | Connected account's email address. |
| `account_subject` | text | High | External account subject identifier. |
| `oauth_client_id` | text | High | OAuth application identifier used by this account connection, even if shared globally. |
| `oauth_client_secret_encrypted` | text | High | Encrypted credential associated with the account connection; encryption is not anonymization. |
| `credential_profile` | text; KiloClawGoogleOAuthCredentialProfile | High | Credential configuration used for this user's connection. |
| `refresh_token_encrypted` | text | High | Encrypted account-specific OAuth token. |
| `scopes` | text[] | High | Permissions granted for the connected account. |
| `grants_by_source` | jsonb; KiloClawGoogleOAuthGrantsBySource | High | Account grant arrays separated by declared legacy/oauth source. |
| `capabilities` | text[] | High | Capabilities enabled on this account connection. |
| `status` | text; KiloClawGoogleOAuthStatus | High | Connected account's authorization state. |
| `last_error` | text | Medium | Diagnostic text may embed personal details; exact content unknown. |
| `last_error_at` | timestamptz | High | Time of failure affecting this user's connection. |
| `connected_at` | timestamptz | High | Account connection activity time. |
| `created_at` | timestamptz | High | Creation time of the user-linked credential record. |
| `updated_at` | timestamptz | High | Update time of the user-linked credential record. |

## 164. kiloclaw_inbound_email_reserved_aliases

Source: `packages/db/src/schema.ts:8284`.
Purpose: reserved inbound-email alias registry without a declared user/instance link; whether reservations are purely vocabulary or protect personal aliases is unresolved.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `alias` | text | Medium | Unrestricted reserved alias may be a person's name/address fragment; reservation rules unverified. |
| `created_at` | timestamptz | Medium | Reservation time may describe a personal alias; ownership is unresolved. |

## 165. kiloclaw_inbound_email_aliases

Source: `packages/db/src/schema.ts:8297`.
Purpose: active and retired inbound-email aliases joined through instances to users.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `alias` | text | High | Address alias identifying a user's instance. |
| `instance_id` | uuid | High | Joins the alias to the instance's user. |
| `created_at` | timestamptz | High | User-linked alias creation time. |
| `retired_at` | timestamptz | High | User-linked alias retirement history. |

## 166. kiloclaw_morning_briefing_configs

Source: `packages/db/src/schema.ts:8346`.
Purpose: instance-linked mirror of briefing preferences; source comments identify plugin configuration outside PostgreSQL as authoritative, not verified here.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `instance_id` | uuid | High | Joins briefing preferences to a user's instance. |
| `enabled` | boolean | High | User's briefing enablement preference/state. |
| `cron` | text | High | Schedule selected for the user's briefing. |
| `timezone` | text | High | User-instance timezone preference, potentially indicating location. |
| `interest_topics` | text[] | High | Explicit interests selected for the user's briefing. |
| `created_at` | timestamptz | High | Time the user's briefing settings were recorded. |
| `updated_at` | timestamptz | High | Update activity for the user's settings mirror. |

## 167. kiloclaw_admin_audit_logs

Source: `packages/db/src/schema.ts:8407`.
Purpose: administrative actions concerning a target user, including staff attribution and contextual data; text identity fields need not have foreign keys to be personal.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of an attributable administrative event. |
| `action` | text; KiloClawAdminAuditAction | High | Action performed concerning the target user. |
| `actor_id` | text | High | Administrative actor identifier. |
| `actor_email` | text | High | Staff/actor email address. |
| `actor_name` | text | High | Staff/actor name. |
| `target_user_id` | text | High | Identifies the affected user. |
| `message` | text | High | Narrative about an action affecting an identifiable user. |
| `metadata` | jsonb; Record<string, unknown> | High | User/staff action context; arbitrary nested contents unverified. |
| `created_at` | timestamptz | High | Time of the attributable action. |

## 168. kiloclaw_access_codes

Source: `packages/db/src/schema.ts:8433`.
Purpose: user-specific one-time browser authentication codes and redemption lifecycle.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user's authentication code record. |
| `code` | text | High | Authentication credential identifying the user's access attempt. |
| `kilo_user_id` | text | High | User to whom the access code belongs. |
| `status` | text; 'active' or 'redeemed' or 'expired' | High | User-specific authentication credential state. |
| `expires_at` | timestamptz | High | Expiry time of the user's credential. |
| `redeemed_at` | timestamptz | High | User's authentication/redemption activity time. |
| `created_at` | timestamptz | High | Access-code issuance time for the user. |

## 169. kiloclaw_image_catalog

Source: `packages/db/src/schema.ts:8462`.
Purpose: shared deployable-image registry and rollout configuration, with separate editor attribution; not an inventory of users running each image.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | Other | Shared software catalog key, not an instance/user identifier. |
| `openclaw_version` | text | Other | Shared software version vocabulary. |
| `variant` | text | Other | Shared image-variant configuration label. |
| `image_tag` | text | Other | Shared image reference; its use on a user's instance is separately High. |
| `image_digest` | text | Other | Digest of a shared software artifact, not a person fingerprint. |
| `status` | text; 'available' or 'disabled' | Other | Global image availability setting. |
| `description` | text | Medium | Free-form catalog description may contain personal/staff references. |
| `updated_by` | text | High | Identifier/name of the recorded catalog editor. |
| `published_at` | timestamptz | Other | Shared artifact publication time; no individual publisher established here. |
| `synced_at` | timestamptz | Other | Shared catalog synchronization time, not user activity. |
| `created_at` | timestamptz | Other | Catalog record creation time without a declared creator. |
| `updated_at` | timestamptz | High | Edit time associated with the recorded editor. |
| `rollout_percent` | integer | Other | Global rollout proportion, not an individual user's assignment. |
| `is_latest` | boolean | Other | Global latest-image selection. |

## 170. discord_gateway_listener

Source: `packages/db/src/schema.ts:8523`.
Purpose: singleton coordination lease for a service listener; no Discord user, message, or thread fields are declared.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | integer | Other | Singleton coordination slot, documented as always 1. |
| `listener_id` | text | Other | Service-listener instance identifier, not a user identifier in the declared design. |
| `started_at` | timestamptz | Other | Service lease start time. |
| `expires_at` | timestamptz | Other | Service lease expiry time. |

## 171. kiloclaw_version_pins

Source: `packages/db/src/schema.ts:8538`.
Purpose: software-version choices for individual instances, attributed to the user or administrator who pinned them.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of an instance-specific pin action. |
| `instance_id` | uuid | High | Joins the pin to a user's instance. |
| `image_tag` | text | High | Software choice applied to this identifiable instance. |
| `pinned_by` | text | High | User or administrator responsible for the pin. |
| `reason` | text | High | Attributed explanation for the instance-specific choice. |
| `created_at` | timestamptz | High | Time of pin creation. |
| `updated_at` | timestamptz | High | Time of update to the user's pin state. |

## 172. kiloclaw_scheduled_actions

Source: `packages/db/src/schema.ts:8573`.
Purpose: staff-attributed scheduled operations with notices and aggregate execution outcomes; targets separately link affected instances/users.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a staff-attributed operation. |
| `action_type` | text; 'scheduled_restart' or 'version_change' | High | Kind of operation scheduled by the recorded actor. |
| `target_image_tag` | text | High | Version selected as part of the actor's scheduled operation. |
| `override_pins` | boolean | High | Actor's decision to override user/instance pin choices. |
| `notice_lead_hours` | integer | High | Notice timing chosen for the attributed operation. |
| `notice_subject` | text | High | Communication content attached to the actor's operation. |
| `notice_body` | text | High | Notice body for affected users, associated with the scheduling actor. |
| `reason` | text | High | Staff-provided rationale/label for the operation. |
| `status` | text; KiloClawScheduledActionStatus | High | State of the staff-attributed operation. |
| `created_by` | text | High | Identifies the scheduling user/administrator. |
| `created_at` | timestamptz | High | Time the actor scheduled the operation. |
| `started_at` | timestamptz | High | Execution time of the attributed operation. |
| `completed_at` | timestamptz | High | Completion time of the attributed operation. |
| `cancelled_at` | timestamptz | High | Cancellation history of the attributed operation. |
| `total_count` | integer | High | Scope of the recorded actor's operation, not an anonymous standalone aggregate. |
| `applied_count` | integer | High | Successful outcomes of the actor-attributed operation. |
| `skipped_count` | integer | High | Skipped outcomes of the actor-attributed operation. |
| `failed_count` | integer | High | Failed outcomes of the actor-attributed operation. |

## 173. kiloclaw_scheduled_action_stages

Source: `packages/db/src/schema.ts:8629`.
Purpose: execution stages joined to an actor-attributed scheduled action and associated user targets.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Correlatable identifier of an attributed operation stage. |
| `scheduled_action_id` | uuid | High | Links the stage to the scheduling actor's operation. |
| `stage_index` | integer | Other | Narrow within-operation ordering ordinal; the enclosing stage remains personal. |
| `scheduled_at` | timestamptz | High | Scheduled execution time for the attributed stage. |
| `status` | text; KiloClawScheduledActionStageStatus | High | Execution state of the actor-attributed stage. |
| `notice_sent_at` | timestamptz | High | Communication history for the stage's affected users. |
| `started_at` | timestamptz | High | Actual start of the attributed stage. |
| `completed_at` | timestamptz | High | Completion time of the attributed stage. |
| `applied_count` | integer | High | Successful outcomes within the actor's operation stage. |
| `skipped_count` | integer | High | Skipped outcomes within the actor's operation stage. |
| `failed_count` | integer | High | Failed outcomes within the actor's operation stage. |

## 174. kiloclaw_scheduled_action_targets

Source: `packages/db/src/schema.ts:8669`.
Purpose: per-user/per-instance execution results of scheduled administrative actions.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user-specific action target. |
| `scheduled_action_id` | uuid | High | Associates the user target with an attributed operation. |
| `stage_id` | uuid | High | Stage association for this user's execution. |
| `instance_id` | uuid | High | Identifies the affected user-linked instance. |
| `source_image_tag` | text | High | Prior software version on the user's instance. |
| `target_image_tag` | text | High | Intended software version on the user's instance. |
| `user_id` | text | High | Identifies the affected user. |
| `applied_at` | timestamptz | High | Time the operation was applied to this user's instance. |
| `status` | text; KiloClawScheduledActionTargetStatus | High | Outcome/state affecting this user target. |
| `skip_reason` | text | High | Explanation of why the user's instance was skipped. |
| `error_message` | text | Medium | Diagnostic text may contain user/environment details; contents unverified. |

## 175. kiloclaw_scheduled_action_notifications

Source: `packages/db/src/schema.ts:8737`.
Purpose: per-target notification delivery records, indirectly user-linked through scheduled-action targets.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user-specific notification. |
| `target_id` | uuid | High | Joins to the affected target's user and instance. |
| `channel` | text; KiloClawScheduledActionNotificationChannel | High | Delivery channel used for this user's notice. |
| `kind` | text; KiloClawScheduledActionNotificationKind | High | Kind of communication concerning this user's scheduled action. |
| `status` | text; KiloClawScheduledActionNotificationStatus | High | Delivery state for this user's notification. |
| `claimed_at` | timestamptz | High | Processing time of the identifiable user's notification. |
| `sent_at` | timestamptz | High | Notification delivery activity time. |
| `error_message` | text | Medium | Delivery diagnostics may embed recipient or provider details; runtime content unknown. |

## 176. kiloclaw_earlybird_purchases

Source: `packages/db/src/schema.ts:8788`.
Purpose: one-time earlybird purchase records keyed to users and external/manual payments.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user's purchase. |
| `user_id` | text | High | Identifies the purchaser. |
| `stripe_charge_id` | text | High | External payment identifier, including when used for idempotency. |
| `manual_payment_id` | text | High | Linkable identifier of the user's manual payment. |
| `amount_cents` | integer | High | Amount paid by the user. |
| `created_at` | timestamptz | High | Purchase record creation time. |

## 177. kiloclaw_subscriptions

Source: `packages/db/src/schema.ts:8805`.
Purpose: user-linked subscription, billing, entitlement, and instance-enforcement lifecycle, including transfer references.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of the user's subscription. |
| `user_id` | text | High | Identifies the subscriber. |
| `stripe_subscription_id` | text | High | External billing subscription identifier. |
| `stripe_schedule_id` | text | High | External billing schedule linked to this subscriber. |
| `transferred_to_subscription_id` | uuid | High | Connects user-subscription transfer history. |
| `instance_id` | uuid | High | Identifies the instance receiving this user's subscription. |
| `access_origin` | text; KiloClawSubscriptionAccessOrigin | High | Origin of the user's entitlement. |
| `payment_source` | text; KiloClawPaymentSource | High | Payment method category used for this subscription. |
| `kiloclaw_price_version` | text; KiloClawPriceVersion | High | Pricing terms applied to this subscriber, not a shared price dictionary. |
| `plan` | text; KiloClawPlan | High | User's subscribed plan. |
| `scheduled_plan` | text; KiloClawScheduledPlan | High | Planned change to the user's subscription. |
| `scheduled_by` | text; KiloClawScheduledBy | High | Whether the user's plan change was automatic or user-selected; not an actor ID. |
| `status` | text; KiloClawSubscriptionStatus | High | User's subscription/payment standing. |
| `cancel_at_period_end` | boolean | High | Cancellation choice/state for this subscriber. |
| `pending_conversion` | boolean | High | Pending conversion state of the user's subscription. |
| `trial_started_at` | timestamptz | High | User's trial start time. |
| `trial_ends_at` | timestamptz | High | User's trial expiry. |
| `current_period_start` | timestamptz | High | Start of the subscriber's billing period. |
| `current_period_end` | timestamptz | High | End of the subscriber's billing period. |
| `credit_renewal_at` | timestamptz | High | User-specific credit renewal schedule. |
| `commit_ends_at` | timestamptz | High | End of the user's financial commitment term. |
| `past_due_since` | timestamptz | High | Start of the user's delinquency state. |
| `suspended_at` | timestamptz | High | User-instance suspension history. |
| `destruction_deadline` | timestamptz | High | Planned enforcement deadline for the user's instance. |
| `auto_resume_requested_at` | timestamptz | High | Time automatic resumption was requested for this user. |
| `auto_resume_retry_after` | timestamptz | High | User-instance recovery processing schedule. |
| `auto_resume_attempt_count` | integer | Other | Narrow retry counter; surrounding subscription lifecycle remains personal. |
| `auto_top_up_triggered_for_period` | timestamptz | High | Billing-period marker for the user's automatic funding attempt. |
| `created_at` | timestamptz | High | Subscription creation activity. |
| `updated_at` | timestamptz | High | Subscription update activity. |

## 178. kiloclaw_subscription_change_log

Source: `packages/db/src/schema.ts:8900`.
Purpose: attributed changes to subscriptions joined to individual subscribers, including before/after snapshots.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a subscriber's change event. |
| `subscription_id` | uuid | High | Joins the change to the subscriber. |
| `created_at` | timestamptz | High | Time the subscription change was recorded. |
| `actor_type` | text; KiloClawSubscriptionChangeActorType | High | Origin of the action affecting the subscriber, including system actions. |
| `actor_id` | text | High | Actor identity/correlation for the change; may be a user or system actor. |
| `action` | text; KiloClawSubscriptionChangeAction | High | Operation performed on the user's subscription. |
| `reason` | text | High | Rationale for the subscriber-specific change. |
| `before_state` | jsonb; Record<string, unknown> or null | High | Prior user-subscription state; arbitrary additional members unverified. |
| `after_state` | jsonb; Record<string, unknown> or null | High | Resulting user-subscription state; arbitrary additional members unverified. |

## 179. kiloclaw_terminal_renewal_failures

Source: `packages/db/src/schema.ts:8953`.
Purpose: unresolved/resolved credit-renewal failures joined to user subscriptions, with operator resolution history.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a subscriber's terminal renewal failure. |
| `subscription_id` | uuid | High | Joins failure history to the subscriber. |
| `renewal_boundary` | timestamptz | High | Specific renewal period affected for this user. |
| `status` | text; KiloClawTerminalRenewalFailureStatus | High | Resolution/enforcement state affecting the subscriber. |
| `attempt_count` | integer | Other | Narrow automated retry counter; subscriber context remains personal. |
| `first_failure_at` | timestamptz | High | Start of the user's renewal failure history. |
| `last_failure_at` | timestamptz | High | Most recent failed processing time for the user's renewal. |
| `last_failure_code` | text; KiloClawTerminalRenewalFailureCode | High | Failure outcome affecting this subscriber's renewal. |
| `last_failure_message` | text | Medium | Diagnostic text may contain personal context; actual contents unverified. |
| `resolution_actor_type` | text; KiloClawTerminalRenewalFailureResolutionActorType | High | Operator/system origin of the subscriber-specific resolution. |
| `resolution_actor_id` | text | High | Identity/correlation of the resolving actor. |
| `resolution_at` | timestamptz | High | Time of resolution affecting the subscriber. |
| `resolution_reason` | text | High | Attributed rationale for the user's renewal resolution. |
| `created_at` | timestamptz | High | Creation time of the user-linked failure record. |
| `updated_at` | timestamptz | High | Update history for the user's renewal failure. |

## 180. kiloclaw_email_log

Source: `packages/db/src/schema.ts:9027`.
Purpose: user/instance email history, including activation-period distinctions used for deduplication.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user-specific email event. |
| `user_id` | text | High | Identifies the email's user. |
| `instance_id` | uuid | High | User-instance context of the email. |
| `email_type` | text | High | Communication category sent to this user. |
| `period_start` | timestamptz | High | User activation-period marker, even when a default epoch is used for other types. |
| `sent_at` | timestamptz | High | Time of recorded communication with the user. |

## 181. transactional_email_log

Source: `packages/db/src/schema.ts:9064`.
Purpose: durable transactional email markers with user or organization ownership; organization-only recipient identity remains unverified.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Correlatable email-event identifier, including user-owned records. |
| `user_id` | text | High | Identifies the user when the email has a user owner. |
| `organization_id` | uuid | Medium | Organization-only ownership does not establish a particular natural-person recipient. |
| `email_type` | text | High | Transactional communication category associated with the user when user-owned. |
| `idempotency_key` | text | High | Linkable identifier of an email/underlying transaction; deduplication does not anonymize it. |
| `sent_at` | timestamptz | High | Time of user-associated transactional communication; organization-only cases need recipient tracing. |

## 182. bot_requests

Source: `packages/db/src/schema.ts:9105`.
Purpose: creator-linked bot messages, external platform correlation, processing steps, and outcomes.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid (idPrimaryKeyColumn) | High | Identifier of the user's bot request. |
| `created_by` | text | High | Identifies the requesting/creating user. |
| `organization_id` | uuid | Medium | Organization context; individual membership/ownership unverified. |
| `platform_integration_id` | uuid | High | Integration used for this identifiable user's request. |
| `platform` | text | High | Platform used by the requesting user. |
| `platform_thread_id` | text | High | External conversation/thread identifier for the user's activity. |
| `platform_message_id` | text | High | External identifier of the user's message. |
| `user_message` | text | High | User-authored message content. |
| `status` | text; BotRequestStatus | High | Outcome/state of the user's bot request. |
| `error_message` | text | Medium | Request diagnostics may embed personal content; exact payload unknown. |
| `model_used` | text | High | Model used for this user's request. |
| `steps` | jsonb; BotRequestStep[] | High | User-request tool inputs/results, outcomes, and token usage per declared local type. |
| `cloud_agent_session_id` | text | High | Correlates the request with a user's cloud-agent session. |
| `response_time_ms` | integer | High | Performance experienced on the identifiable user's request. |
| `created_at` | timestamptz | High | User-request receipt/creation time. |
| `updated_at` | timestamptz | High | Processing update time for the user's request. |

## 183. app_min_versions

Source: `packages/db/src/schema.ts:9153`.
Purpose: shared minimum supported mobile app versions, without user/editor attribution in this declaration.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | Other | Shared application-policy record key. |
| `ios_min_version` | text | Other | Global iOS compatibility requirement. |
| `android_min_version` | text | Other | Global Android compatibility requirement. |
| `updated_at` | timestamptz | Other | Shared configuration freshness, with no recorded personal actor. |

## 184. bot_request_cloud_agent_sessions

Source: `packages/db/src/schema.ts:9175`.
Purpose: cloud-agent executions spawned by user-linked bot requests, including repository context and final results.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid (idPrimaryKeyColumn) | High | Identifier of a user's spawned session record. |
| `bot_request_id` | uuid | High | Joins to the bot request's creating user. |
| `spawn_group_id` | uuid | High | Correlates a group of user-request executions. |
| `cloud_agent_session_id` | text | High | User-linked cloud-agent session identifier. |
| `kilo_session_id` | text | High | Additional user-session correlation identifier. |
| `execution_id` | text | High | Identifier of the user's execution. |
| `status` | text; BotRequestCloudAgentSessionStatus | High | Outcome/state of the user's spawned session. |
| `mode` | text; 'code' or 'ask' | High | Mode used for the user's task. |
| `github_repo` | text | High | Repository associated with the user's work; may contain account identity. |
| `gitlab_project` | text | High | Project associated with the user's work; may contain namespace identity. |
| `callback_step` | integer | High | Progress in this user's callback workflow, not a global protocol constant. |
| `error_message` | text | Medium | Execution diagnostics may contain user/environment details; payload unverified. |
| `final_message` | text | High | Final content produced for the user's task. |
| `final_message_fetched_at` | timestamptz | High | Retrieval activity time for the user's result. |
| `final_message_error` | text | Medium | Retrieval diagnostics may embed personal content; actual contents unverified. |
| `terminal_at` | timestamptz | High | Time the user's execution reached a terminal state. |
| `continuation_started_at` | timestamptz | High | Time processing continued for the user's task. |
| `created_at` | timestamptz | High | Creation time of the user's execution record. |
| `updated_at` | timestamptz | High | Update time of the user's execution record. |

## 185. kiloclaw_cli_runs

Source: `packages/db/src/schema.ts:9234`.
Purpose: user-instance CLI task prompts, output, and results, optionally initiated by an identified administrator.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user-linked CLI run. |
| `user_id` | text | High | Identifies the user whose run is recorded. |
| `instance_id` | uuid | High | Identifies the user's execution environment. |
| `initiated_by_admin_id` | text | High | Identifies the initiating administrator. |
| `prompt` | text | High | Task content associated with the user and possibly authored by staff. |
| `status` | text; KiloClawCliRunStatus | High | Execution state of the user's task. |
| `exit_code` | integer | High | Outcome of this user's CLI execution. |
| `output` | text | High | User-task output; may include further personal or environment content. |
| `started_at` | timestamptz | High | User/staff execution activity time. |
| `completed_at` | timestamptz | High | Completion time of the user's task. |

## 186. coding_plan_key_inventory

Source: `packages/db/src/schema.ts:9267`.
Purpose: assignable provider credentials and revocation lifecycle, linked directly by assignee and indirectly from user subscriptions; unassigned records also exist by design.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Credential identifier linkable to an assignee or user subscription. |
| `plan_id` | text | High | Plan associated with the assignable/user-assigned credential, not a plan dictionary row. |
| `provider_id` | text | High | Provider associated with the user's assignable credential. |
| `upstream_plan_id` | text | High | External plan reference associated with this credential and its assignee. |
| `upstream_usage_id` | text | High | External usage identifier enabling credential/user activity correlation. |
| `encrypted_api_key` | jsonb; EncryptedData | High | Encrypted assignable user credential; wrapper shape does not anonymize the association. |
| `credential_fingerprint` | text | High | Stable credential fingerprint correlatable with the assignee and upstream usage. |
| `status` | text; CodingPlanCredentialStatus | High | Assignment/revocation state of a potentially user-linked credential. |
| `assigned_to_user_id` | text | High | Identifies the credential assignee when populated. |
| `assigned_at` | timestamptz | High | User credential-assignment time. |
| `revocation_requested_at` | timestamptz | High | Revocation request history of a potentially user-assigned credential. |
| `revoked_at` | timestamptz | High | Revocation time for the credential; not proof all copies are erased. |
| `revocation_attempt_count` | integer | Other | Narrow revocation retry counter; credential record remains potentially personal. |
| `last_revocation_error` | text | Medium | Provider diagnostics may include identifying credential/account data; contents unknown. |
| `created_at` | timestamptz | High | Lifecycle time of the credential later linkable to a user; unassigned stock needs separation. |
| `updated_at` | timestamptz | High | Lifecycle updates to a potentially user-linked credential. |

## 187. coding_plan_subscriptions

Source: `packages/db/src/schema.ts:9310`.
Purpose: individual coding-plan subscriptions, installed credentials, charges, renewal, and cancellation state.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of the user's coding-plan subscription. |
| `user_id` | text | High | Identifies the subscriber. |
| `plan_id` | text | High | Coding plan subscribed to by this user. |
| `provider_id` | text | High | Provider selected for this user's subscription. |
| `key_inventory_id` | uuid | High | Links the user to an inventory credential. |
| `installed_byok_key_id` | uuid | High | Links the user to an installed API credential. |
| `status` | text; CodingPlanSubscriptionStatus | High | User's entitlement/payment standing. |
| `cost_microdollars` | bigint (number mode) | High | Cost of the user's subscription. |
| `billing_period_days` | integer | High | Billing duration applied to this user. |
| `current_period_start` | timestamptz | High | Start of the user's billing period. |
| `current_period_end` | timestamptz | High | End of the user's billing period. |
| `credit_renewal_at` | timestamptz | High | User-specific credit renewal schedule. |
| `cancel_at_period_end` | boolean | High | User's cancellation choice/state. |
| `past_due_started_at` | timestamptz | High | Start of the user's delinquency state. |
| `payment_grace_expires_at` | timestamptz | High | Grace-period deadline affecting this subscriber. |
| `auto_top_up_attempted_for_due` | timestamptz | High | Due-period marker of the user's automatic funding attempt. |
| `canceled_at` | timestamptz | High | Subscription cancellation time. |
| `cancellation_reason` | text | High | Reason for ending this user's subscription. |
| `created_at` | timestamptz | High | Subscription creation time. |
| `updated_at` | timestamptz | High | Subscription update history. |

## 188. coding_plan_terms

Source: `packages/db/src/schema.ts:9367`.
Purpose: per-user paid subscription terms joined to subscriptions and credit transactions.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user's financial term. |
| `subscription_id` | uuid | High | Joins the term to the user's subscription. |
| `user_id` | text | High | Identifies the user receiving the term. |
| `plan_id` | text | High | Plan purchased/renewed by this user. |
| `kind` | text; CodingPlanTermKind | High | Activation/extension/renewal activity for the subscriber. |
| `idempotency_key` | text | High | Correlatable identifier of the user's term request/transaction. |
| `period_start` | timestamptz | High | Start of the user's paid term. |
| `period_end` | timestamptz | High | End of the user's paid term. |
| `cost_microdollars` | bigint (number mode) | High | Amount charged for the user's term. |
| `credit_transaction_id` | uuid | High | Joins to the associated financial transaction. |
| `created_at` | timestamptz | High | Financial term creation time. |

## 189. coding_plan_availability_intents

Source: `packages/db/src/schema.ts:9405`.
Purpose: individual users' interest in coding-plan availability.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of the user's availability intent. |
| `user_id` | text | High | Identifies the interested user. |
| `plan_id` | text | High | Plan in which the user expressed interest. |
| `created_at` | timestamptz | High | Time the user's interest was recorded. |

## 190. user_push_tokens

Source: `packages/db/src/schema.ts:9429`.
Purpose: user-specific push delivery endpoints with platform, app version, and locale context.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user's push registration. |
| `user_id` | text | High | Identifies the registered user. |
| `token` | text | High | External device/app delivery token, even if opaque. |
| `platform` | text; 'ios' or 'android' | High | Mobile platform used by this user. |
| `app_version` | text | High | App version at the user's token registration. |
| `locale` | text | High | User/device language-locale preference; explicit physical name is locale. |
| `created_at` | timestamptz | High | Push registration activity time. |
| `updated_at` | timestamptz | High | Update activity for the user's push endpoint. |

## 191. user_activity_tokens

Source: `packages/db/src/schema.ts:9470`.
Purpose: user-linked live-activity and ongoing-notification delivery tokens, distinct from ordinary push tokens.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user's activity-token registration. |
| `user_id` | text | High | Identifies the user associated with the endpoint. |
| `token` | text | High | Opaque external activity-notification delivery identifier. |
| `kind` | text; 'ios_push_to_start' or 'ios_activity' or 'android_ongoing' | High | Activity surface used by this user. |
| `platform` | text; 'ios' or 'android' | High | Platform associated with the user's delivery endpoint. |
| `organization_id` | text | Medium | Organization surface context; individual organizational relationship unverified. |
| `created_at` | timestamptz | High | Activity-token registration time. |
| `updated_at` | timestamptz | High | Update time for the user's activity endpoint. |

## 192. user_notification_preferences

Source: `packages/db/src/schema.ts:9503`.
Purpose: per-user notification opt-ins and lock-screen content preferences; defaults remain user-associated settings.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `user_id` | text | High | Identifies the user whose preferences are stored. |
| `agent_push_enabled` | boolean | High | User's agent-push preference. |
| `chat_messages_enabled` | boolean | High | User's chat-message notification preference. |
| `agent_attention_enabled` | boolean | High | User's agent-attention notification preference. |
| `session_status_enabled` | boolean | High | User's session-status notification preference. |
| `kiloclaw_activity_enabled` | boolean | High | User's KiloClaw activity notification preference. |
| `balance_alerts_enabled` | boolean | High | User's financial-balance alert preference. |
| `security_findings_enabled` | boolean | High | User's security-finding notification preference. |
| `notification_previews` | text; 'generic' or 'full' | High | User's choice about exposing message content in previews. |
| `created_at` | timestamptz | High | Time the user's preference record was created. |
| `updated_at` | timestamptz | High | User preference update history. |

## 193. exa_monthly_usage

Source: `packages/db/src/schema.ts:9532`.
Purpose: monthly cost, charging, and allowance totals keyed by user and optional organization; aggregation is not anonymity while user-keyed.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user's monthly usage record. |
| `kilo_user_id` | text | High | Identifies the user despite no declared SQL foreign key. |
| `organization_id` | uuid | Medium | Organization billing context; individual organizational relationship unverified. |
| `month` | date | High | Month of the identified user's usage. |
| `total_cost_microdollars` | bigint (number mode) | High | Cost incurred by the user's monthly activity. |
| `total_charged_microdollars` | bigint (number mode) | High | Amount charged for the user's monthly activity. |
| `request_count` | integer | High | Volume of the user's requests, not narrow retry plumbing. |
| `free_allowance_microdollars` | bigint (number mode) | High | Free entitlement applied to this user's month. |
| `updated_at` | timestamptz | High | Update time of the user's usage aggregate. |

## 194. exa_usage_log

Source: `packages/db/src/schema.ts:9565`.
Purpose: per-user Exa request audit ledger; parent schema only, described as monthly partitioned on created_at, without deployed child inventory verification.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of the user's request event; part of a composite primary key. |
| `kilo_user_id` | text | High | Identifies the requesting user without requiring a declared foreign key. |
| `organization_id` | uuid | Medium | Organization billing context; personal membership/ownership unverified. |
| `path` | text | High | Endpoint/path used in this user's activity; runtime syntax/content unverified. |
| `cost_microdollars` | bigint (number mode) | High | Financial cost of the user's request. |
| `charged_to_balance` | boolean | High | Charging treatment of this user's request. |
| `feature_id` | text | High | Feature associated with the user's request, not a shared dictionary row. |
| `type` | text | High | Request type recorded for this user's activity. |
| `created_at` | timestamptz | High | User request time, also the declared partition/composite-key time field. |

## 195. security_advisor_scans

Source: `packages/db/src/schema.ts:9592`.
Purpose: user-linked security scan activity, client context, and findings counts for usage/rate limiting; source comments about IP validation were not independently verified.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of the user's scan. |
| `kilo_user_id` | text | High | Identifies the scanned user's activity despite no declared foreign key. |
| `organization_id` | text | Medium | Organization context; natural-person organizational relationship unverified. |
| `source_platform` | text | High | Platform used for this user's scan. |
| `source_method` | text | High | Invocation method used in the user's scan activity. |
| `plugin_version` | text | High | Plugin software context of the user's environment. |
| `openclaw_version` | text | High | Software version associated with this user's scan. |
| `public_ip` | text | High | Client-reported network address; accuracy/validation not established here. |
| `findings_critical` | integer | High | Critical security assessment count for the user's environment. |
| `findings_warn` | integer | High | Warning assessment count for the user's environment. |
| `findings_info` | integer | High | Informational assessment count for the user's environment. |
| `created_at` | timestamptz | High | Time of the user's security scan activity. |

## 196. security_advisor_check_catalog

Source: `packages/db/src/schema.ts:9638`.
Purpose: shared check definitions and explanatory copy, not individual scan results; no editor identifier is declared here.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | Other | Shared check-catalog record key. |
| `check_id` | text | Other | Shared check vocabulary identifier, not a user's finding identifier. |
| `severity` | text | Other | Global check severity configuration, not an individual assessment result. |
| `explanation` | text | Medium | Free-form shared report copy may embed personal examples/references; contents unverified. |
| `risk` | text | Medium | Free-form risk explanation may include personal details; contents unverified. |
| `is_active` | boolean | Other | Global availability of the shared check content. |
| `created_at` | timestamptz | Other | Shared catalog creation time without recorded personal attribution. |
| `updated_at` | timestamptz | Other | Shared content update time without an identified editor in this declaration. |

## 197. security_advisor_kiloclaw_coverage

Source: `packages/db/src/schema.ts:9667`.
Purpose: shared security coverage descriptions and check mappings, not per-user coverage results.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | Other | Shared coverage-content record key. |
| `area` | text | Medium | Unrestricted shared area label may include personal references; vocabulary enforcement unverified. |
| `summary` | text | Medium | Free-form coverage summary may contain identifying examples or names. |
| `detail` | text | Medium | Free-form shared detail may embed personal information. |
| `match_check_ids` | text[] | Other | Mapping to shared check vocabulary, not identified users' findings. |
| `is_active` | boolean | Other | Global coverage-copy enablement. |
| `created_at` | timestamptz | Other | Shared content creation time without personal actor attribution. |
| `updated_at` | timestamptz | Other | Shared content freshness without personal actor attribution. |

## 198. security_advisor_content

Source: `packages/db/src/schema.ts:9692`.
Purpose: shared key/value report and call-to-action copy; not a user report storage table in the declared design.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | Other | Shared content-entry identifier. |
| `key` | text | Other | Shared content lookup key, not a user reference in this design. |
| `value` | text | Medium | Unrestricted shared copy may contain personal content; actual values unverified. |
| `description` | text | Medium | Free-form explanatory text may include staff/person references. |
| `is_active` | boolean | Other | Global content enablement setting. |
| `created_at` | timestamptz | Other | Shared content creation time without identified actor. |
| `updated_at` | timestamptz | Other | Shared content update time without identified actor. |

## 199. model_experiment

Source: `packages/db/src/schema.ts:9722`.
Purpose: shared preview-model experiment configuration with creator attribution and lifecycle; this is not per-user experiment assignment/usage storage.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid (idPrimaryKeyColumn) | Other | Shared experiment configuration identifier; user participation is not stored here. |
| `public_model_id` | text | Other | Shared preview-model routing identifier. |
| `name` | text | Medium | Free-form experiment name may refer to a person; contents unverified. |
| `description` | text | Medium | Shared descriptive text may include staff/person references. |
| `metadata` | jsonb; CustomLlmMetadata | Medium | Declared shared model capabilities/settings, but arbitrary variant keys and runtime JSON need content review. |
| `status` | text | Other | Shared experiment routing/lifecycle setting, not a user's assignment outcome. |
| `is_archived` | boolean | Other | Shared configuration archival state, not user deletion evidence. |
| `created_by_user_id` | text | High | Identifies the experiment's creator. |
| `created_at` | timestamptz | High | Time of the recorded creator's experiment creation. |
| `updated_at` | timestamptz | High | Lifecycle activity on a creator-attributed experiment; later editor identity is not declared. |
| `started_at` | timestamptz | High | Start activity of the creator-attributed experiment, not participant activity. |
| `ended_at` | timestamptz | High | End activity of the creator-attributed experiment, not participant activity. |

## 200. model_experiment_variant

Source: `packages/db/src/schema.ts:9763`.
Purpose: shared experiment variant labels and routing weights; experiment creator linkage does not establish that every variant change was that person's action or a participant assignment.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid (idPrimaryKeyColumn) | Other | Shared variant configuration key, not an individual assignment identifier. |
| `experiment_id` | uuid | Other | Joins shared variant configuration to its experiment; no participant linkage here. |
| `label` | text | Medium | Unrestricted shared variant label may contain names or personal references. |
| `weight` | integer | Other | Global positive routing weight, not a user's selected variant. |
| `created_at` | timestamptz | Other | Shared variant creation time with no variant actor attribution. |
| `updated_at` | timestamptz | Other | Shared variant configuration update time with no variant editor attribution. |

## Material follow-ups and limits

1. **Runtime content and ownership:** trace writers/validators for Medium diagnostics, reserved aliases, shared catalog copy, experiment labels/metadata, and organization-only email ownership. Confirm actual free-text/JSON field restrictions, redaction behavior, and whether shared names/keys ever include identifiers. Review High content for additional third-party personal data in feedback, bot tool arguments/results, CLI prompts/output, administrative notes, and subscription snapshots. Do not assume the local TypeScript shape is enforced on every write.
2. **Credentials and correlation:** establish account ownership and provider-side joins for Google OAuth client/account IDs and encrypted secrets, refresh tokens, inbound aliases, access codes, device/activity tokens, coding-plan credentials/fingerprints, upstream usage IDs, and external payment identifiers. Distinguish unassigned credential inventory from current/historic assignments; nulling an assignee does not erase subscription or upstream links. No credentials or plaintext were read.
3. **Retention and deletion:** determine retention for messages/output, diagnostics, email/audit logs, billing history, retired aliases, revoked credentials, destroyed instances, notification endpoints, and Exa partitions. Inspect actual user deletion/export implementation and tests, including deletion blockers, declared cascades/set-null behavior, and references without SQL foreign keys. A `destroyed_at`, `retired_at`, `revoked_at`, cancellation, or archive marker is not evidence of complete erasure. Assess backups, replicas, analytics copies, historical logs, and lawful retention separately; none were verified here.
4. **Joins and external stores:** follow instance IDs/sandbox IDs into Durable Object state, provider instances/volumes and plugin configuration; source comments identify instance-version/size and briefing mirrors as potentially stale. Trace session/execution/spawn IDs into session services and storage, platform thread/message IDs into bot platforms, delivery markers into email/push systems, and financial identifiers into billing/provider systems. PostgreSQL inventory is not a complete inventory of those stores, and their actual retention/deletion behavior was not inspected.
5. **Shared configuration and attribution:** confirm global-only semantics of listener identifiers, app minimum versions, image artifacts, content keys, and experiment routing fields. Inspect separate audit records before concluding configuration timestamps cannot be attributed to staff. Other classifications apply only to the column's established meaning in this source context and never authorize publishing an entire record.
6. **Partition coverage and continuation:** verify the deployed `exa_usage_log` parent, actual child partitions, and retention/drop policy in a separately authorized catalog/migration review. No child tables were inferred here. The next source declaration is #201 `model_experiment_variant_version`; its columns and subsequent tables are outside this file's scope.

## Source-only verification

- Read-only Node/TypeScript AST verification parsed the source without importing/executing the schema or connecting to PostgreSQL. Result: **PASS, 0 mismatches** for **40 ordered table headings**, **415 ordered physical-column rows**, **40 table source-line citations**, exact physical names, unique per-table column coverage, four-field inventory headers, declared types, and nonempty reasons.
- Type checks resolved **4 `idPrimaryKeyColumn` uses**, **1 explicit physical-name argument** (`locale`), **4 physical text arrays**, and **44 `$type` annotations**. Base-builder totals: **64 uuid**, **180 text** (including the four arrays), **20 boolean**, **25 integer**, **9 jsonb**, **110 timestamp**, **6 bigint**, and **1 date**. All 110 timestamps declare timezone/string mode with no explicit precision; all six bigints use number mode; the date uses string mode. There are **0 decimal precision/scale columns** in this scope.
- All **40 per-table summary rows** and the grand total matched the inventory: **337 High + 30 Medium + 48 Other = 415**. The AST check also confirmed the next declaration as **#201 `model_experiment_variant_version` at line 9794**. These checks validate inventory consistency and confidence-category counts, not the truth of runtime content or legal conclusions.
- Whitespace checks used `git diff --check -- personal-data-audit-batch-05.md` and `git diff --no-index --check -- /dev/null personal-data-audit-batch-05.md` so the newly created, untracked document was covered. No lint, typecheck, application tests, formatter, migration, live-catalog, writer, or deletion verification was run. Only this audit document was written in the repository; no code or other audit files were edited.
