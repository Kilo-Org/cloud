# Personal data audit — batch 01

## Scope, date, and sources

- Date: 2026-09-03.
- Scope: the first 40 `pgTable` declarations in `packages/db/src/schema.ts`, from `credit_transactions` through `auto_top_up_configs`, inclusive: **40 tables and 545 physical columns**. Each column appears once in its table's inventory; JSON members are clues, not additional physical columns.
- Sources: `AGENTS.md`, `packages/db/AGENTS.md`, `packages/db/src/schema.ts:294–2506`, and the referenced deletion JSON types in `packages/db/src/schema-types.ts:585–623`. Table citations identify declaration starts in this checkout.
- This is a **source-only preliminary audit**, using a broad “any data about a user” interpretation, not a legal finding or live-data inspection. Application writers, runtime payloads, actual external joins, and retention/deletion execution have not been traced or verified.
- Types below describe PostgreSQL schema types. `timestamptz` means `timestamp({ withTimezone: true, mode: 'string' })`; `decimal(p,s)` includes declared precision and scale. `$type` annotations constrain TypeScript, not by themselves runtime JSON contents. Nullability and defaults are omitted; nullable identifiers still merit classification when populated. User IDs are arbitrary `text`, not necessarily UUIDs.

## Classification legend

| Classification | Meaning |
| --- | --- |
| High | High confidence the column identifies or describes a natural person, directly or through a user-specific record: identifiers including hashed, encrypted, opaque, and external identifiers; financial data; preferences; activity, state, and lifecycle timestamps; staff/admin identity and actions. This is confidence of personal relevance, not a sensitivity ranking. |
| Medium | Plausible embedded personal information or uncertain ownership/content: generic free text, diagnostic strings, opaque shared credentials, or organization-only identifiers requiring writer/ownership inspection. It does not mean the enclosing user-linked record is nonpersonal. |
| Other | Genuinely shared configuration or narrow technical plumbing with no independent personal meaning established here. An Other value retained in a personal record remains part of that record; this is not permission to publish it or exclude the whole row from privacy handling. |

Classifications consider row-level linkage, not just column names. A status, product choice, amount, or timestamp on a user-owned record is normally High. A few retry counters, format versions, and part ordinals are Other with explicit context. Organization-only identifiers are Medium where natural-person ownership/membership or sole-trader linkage is not established. Mixed personal/organization tables are conservatively High for fields that clearly describe personal-account cases; this does not assert every organization row concerns a natural person.

For user-linked JSON, High reflects established relevance to the user's transaction, deletion, or activity, not a claim that arbitrary embedded names/emails exist. Additional content remains unverified. Medium free-text/error rows similarly retain the enclosing record's personal linkage while flagging the uncertainty of their content.

## Table summary

Classification totals: **492 High**, **21 Medium**, **32 Other** (545 columns).

| # | Table | Columns |
| --- | --- | ---: |
| 1 | credit_transactions | 16 |
| 2 | credit_campaigns | 12 |
| 3 | kilocode_users | 42 |
| 4 | user_data_exports | 32 |
| 5 | user_data_export_object_deletions | 7 |
| 6 | user_data_export_parts | 5 |
| 7 | user_data_export_outbox | 9 |
| 8 | user_deletion_requests | 17 |
| 9 | user_deletion_steps | 15 |
| 10 | user_deletion_audit_events | 8 |
| 11 | user_deletion_activity | 6 |
| 12 | user_deletion_provider_credentials | 4 |
| 13 | user_affiliate_attributions | 5 |
| 14 | user_affiliate_events | 15 |
| 15 | pending_impact_sale_reversals | 8 |
| 16 | stripe_early_fraud_warning_cases | 23 |
| 17 | stripe_early_fraud_warning_actions | 16 |
| 18 | stripe_dispute_cases | 29 |
| 19 | stripe_dispute_actions | 16 |
| 20 | deleted_user_email_tombstones | 2 |
| 21 | impact_attribution_touches | 25 |
| 22 | impact_advocate_participants | 16 |
| 23 | impact_advocate_registration_attempts | 15 |
| 24 | impact_referrals | 7 |
| 25 | impact_referral_conversions | 12 |
| 26 | impact_referral_reward_decisions | 13 |
| 27 | impact_referral_rewards | 22 |
| 28 | impact_referral_reward_applications | 12 |
| 29 | impact_advocate_reward_redemptions | 15 |
| 30 | impact_conversion_reports | 14 |
| 31 | kilo_pass_subscriptions | 15 |
| 32 | kilo_pass_store_events | 12 |
| 33 | kilo_pass_store_purchases | 16 |
| 34 | kilo_pass_issuances | 8 |
| 35 | kilo_pass_welcome_promo_payment_fingerprint_claims | 4 |
| 36 | kilo_pass_pause_events | 7 |
| 37 | kilo_pass_issuance_items | 8 |
| 38 | kilo_pass_audit_log | 13 |
| 39 | kilo_pass_scheduled_changes | 13 |
| 40 | auto_top_up_configs | 11 |
| | **Total** | **545** |

## 1. credit_transactions

Source: `packages/db/src/schema.ts:312`.
Purpose: credit ledger entries, payment references, and expiration accounting linked to users and optionally organizations.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Linkable identifier of a user's credit transaction. |
| `kilo_user_id` | text | High | User identifier. |
| `amount_microdollars` | bigint | High | User-linked credit amount. |
| `expiration_baseline_microdollars_used` | bigint | High | User usage baseline for credit expiration. |
| `original_baseline_microdollars_used` | bigint | High | Original user usage baseline. |
| `is_free` | boolean | High | Describes the user's credit entitlement. |
| `description` | text | Medium | Unconstrained ledger text may embed personal details; inspect writers. |
| `original_transaction_id` | uuid | High | Links to another user-specific financial record. |
| `stripe_payment_id` | text | High | External payment identifier. |
| `coinbase_credit_block_id` | text | High | External credit/payment reference. |
| `credit_category` | text | High | Category of credits received by this user. |
| `expiry_date` | timestamptz | High | User credit entitlement expiry. |
| `created_at` | timestamptz | High | Time of user-linked ledger activity. |
| `organization_id` | uuid | Medium | Organization reference; natural-person membership/ownership needs confirmation. |
| `created_by_kilo_user_id` | text | High | Identifies the person creating the credit. |
| `check_category_uniqueness` | boolean | Other | Ledger uniqueness-enforcement switch, retained within a personal financial record. |

## 2. credit_campaigns

Source: `packages/db/src/schema.ts:356`.
Purpose: shared credit campaign configuration with creator attribution.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | serial | Other | Shared campaign identifier, not a user-specific record ID. |
| `slug` | text | Medium | Custom campaign label could encode a person despite its format constraint. |
| `credit_category` | text | Medium | Unconstrained campaign category text; inspect whether labels identify people. |
| `amount_microdollars` | integer | Other | Campaign-wide credit amount, not a recipient's transaction. |
| `credit_expiry_hours` | integer | Other | Shared campaign expiry duration. |
| `campaign_ends_at` | timestamptz | Other | Campaign schedule, not a person's activity timestamp. |
| `total_redemptions_allowed` | integer | Other | Shared redemption limit, not individual redemption history. |
| `active` | boolean | Other | Shared campaign availability flag. |
| `description` | text | Medium | Free text could contain names or other personal information. |
| `created_by_kilo_user_id` | text | High | Staff/admin creator identifier. |
| `created_at` | timestamptz | High | Records the identified creator's campaign creation activity. |
| `updated_at` | timestamptz | Medium | Configuration edit time; personal editor attribution is not defined here. |

## 3. kilocode_users

Source: `packages/db/src/schema.ts:400`.
Purpose: user identity, account state, permissions, billing totals, preferences, and acquisition metadata.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | text | High | Primary user identifier; not necessarily a UUID. |
| `google_user_email` | text | High | User email address. |
| `google_user_name` | text | High | User name. |
| `google_user_image_url` | text | High | User profile image reference. |
| `created_at` | timestamptz | High | Account creation time. |
| `updated_at` | timestamptz | High | Account update activity. |
| `hosted_domain` | text | High | Domain associated with this user's identity. |
| `microdollars_used` | bigint | High | User spending/usage total. |
| `kilo_pass_threshold` | bigint | High | User-specific usage threshold for bonus eligibility. |
| `stripe_customer_id` | text | High | External customer identifier. |
| `app_store_account_token` | uuid | High | Account-linked store token/identifier. |
| `is_admin` | boolean | High | User's administrative role. |
| `is_super_admin` | boolean | High | User's elevated administrative role. |
| `can_view_sessions` | boolean | High | User's access permission. |
| `can_manage_credits` | boolean | High | User's credit-management permission. |
| `total_microdollars_acquired` | bigint | High | User's acquired credit total. |
| `next_credit_expiration_at` | timestamptz | High | User's next credit expiry. |
| `has_validation_stytch` | boolean | High | User validation state. |
| `has_validation_novel_card_with_hold` | boolean | High | User payment-validation state. |
| `blocked_reason` | text | High | Assessment/reason about this user's restriction; additional free-text content unverified. |
| `blocked_at` | timestamptz | High | User restriction time. |
| `blocked_by_kilo_user_id` | text | High | Blocking staff/admin identifier. |
| `api_token_pepper` | text | High | Account-specific authentication material; secrecy does not remove personal linkage. |
| `web_session_pepper` | text | High | Account-specific session authentication material. |
| `auto_top_up_enabled` | boolean | High | User's billing preference/state. |
| `is_bot` | boolean | High | Account classification; a bot flag does not establish absence of a human owner. |
| `kiloclaw_early_access` | boolean | High | User's early-access participation/preference. |
| `default_model` | text | High | Deprecated but still declared user model preference. |
| `cohorts` | jsonb; Record<string, number> | High | User cohort assignments; only string keys and numeric values are declared. |
| `completed_welcome_form` | boolean | High | User onboarding activity state. |
| `linkedin_url` | text | High | User's external profile reference. |
| `github_url` | text | High | User's external profile reference. |
| `discord_server_membership_verified_at` | timestamptz | High | User membership verification time. |
| `openrouter_upstream_safety_identifier` | text | High | User-linked upstream safety identifier. |
| `openrouter_downstream_safety_identifier` | text | High | User-linked downstream safety identifier. |
| `vercel_downstream_safety_identifier` | text | High | User-linked downstream safety identifier. |
| `customer_source` | text | High | Acquisition/source information about this user; exact text unverified. |
| `signup_ip` | text | High | User signup network address. |
| `account_deletion_requested_at` | timestamptz | High | User deletion-request activity. |
| `normalized_email` | text | High | Normalized user email. |
| `email_domain` | text | High | Domain derived from this user's email. |
| `personal_account_disabled` | boolean | High | User account availability state. |

## 4. user_data_exports

Source: `packages/db/src/schema.ts:519`.
Purpose: user-requested export control state and object metadata; requester remains a person even for organization exports.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifies a person's export request. |
| `kilo_user_id` | text | High | Requester identifier for both subject types. |
| `subject_type` | text; typed values | High | Records the scope requested by this person. |
| `organization_id` | uuid | Medium | Organization subject identifier; natural-person relationship needs confirmation. |
| `status` | text; typed values | High | State of the person's export request. |
| `schema_version` | integer | Other | Export format version; retained in a personal request record. |
| `snapshot_at` | timestamptz | High | Snapshot boundary for the person's requested export. |
| `current_source` | text | High | Current processing source for this person's export; actual labels unverified. |
| `source_cursor` | jsonb; nullable Record<string, unknown> | Medium | Generic pagination state may embed row IDs or other personal content; no members declared. |
| `multipart_upload_id` | text | High | External identifier linked to the requested export object. |
| `next_part_number` | integer | Other | Multipart sequencing counter retained in a personal request record. |
| `dispatch_generation` | integer | Other | Dispatch coordination counter retained in a personal request record. |
| `lease_token` | uuid | High | Linkable token identifying processing of this export request. |
| `lease_expires_at` | timestamptz | High | Processing lifecycle time for this request. |
| `attempt_count` | integer | Other | Retry plumbing counter retained in a personal request record. |
| `row_count` | bigint | High | Size of the exported subject's data in rows. |
| `size_bytes` | bigint | High | Size of the person's requested data export. |
| `r2_object_key` | text | High | Locator of an export tied to its requester. |
| `r2_etag` | text | High | Object fingerprint/reference linked to that export. |
| `failure_code` | text | High | Failure outcome of this person's request; code vocabulary unverified. |
| `last_error_redacted` | text | Medium | Redacted diagnostic text may retain personal content; redaction not verified. |
| `requested_at` | timestamptz | High | Person's export request time. |
| `started_at` | timestamptz | High | Start of processing the person's request. |
| `completed_at` | timestamptz | High | Completion of the person's request. |
| `expires_at` | timestamptz | High | Availability deadline for this person's export. |
| `email_status` | text; typed values | High | Notification delivery state for the request. |
| `email_attempt_count` | integer | Other | Notification retry counter retained in a personal record. |
| `email_lease_token` | uuid | High | Linkable processing token for this request's notification. |
| `email_lease_expires_at` | timestamptz | High | Lifecycle time of this request's notification. |
| `email_sent_at` | timestamptz | High | Time notification was sent about the request. |
| `created_at` | timestamptz | High | Request record creation activity. |
| `updated_at` | timestamptz | High | Request processing/update activity. |

## 5. user_data_export_object_deletions

Source: `packages/db/src/schema.ts:675`.
Purpose: export-object cleanup work intended to survive owning-row deletion. The source says object keys contain random export IDs, not user identifiers; random IDs can still link to exports while other records or objects exist.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `object_key` | text | High | Export-object locator containing a random export ID; indirect linkage is not anonymity. |
| `multipart_upload_id` | text | High | External identifier of the export upload being removed. |
| `reason` | text; typed values | High | Account deletion or administrative cancellation/replacement of a linkable export. |
| `attempt_count` | integer | Other | Cleanup retry counter retained alongside personal export references. |
| `available_at` | timestamptz | High | Scheduled cleanup time of a linkable personal export. |
| `created_at` | timestamptz | High | Creation time of export deletion work. |
| `updated_at` | timestamptz | High | Cleanup activity time for the linkable export. |

## 6. user_data_export_parts

Source: `packages/db/src/schema.ts:709`.
Purpose: multipart export metadata linked to the export request.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `export_id` | uuid | High | Foreign key to a person's export request. |
| `part_number` | integer | Other | Technical part ordinal; retained in a personal export record and part of its composite key. |
| `etag` | text | High | Fingerprint/reference for part of a linkable export. |
| `size_bytes` | bigint | High | Measures a segment of the person's requested export. |
| `created_at` | timestamptz | High | Export-part creation activity linked to the requester. |

## 7. user_data_export_outbox

Source: `packages/db/src/schema.ts:729`.
Purpose: durable dispatch records for export generation.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Linkable dispatch record for a person's request. |
| `export_id` | uuid | High | Identifies the person's export request. |
| `generation` | integer | Other | Dispatch deduplication counter retained in a personal request record. |
| `operation` | text; literal generate | Other | Fixed plumbing operation; personal linkage remains through export_id. |
| `available_at` | timestamptz | High | Dispatch timing for the person's export. |
| `attempt_count` | integer | Other | Dispatch retry counter retained in a personal request record. |
| `sent_at` | timestamptz | High | Dispatch activity for the person's export. |
| `created_at` | timestamptz | High | Creation of the request's dispatch record. |
| `updated_at` | timestamptz | High | Update activity for the request's dispatch. |

## 8. user_deletion_requests

Source: `packages/db/src/schema.ts:767`.
Purpose: deletion requests, subject resolution, requester identity, and lifecycle state.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | User-specific deletion request identifier. |
| `user_id` | text | High | Deletion subject's user identifier. |
| `status` | text; UserDeletionRequestStatus | High | State of the person's deletion request. |
| `catalog_version` | integer | Other | Shared deletion-catalog version retained in a personal request record. |
| `requested_by_kilo_user_id` | text | High | Requester/staff user identifier. |
| `requested_by_email` | text | High | Requester's email. |
| `target_email` | text | High | Deletion subject's email. |
| `target_email_hmac` | text | High | Pseudonymous email-derived identifier; HMAC is not automatic anonymization. |
| `pylon_ticket_ref` | text | High | External support ticket reference linked to the person. |
| `cloud_subject_resolution` | text; UserDeletionCloudSubjectResolution | High | Identity/account-resolution assessment about the subject. |
| `cloud_subject_proof_ref` | text | High | Evidence reference concerning the subject's identity/account. |
| `preflight_attention_code` | text | High | Request-specific readiness/attention outcome. |
| `created_at` | timestamptz | High | Person's request creation activity. |
| `last_progress_at` | timestamptz | High | Progress of the person's deletion request. |
| `anonymized_at` | timestamptz | High | Recorded anonymization milestone; does not prove actual anonymization. |
| `completed_at` | timestamptz | High | Recorded completion of the person's request. |
| `cancelled_at` | timestamptz | High | Cancellation of the person's request. |

## 9. user_deletion_steps

Source: `packages/db/src/schema.ts:840`; JSON types: `packages/db/src/schema-types.ts:585` and `packages/db/src/schema-types.ts:601`.
Purpose: individual deletion tasks, execution state, progress, and manual evidence.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user-specific deletion task. |
| `request_id` | uuid | High | Links task to the deletion subject/request. |
| `step_key` | text; UserDeletionStepKey | High | Identifies which deletion operation applies to this person. |
| `status` | text; UserDeletionStepStatus | High | Person-specific deletion task outcome/state. |
| `available_at` | timestamptz | High | Scheduling of this person's deletion task. |
| `claim_token` | uuid | High | Linkable execution token for the person's task. |
| `claimed_until` | timestamptz | High | Execution lifecycle time of the person's task. |
| `window_attempt_count` | integer | Other | Retry-window counter retained in a personal deletion record. |
| `lifetime_attempt_count` | integer | Other | Retry plumbing total retained in a personal deletion record. |
| `progress_json` | jsonb; UserDeletionTaskProgress | High | User deletion progress; type includes cursor, encrypted_resource_ids, provider_ref, checkpoint_at, reply_message_id and communication states. Actual values/additional content unverified. |
| `last_error_code` | text | High | Failure outcome for this person's deletion task; vocabulary unverified. |
| `rate_limited_since` | timestamptz | High | Delay history of this person's deletion task. |
| `manual_evidence_json` | jsonb; UserDeletionManualEvidence | High | Declares actor_kilo_user_id and recorded_at, plus reason and evidence strings; free-text contents unverified. |
| `created_at` | timestamptz | High | Creation time of the person's deletion task. |
| `updated_at` | timestamptz | High | Update activity for the person's deletion task. |

## 10. user_deletion_audit_events

Source: `packages/db/src/schema.ts:900`; JSON type: `packages/db/src/schema-types.ts:608`.
Purpose: audit trail of deletion decisions and actions, including pseudonymous subject linkage.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a person-related audit event. |
| `request_id` | uuid | High | Links to the person's deletion request. |
| `event_type` | text; UserDeletionAuditEventType | High | Action/outcome concerning the person's deletion. |
| `actor_kilo_user_id` | text | High | Staff/admin or other acting user identifier. |
| `target_email_hmac` | text | High | Linkable email-derived subject identifier. |
| `subject_key` | text | High | Identifies the audit subject; encoding unverified. |
| `details_json` | jsonb; UserDeletionAuditDetails | High | Person-linked decision details; declared code, catalog_version, step_key, disposition only. String contents unverified. |
| `created_at` | timestamptz | High | Time of an action about the subject and potentially by an identified actor. |

## 11. user_deletion_activity

Source: `packages/db/src/schema.ts:932`; JSON type: `packages/db/src/schema-types.ts:615`.
Purpose: operational activity history for deletion requests.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Linkable activity record for the deletion subject. |
| `request_id` | uuid | High | Links activity to the person's request. |
| `step_key` | text; UserDeletionStepKey | High | Deletion operation applied to this person. |
| `event_type` | text | High | Type of activity on this person's request; vocabulary unverified. |
| `details_json` | jsonb; UserDeletionActivityDetails | High | Request-linked execution details; declares resource_hmac, retry_at, error_code, counts, duration_ms and http_status_class. Additional content unverified. |
| `created_at` | timestamptz | High | Time of deletion activity for the person. |

## 12. user_deletion_provider_credentials

Source: `packages/db/src/schema.ts:955`.
Purpose: provider-scoped deletion-service credentials and last-updater attribution, not per-deletion-subject credentials by schema key.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `provider_scope` | text; UserDeletionProviderScope | Other | Shared integration scope key, not a user identifier. |
| `encrypted_material` | text | Medium | Encrypted credentials may identify a human or only a service account; plaintext structure/ownership undeclared. Always security-sensitive. |
| `updated_at` | timestamptz | High | Credential update activity associated with the recorded updater. |
| `updated_by_kilo_user_id` | text | High | Identifies the staff/admin who updated credentials. |

## 13. user_affiliate_attributions

Source: `packages/db/src/schema.ts:979`.
Purpose: user-to-affiliate-provider tracking attribution.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user's attribution record. |
| `user_id` | text | High | Attributed user identifier. |
| `provider` | text; AffiliateProvider | High | Affiliate-provider association of this user. |
| `tracking_id` | text | High | External tracking identifier linked to the user. |
| `created_at` | timestamptz | High | User attribution creation time. |

## 14. user_affiliate_events

Source: `packages/db/src/schema.ts:1002`; JSON type: `packages/db/src/schema.ts:294`.
Purpose: user affiliate events, financial references, and provider delivery state.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user's affiliate event. |
| `user_id` | text | High | User identifier. |
| `provider` | text; AffiliateProvider | High | Provider involved in this user's event. |
| `event_type` | text; AffiliateEventType | High | Describes the user's affiliate activity. |
| `dedupe_key` | text | High | Linkable identifier of the user's event, even if generated. |
| `parent_event_id` | uuid | High | Links related user affiliate events. |
| `delivery_state` | text; AffiliateEventDeliveryState | High | State of delivery of this user's event. |
| `payload_json` | jsonb; AffiliateEventPayloadJson | High | Declares trackingId, customerId, customerEmailHash, orderId, eventDate and optional payment/dispute references and amounts. Runtime values/additional contents unverified. |
| `stripe_charge_id` | text | High | External charge identifier. |
| `impact_action_id` | text | High | External identifier of a user-linked action. |
| `impact_submission_uri` | text | High | External locator of this user's event submission. |
| `attempt_count` | integer | Other | Delivery retry counter retained in a personal event record. |
| `next_retry_at` | timestamptz | High | Scheduled delivery activity for the user's event. |
| `claimed_at` | timestamptz | High | Processing time of the user's event. |
| `created_at` | timestamptz | High | User affiliate event creation time. |

## 15. pending_impact_sale_reversals

Source: `packages/db/src/schema.ts:1066`.
Purpose: pending affiliate sale reversals keyed by external charge/dispute references; absence of a local user key does not make financial events anonymous.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `stripe_charge_id` | text | High | External payment identifier linkable to a payer. |
| `dispute_id` | text | High | External financial dispute identifier. |
| `amount` | real | High | Amount of the linkable sale reversal. |
| `currency` | text | High | Currency of the linkable financial event. |
| `event_date` | timestamptz | High | Time of the linkable sale reversal. |
| `attempt_count` | integer | Other | Retry counter retained in a personal financial record. |
| `last_attempt_at` | timestamptz | High | Processing activity for the linkable financial event. |
| `created_at` | timestamptz | High | Financial reversal record creation time. |

## 16. stripe_early_fraud_warning_cases

Source: `packages/db/src/schema.ts:1088`.
Purpose: fraud-warning cases, financial owners, and handling milestones. Personal-account cases are clearly personal; organization-only ownership requires confirmation.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Linkable financial/fraud case identifier. |
| `stripe_early_fraud_warning_id` | text | High | External fraud-warning identifier. |
| `stripe_event_id` | text | High | External event linked to a financial subject. |
| `stripe_charge_id` | text | High | External charge identifier. |
| `stripe_payment_intent_id` | text | High | External payment identifier. |
| `stripe_customer_id` | text | High | External customer identifier; organization-only cases need ownership review. |
| `amount_minor_units` | integer | High | Amount associated with the subject's flagged payment. |
| `currency` | text | High | Currency of the subject's flagged payment. |
| `owner_classification` | text; StripeEarlyFraudWarningOwnerClassification | High | Classification of the payment's owner/account relationship. |
| `kilo_user_id` | text | High | User subject identifier. |
| `organization_id` | uuid | Medium | Organization-only identifier; natural-person ownership/membership unverified. |
| `status` | text; StripeEarlyFraudWarningCaseStatus | High | Handling state of the linkable fraud case. |
| `reason` | text | Medium | Unconstrained case text may include personal details; inspect writers. |
| `failure_context` | text | Medium | Diagnostic context may embed personal/provider information. |
| `warning_created_at` | timestamptz | High | Time of warning about the subject's payment. |
| `contained_at` | timestamptz | High | Time of containment action on the subject's case. |
| `processing_started_at` | timestamptz | High | Start of case processing. |
| `completed_at` | timestamptz | High | Completion milestone of the subject's case. |
| `review_required_at` | timestamptz | High | Review escalation milestone concerning the subject. |
| `remediated_at` | timestamptz | High | Remediation milestone concerning the subject. |
| `dismissed_at` | timestamptz | High | Dismissal milestone concerning the subject. |
| `created_at` | timestamptz | High | Linkable case creation time. |
| `updated_at` | timestamptz | High | Linkable case update activity. |

## 17. stripe_early_fraud_warning_actions

Source: `packages/db/src/schema.ts:1166`.
Purpose: individual actions and outcomes for fraud-warning cases.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of an action on a linkable fraud case. |
| `case_id` | uuid | High | Links to the financial/fraud subject's case. |
| `action_type` | text; StripeEarlyFraudWarningActionType | High | Action taken concerning the subject. |
| `target_key` | text | High | Linkable target identifier for the case action. |
| `status` | text; StripeEarlyFraudWarningActionStatus | High | Action state concerning the subject. |
| `attempt_count` | integer | Other | Retry counter retained in a personal case-action record. |
| `next_retry_at` | timestamptz | High | Scheduled processing of the subject's case action. |
| `claimed_at` | timestamptz | High | Processing activity on the case action. |
| `last_attempt_at` | timestamptz | High | Last execution activity concerning the subject. |
| `completed_at` | timestamptz | High | Action completion concerning the subject. |
| `terminal_at` | timestamptz | High | Terminal milestone concerning the subject. |
| `result_code` | text | High | Outcome of the subject's case action; vocabulary unverified. |
| `result_reference_id` | text | High | Linkable reference to the action's result. |
| `failure_context` | text | Medium | Unconstrained diagnostics may embed personal content. |
| `created_at` | timestamptz | High | Creation of an action on the subject's case. |
| `updated_at` | timestamptz | High | Update activity on the subject's case action. |

## 18. stripe_dispute_cases

Source: `packages/db/src/schema.ts:1238`.
Purpose: payment dispute state, ownership, deadlines, and acceptance/enforcement history.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Linkable financial dispute case identifier. |
| `stripe_dispute_id` | text | High | External dispute identifier. |
| `stripe_event_id` | text | High | External event linked to the dispute. |
| `stripe_event_created_at` | timestamptz | High | Time of the subject's dispute event. |
| `stripe_charge_id` | text | High | External payment charge identifier. |
| `stripe_payment_intent_id` | text | High | External payment identifier. |
| `stripe_customer_id` | text | High | External customer identifier; organization-only cases need ownership review. |
| `amount_minor_units` | integer | High | Disputed payment amount. |
| `currency` | text | High | Currency of the disputed payment. |
| `dispute_reason` | text | High | Describes the subject's payment dispute; exact vocabulary/free-text content unverified. |
| `stripe_status` | text | High | Provider state of the subject's dispute. |
| `owner_classification` | text; StripeDisputeOwnerClassification | High | Classification of the dispute's owner/account relationship. |
| `kilo_user_id` | text | High | User identifier for the dispute. |
| `organization_id` | uuid | Medium | Organization-only reference; natural-person relationship unverified. |
| `status` | text; StripeDisputeCaseStatus | High | Local state of the subject's dispute. |
| `status_reason` | text | Medium | Unconstrained status explanation may contain personal details. |
| `failure_context` | text | Medium | Unconstrained diagnostics may embed personal/provider information. |
| `stripe_created_at` | timestamptz | High | Provider creation time of the subject's dispute. |
| `evidence_due_by` | timestamptz | High | Evidence deadline for the subject's dispute. |
| `synced_at` | timestamptz | High | Synchronization activity for the subject's dispute. |
| `accepted_by_kilo_user_id` | text | High | Identifies the staff/admin accepting the dispute. |
| `acceptance_started_at` | timestamptz | High | Acceptance activity involving the subject and potentially staff actor. |
| `next_retry_at` | timestamptz | High | Scheduled processing of the subject's dispute. |
| `accepted_at` | timestamptz | High | Dispute acceptance time. |
| `enforcement_completed_at` | timestamptz | High | Enforcement milestone concerning the subject. |
| `review_required_at` | timestamptz | High | Review escalation concerning the subject. |
| `closed_at` | timestamptz | High | Subject's dispute closure time. |
| `created_at` | timestamptz | High | Linkable dispute record creation time. |
| `updated_at` | timestamptz | High | Linkable dispute update activity. |

## 19. stripe_dispute_actions

Source: `packages/db/src/schema.ts:1318`.
Purpose: individual processing/enforcement actions and results for payment disputes.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Linkable action identifier for the dispute. |
| `case_id` | uuid | High | Links to the subject's dispute. |
| `action_type` | text; StripeDisputeActionType | High | Action concerning the subject's dispute. |
| `target_key` | text | High | Linkable target identifier of the dispute action. |
| `status` | text; StripeDisputeActionStatus | High | Action state concerning the subject. |
| `attempt_count` | integer | Other | Retry counter retained in a personal dispute-action record. |
| `next_retry_at` | timestamptz | High | Scheduled action concerning the subject. |
| `claimed_at` | timestamptz | High | Processing activity for the subject's dispute action. |
| `last_attempt_at` | timestamptz | High | Execution activity concerning the subject. |
| `completed_at` | timestamptz | High | Completion of the subject's dispute action. |
| `terminal_at` | timestamptz | High | Terminal milestone concerning the subject. |
| `result_code` | text | High | Outcome of the subject's dispute action; vocabulary unverified. |
| `result_reference_id` | text | High | Linkable reference to the dispute action's result. |
| `failure_context` | text | Medium | Diagnostic string may contain personal details; inspect writers. |
| `created_at` | timestamptz | High | Dispute-action creation time. |
| `updated_at` | timestamptz | High | Dispute-action update time. |

## 20. deleted_user_email_tombstones

Source: `packages/db/src/schema.ts:1385`.
Purpose: email-derived tombstones for deleted users.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `normalized_email_hash` | text | High | Hash of a personal identifier; hashing does not establish anonymity. |
| `created_at` | timestamptz | High | Tombstone creation activity associated with an email-derived identity. |

## 21. impact_attribution_touches

Source: `packages/db/src/schema.ts:1392`.
Purpose: user/visitor marketing touches, referral tracking, acquisition context, and attribution windows. An anonymous visitor ID remains a pseudonymous identifier.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a visitor/user touch. |
| `product` | text; ImpactReferralProduct | High | Product associated with the visitor's touch. |
| `program_key` | text; ImpactAdvocateProgramKey | High | Referral program associated with the visitor's touch. |
| `dedupe_key` | text | High | Linkable identifier of the touch. |
| `anonymous_id` | text | High | Pseudonymous visitor identifier, not proven anonymous data. |
| `user_id` | text | High | User identifier when linked. |
| `touch_type` | text; ImpactAttributionTouchType | High | Type of this visitor/user's attribution activity. |
| `provider` | text; ImpactAttributionTouchProvider | High | Tracking provider associated with the visitor/user. |
| `opaque_tracking_value` | text | High | Opaque tracking identifier; opacity does not remove linkage. |
| `tracking_value_length` | integer | Other | Technical input-length metric retained in a personal touch record. |
| `is_tracking_value_accepted` | boolean | High | Acceptance state of the visitor/user's attribution. |
| `rs_code` | text | High | Referral-tracking code associated with this visitor/user. |
| `rs_share_medium` | text | High | Sharing context of this visitor/user's touch; exact text unverified. |
| `rs_engagement_medium` | text | High | Engagement context of this visitor/user's touch. |
| `im_ref` | text | High | Attribution reference associated with this visitor/user. |
| `landing_path` | text | High | Visitor/user navigation context; embedded personal path content unverified. |
| `utm_source` | text | High | Acquisition source associated with the visitor/user; extra text content unverified. |
| `utm_medium` | text | High | Acquisition medium associated with the visitor/user. |
| `utm_campaign` | text | High | Campaign associated with this visitor/user's activity. |
| `utm_term` | text | High | Acquisition term associated with this visitor/user; exact content unverified. |
| `utm_content` | text | High | Attribution content label associated with this visitor/user; exact content unverified. |
| `touched_at` | timestamptz | High | Visitor/user touch time. |
| `expires_at` | timestamptz | High | Attribution window expiry for the visitor/user. |
| `sale_attributed_at` | timestamptz | High | Sale-attribution activity for the visitor/user. |
| `created_at` | timestamptz | High | Visitor/user tracking record creation time. |

## 22. impact_advocate_participants

Source: `packages/db/src/schema.ts:1464`.
Purpose: referral-program participant identities, contact/localization data, and registration state.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Participant-specific record identifier. |
| `program_key` | text; ImpactAdvocateProgramKey | High | Program participation of the user. |
| `user_id` | text | High | Participant's user identifier. |
| `advocate_id` | text | High | External participant identifier. |
| `advocate_account_id` | text | High | External account identifier linked to the participant. |
| `opaque_referral_identifier` | text | High | Linkable referral identifier despite opaque encoding. |
| `contact_email` | text | High | Participant's contact email. |
| `locale` | text | High | Participant's language/locale information. |
| `country_code` | text | High | Participant's country information. |
| `registration_state` | text; ImpactAdvocateRegistrationState | High | Participant registration outcome/state. |
| `registered_at` | timestamptz | High | Participant registration time. |
| `last_registration_attempt_at` | timestamptz | High | Participant registration attempt activity. |
| `last_error_code` | text | High | Registration failure outcome for the participant; vocabulary unverified. |
| `last_error_message` | text | Medium | Provider/diagnostic free text may embed personal information. |
| `created_at` | timestamptz | High | Participant record creation activity. |
| `updated_at` | timestamptz | High | Participant record update activity. |

## 23. impact_advocate_registration_attempts

Source: `packages/db/src/schema.ts:1519`.
Purpose: participant registration delivery attempts, cookie linkage, and request/response snapshots.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Participant-specific attempt identifier. |
| `program_key` | text; ImpactAdvocateProgramKey | High | Program involved in this participant's registration. |
| `participant_id` | uuid | High | Links to the identified participant. |
| `dedupe_key` | text | High | Linkable identifier of the participant's attempt. |
| `opaque_cookie_value` | text | High | Cookie/tracking value linked to the participant. |
| `cookie_value_length` | integer | Other | Technical input-length metric retained in a personal attempt record. |
| `delivery_state` | text; ImpactAdvocateAttemptDeliveryState | High | Delivery state of the participant's registration. |
| `request_payload` | jsonb; nullable Record<string, unknown> | High | Request about an identified participant's registration; no embedded members declared, additional personal content unverified. |
| `response_payload` | jsonb; nullable Record<string, unknown> | High | Response to that participant's registration; no embedded members declared, additional personal content unverified. |
| `response_status_code` | integer | High | Provider outcome for the participant's registration. |
| `attempt_count` | integer | Other | Retry counter retained in a personal registration record. |
| `next_retry_at` | timestamptz | High | Scheduled registration activity for the participant. |
| `claimed_at` | timestamptz | High | Processing time for the participant's registration. |
| `created_at` | timestamptz | High | Participant attempt creation time. |
| `updated_at` | timestamptz | High | Participant attempt update time. |

## 24. impact_referrals

Source: `packages/db/src/schema.ts:1583`.
Purpose: referral relationships between users and their attribution sources.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user referral relationship. |
| `product` | text; ImpactReferralProduct | High | Product associated with the users' referral. |
| `referee_user_id` | text | High | Referred person's identifier. |
| `referrer_user_id` | text | High | Referring person's identifier. |
| `source_touch_id` | uuid | High | Links the referral to tracked visitor/user activity. |
| `impact_referral_id` | text | High | External referral identifier. |
| `created_at` | timestamptz | High | Time the user referral relationship was recorded. |

## 25. impact_referral_conversions

Source: `packages/db/src/schema.ts:1619`.
Purpose: referral payment conversions, attribution winners, and qualification results.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user-linked conversion. |
| `product` | text; ImpactReferralProduct | High | Product involved in the user's conversion. |
| `referee_user_id` | text | High | Referred user identifier. |
| `referrer_user_id` | text | High | Referring user identifier. |
| `source_touch_id` | uuid | High | Links conversion to user/visitor tracking history. |
| `winning_touch_type` | text; ImpactReferralWinningTouchType | High | Attribution decision about the user's conversion. |
| `payment_provider` | text; ImpactReferralPaymentProvider | High | Payment channel used for this user's conversion. |
| `source_payment_id` | text | High | Linkable payment identifier. |
| `qualified` | boolean | High | Eligibility decision concerning the user's conversion. |
| `disqualification_reason` | text | High | Assessment of this user's eligibility; exact text and additional content unverified. |
| `converted_at` | timestamptz | High | User conversion activity time. |
| `created_at` | timestamptz | High | User conversion record creation time. |

## 26. impact_referral_reward_decisions

Source: `packages/db/src/schema.ts:1677`.
Purpose: beneficiary-specific reward decisions and calculated benefits.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | User-specific reward decision identifier. |
| `product` | text; ImpactReferralProduct | High | Product for the beneficiary's reward decision. |
| `conversion_id` | uuid | High | Links to user-related payment conversion. |
| `beneficiary_user_id` | text | High | Reward beneficiary identifier. |
| `beneficiary_role` | text; ImpactReferralBeneficiaryRole | High | Person's role in the referral relationship. |
| `outcome` | text; ImpactReferralDecisionOutcome | High | Reward decision about the beneficiary. |
| `reason` | text | High | Explanation of the beneficiary's reward decision; additional free-text content unverified. |
| `reward_kind` | text; ImpactReferralRewardKind | High | Benefit type considered for this person. |
| `months_granted` | integer | High | Benefit amount granted to this person. |
| `reward_percent` | decimal(6,4) | High | Reward rate applied to this person's conversion. |
| `source_tier` | text | High | Tier used for this person's reward assessment. |
| `reward_amount_usd` | decimal(12,2) | High | Financial benefit for this person. |
| `created_at` | timestamptz | High | Time of the beneficiary's reward decision. |

## 27. impact_referral_rewards

Source: `packages/db/src/schema.ts:1746`.
Purpose: granted user rewards, their consumption/subscription linkage, and lifecycle.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | User-specific reward identifier. |
| `product` | text; ImpactReferralProduct | High | Product associated with the user's reward. |
| `conversion_id` | uuid | High | Links reward to user conversion activity. |
| `decision_id` | uuid | High | Links reward to the beneficiary's decision record. |
| `beneficiary_user_id` | text | High | Reward beneficiary identifier. |
| `beneficiary_role` | text; ImpactReferralBeneficiaryRole | High | User's referral role. |
| `reward_kind` | text; ImpactReferralRewardKind | High | User's benefit type. |
| `months_granted` | integer | High | Amount of user benefit. |
| `reward_percent` | decimal(6,4) | High | Rate of the user's reward. |
| `source_tier` | text | High | Tier underlying the user's reward. |
| `reward_amount_usd` | decimal(12,2) | High | User's financial reward amount. |
| `status` | text; ImpactReferralRewardStatus | High | User reward entitlement/consumption state. |
| `applies_to_subscription_id` | uuid | High | Links reward to a user-specific subscription. |
| `applies_to_kilo_pass_subscription_id` | uuid | High | Links reward to the user's Kilo Pass subscription. |
| `consumed_kilo_pass_issuance_id` | uuid | High | Links reward to a user-specific issuance. |
| `consumed_kilo_pass_issuance_item_id` | uuid | High | Links reward to a user-specific credit item. |
| `earned_at` | timestamptz | High | Time the user earned the reward. |
| `applied_at` | timestamptz | High | Time the user's reward was applied. |
| `reversed_at` | timestamptz | High | Time the user's reward was reversed. |
| `expires_at` | timestamptz | High | User reward entitlement expiry. |
| `review_reason` | text | High | Review assessment about the user's reward; additional free-text content unverified. |
| `created_at` | timestamptz | High | Creation time of the user's reward. |

## 28. impact_referral_reward_applications

Source: `packages/db/src/schema.ts:1847`.
Purpose: application of user rewards to subscription renewal dates and payment-provider operations.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user's reward application. |
| `product` | text; ImpactReferralProduct | High | Product receiving the user's reward. |
| `reward_id` | uuid | High | Links to the user's reward entitlement. |
| `beneficiary_user_id` | text | High | User beneficiary identifier. |
| `subscription_id` | uuid | High | User-specific subscription identifier. |
| `previous_renewal_boundary` | timestamptz | High | User's prior subscription renewal date. |
| `new_renewal_boundary` | timestamptz | High | User's revised subscription renewal date. |
| `local_operation_id` | text | High | Linkable identifier of the user's reward operation. |
| `stripe_operation_id` | text | High | External identifier of the user's billing operation. |
| `stripe_idempotency_key` | text | High | Linkable request key for the user's billing operation. |
| `applied_at` | timestamptz | High | Time the user's reward was applied. |
| `created_at` | timestamptz | High | User reward application record creation time. |

## 29. impact_advocate_reward_redemptions

Source: `packages/db/src/schema.ts:1893`.
Purpose: beneficiary reward redemption, provider request/response snapshots, and delivery state.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | User-specific redemption identifier. |
| `reward_id` | uuid | High | Links to the user's reward. |
| `dedupe_key` | text | High | Linkable identifier of the redemption operation. |
| `beneficiary_user_id` | text | High | Reward beneficiary identifier. |
| `state` | text; ImpactAdvocateRewardRedemptionState | High | State of the beneficiary's redemption. |
| `impact_reward_id` | text | High | External identifier of the beneficiary's reward. |
| `request_payload` | jsonb; nullable Record<string, unknown> | High | Request concerning the beneficiary's reward; no embedded fields declared, additional content unverified. |
| `lookup_response_payload` | jsonb; nullable Record<string, unknown> | High | Lookup result for the beneficiary's reward; no embedded fields declared, additional content unverified. |
| `redeem_response_payload` | jsonb; nullable Record<string, unknown> | High | Redemption result for the beneficiary's reward; no embedded fields declared, additional content unverified. |
| `response_status_code` | integer | High | Provider outcome for the beneficiary's redemption. |
| `attempt_count` | integer | Other | Retry counter retained in a personal redemption record. |
| `next_retry_at` | timestamptz | High | Scheduled redemption processing for the beneficiary. |
| `redeemed_at` | timestamptz | High | User reward redemption time. |
| `created_at` | timestamptz | High | User redemption record creation time. |
| `updated_at` | timestamptz | High | User redemption record update time. |

## 30. impact_conversion_reports

Source: `packages/db/src/schema.ts:1949`.
Purpose: external reporting of linkable conversions/orders with provider payloads and delivery state.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Linkable conversion report identifier. |
| `conversion_id` | uuid | High | Links to users and their conversion. |
| `dedupe_key` | text | High | Linkable identifier of the conversion report. |
| `action_tracker_id` | integer | Medium | External tracker scope is undeclared; may be shared configuration or personally linkable. |
| `order_id` | text | High | External order identifier linkable to the purchaser. |
| `state` | text; ImpactConversionReportState | High | Reporting state of a user-linked conversion/order. |
| `request_payload` | jsonb; nullable Record<string, unknown> | High | Report about a linkable conversion/order; no embedded fields declared, additional content unverified. |
| `response_payload` | jsonb; nullable Record<string, unknown> | High | Response about a linkable conversion/order; no embedded fields declared, additional content unverified. |
| `response_status_code` | integer | High | Provider outcome for the user-linked conversion report. |
| `attempt_count` | integer | Other | Retry counter retained in a personal conversion record. |
| `next_retry_at` | timestamptz | High | Scheduled reporting activity for the user-linked conversion. |
| `delivered_at` | timestamptz | High | Delivery activity for the user-linked conversion. |
| `created_at` | timestamptz | High | Conversion report creation time. |
| `updated_at` | timestamptz | High | Conversion report update time. |

## 31. kilo_pass_subscriptions

Source: `packages/db/src/schema.ts:1993`.
Purpose: user subscriptions, payment-provider linkage, plan choices, cancellation, and bonus eligibility state.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | User-specific subscription identifier. |
| `kilo_user_id` | text | High | Subscriber identifier. |
| `payment_provider` | text; KiloPassPaymentProvider | High | Subscriber's payment channel. |
| `provider_subscription_id` | text | High | External subscription identifier. |
| `stripe_subscription_id` | text | High | External billing subscription identifier. |
| `tier` | text; KiloPassTier | High | User's subscription tier. |
| `cadence` | text; KiloPassCadence | High | User's billing cadence. |
| `status` | text; StripeSubscriptionStatus | High | User subscription state. |
| `cancel_at_period_end` | boolean | High | User subscription cancellation state. |
| `started_at` | timestamptz | High | User subscription start time. |
| `ended_at` | timestamptz | High | User subscription end time. |
| `current_streak_months` | integer | High | User subscription continuity/benefit history, not pure plumbing. |
| `next_yearly_issue_at` | timestamptz | High | User's next yearly-plan bonus eligibility boundary. |
| `created_at` | timestamptz | High | User subscription creation time. |
| `updated_at` | timestamptz | High | User subscription update activity. |

## 32. kilo_pass_store_events

Source: `packages/db/src/schema.ts:2076`.
Purpose: store billing events and processing metadata with potentially linkable account, subscription, and transaction references.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Linkable store billing-event identifier. |
| `payment_provider` | text; KiloPassPaymentProvider | High | Payment channel associated with the billing event. |
| `event_id` | text | High | External billing-event identifier. |
| `provider_subscription_id` | text | High | External user subscription identifier. |
| `provider_transaction_id` | text | High | External transaction identifier. |
| `app_account_token` | uuid | High | Account-linked store identifier. |
| `product_id` | text | High | Product involved in the account-linked billing event. |
| `environment` | text | Other | Store environment/routing label retained in a potentially personal billing event. |
| `payload_json` | jsonb; Record<string, unknown> | High | Billing-event contents tied to external event/account references; no embedded fields declared, additional content unverified. |
| `processing_started_at` | timestamptz | High | Processing activity for the linkable billing event. |
| `processed_at` | timestamptz | High | Completion activity for the linkable billing event. |
| `created_at` | timestamptz | High | Linkable billing-event creation time. |

## 33. kilo_pass_store_purchases

Source: `packages/db/src/schema.ts:2116`.
Purpose: user store purchases with subscription ownership, transaction tokens, and raw provider data.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | User purchase record identifier. |
| `kilo_pass_subscription_id` | uuid | High | Links purchase to the user's subscription. |
| `kilo_user_id` | text | High | Purchaser's user identifier. |
| `payment_provider` | text; KiloPassPaymentProvider | High | User's purchase channel. |
| `product_id` | text | High | Product purchased by the user. |
| `provider_subscription_id` | text | High | External user subscription identifier. |
| `provider_transaction_id` | text | High | External purchase transaction identifier. |
| `provider_original_transaction_id` | text | High | External original transaction identifier linking purchase history. |
| `app_account_token` | uuid | High | Account-linked store identifier. |
| `purchase_token` | text | High | User-specific purchase token; also security-sensitive. |
| `environment` | text | Other | Store environment/routing label retained in a personal purchase record. |
| `purchased_at` | timestamptz | High | User purchase time. |
| `expires_at` | timestamptz | High | User purchase entitlement expiry. |
| `raw_payload_json` | jsonb; Record<string, unknown> | High | Raw data about this user's purchase; no embedded fields declared, additional personal content unverified. |
| `created_at` | timestamptz | High | User purchase record creation time. |
| `updated_at` | timestamptz | High | User purchase record update activity. |

## 34. kilo_pass_issuances

Source: `packages/db/src/schema.ts:2191`.
Purpose: subscription-linked periodic credit issuances and initial promotional eligibility decisions.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | User-specific credit issuance identifier. |
| `kilo_pass_subscription_id` | uuid | High | Links issuance to the subscriber. |
| `issue_month` | date | High | Period of the user's credit entitlement. |
| `source` | text; KiloPassIssuanceSource | High | Source of this user's credit issuance. |
| `stripe_invoice_id` | text | High | External invoice identifier. |
| `initial_welcome_promo_eligibility_reason` | text; KiloPassWelcomePromoEligibilityReason | High | Promotional eligibility assessment about the subscriber. |
| `created_at` | timestamptz | High | User issuance creation time. |
| `updated_at` | timestamptz | High | User issuance update activity. |

## 35. kilo_pass_welcome_promo_payment_fingerprint_claims

Source: `packages/db/src/schema.ts:2240`.
Purpose: promotional claims tied to payment fingerprints and source invoices.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `stripe_payment_method_type` | text; KiloPassWelcomePromoPaymentFingerprintType | High | Payment method type associated with a linkable promotional claim. |
| `stripe_fingerprint` | text | High | Payment instrument fingerprint; pseudonymous financial identifier. |
| `source_stripe_invoice_id` | text | High | External invoice identifier linkable to the payer. |
| `claimed_at` | timestamptz | High | Time of the linkable promotional claim. |

## 36. kilo_pass_pause_events

Source: `packages/db/src/schema.ts:2268`.
Purpose: subscriber pause and resumption history.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | User-specific subscription pause identifier. |
| `kilo_pass_subscription_id` | uuid | High | Links pause activity to the subscriber. |
| `paused_at` | timestamptz | High | Subscriber's pause activity time. |
| `resumes_at` | timestamptz | High | Subscriber's scheduled resumption time. |
| `resumed_at` | timestamptz | High | Subscriber's actual resumption time. |
| `created_at` | timestamptz | High | User pause record creation time. |
| `updated_at` | timestamptz | High | User pause record update activity. |

## 37. kilo_pass_issuance_items

Source: `packages/db/src/schema.ts:2302`.
Purpose: individual subscription credit items and their monetary/bonus amounts.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | User-specific credit item identifier. |
| `kilo_pass_issuance_id` | uuid | High | Links item to a subscriber's issuance. |
| `kind` | text; KiloPassIssuanceItemKind | High | Type of credit issued to the user. |
| `credit_transaction_id` | uuid | High | Links to the user's financial ledger entry. |
| `amount_usd` | decimal(12,2) | High | User credit amount. |
| `bonus_percent_applied` | decimal(6,4) | High | Bonus rate applied to the user's credits. |
| `created_at` | timestamptz | High | User credit item creation time. |
| `updated_at` | timestamptz | High | User credit item update activity. |

## 38. kilo_pass_audit_log

Source: `packages/db/src/schema.ts:2347`.
Purpose: subscription action/result audit trail with user, payment, and credit references.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Linkable subscription audit event identifier. |
| `created_at` | timestamptz | High | Time of user-related subscription activity. |
| `kilo_user_id` | text | High | User identifier. |
| `kilo_pass_subscription_id` | uuid | High | User-specific subscription identifier. |
| `action` | text; KiloPassAuditLogAction | High | Action concerning the user/subscription. |
| `result` | text; KiloPassAuditLogResult | High | Outcome concerning the user/subscription. |
| `idempotency_key` | text | High | Linkable key for the user-related operation. |
| `stripe_event_id` | text | High | External billing-event identifier. |
| `stripe_invoice_id` | text | High | External invoice identifier. |
| `stripe_subscription_id` | text | High | External user subscription identifier. |
| `related_credit_transaction_id` | uuid | High | Links to a user's financial ledger entry. |
| `related_monthly_issuance_id` | uuid | High | Links to a user's periodic credit issuance. |
| `payload_json` | jsonb; Record<string, unknown> | High | User/subscription-related audit details; no embedded fields declared, additional personal content unverified. |

## 39. kilo_pass_scheduled_changes

Source: `packages/db/src/schema.ts:2403`.
Purpose: scheduled changes to a user's subscription tier/cadence and their lifecycle.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | User-specific scheduled change identifier. |
| `kilo_user_id` | text | High | Subscriber's user identifier. |
| `stripe_subscription_id` | text | High | External user subscription identifier. |
| `from_tier` | text; KiloPassTier | High | User's prior subscription tier. |
| `from_cadence` | text; KiloPassCadence | High | User's prior billing cadence. |
| `to_tier` | text; KiloPassTier | High | User's requested/new subscription tier. |
| `to_cadence` | text; KiloPassCadence | High | User's requested/new billing cadence. |
| `stripe_schedule_id` | text | High | External identifier of the user's subscription change schedule. |
| `effective_at` | timestamptz | High | Effective time of the user's subscription change. |
| `status` | text; KiloPassScheduledChangeStatus | High | State of the user's scheduled change. |
| `deleted_at` | timestamptz | High | Soft-deletion activity for the user's change; not proof of erasure. |
| `created_at` | timestamptz | High | Creation time of the user's scheduled change. |
| `updated_at` | timestamptz | High | Update activity for the user's scheduled change. |

## 40. auto_top_up_configs

Source: `packages/db/src/schema.ts:2467`.
Purpose: automatic credit top-up payment configuration and attempt history, owned by exactly one user or organization. Personal-account rows clearly describe a user; organization-only ownership/payment identity needs confirmation.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Linkable billing configuration identifier, including user-specific configurations. |
| `owned_by_user_id` | text | High | Personal account owner identifier. |
| `owned_by_organization_id` | uuid | Medium | Organization owner identifier; natural-person/sole-trader linkage unverified. |
| `created_by_user_id` | text | High | Identifies creator for organization-owned configurations per source comment. |
| `stripe_payment_method_id` | text | High | External payment instrument identifier; organization-only ownership needs review. |
| `amount_cents` | integer | High | User's automatic purchase amount; organization-only cases need ownership review. |
| `last_auto_top_up_at` | timestamptz | High | Linkable automatic payment activity time. |
| `attempt_started_at` | timestamptz | High | Linkable payment attempt activity. |
| `disabled_reason` | text | High | Billing disablement assessment/state about the owner; additional free-text content unverified. |
| `created_at` | timestamptz | High | Billing configuration creation activity, potentially attributed to its creator. |
| `updated_at` | timestamptz | High | Linkable billing configuration update activity. |

## Verification and limitations

The inventory is bounded to declaration order, not alphabetic order or database catalog order. A read-only TypeScript AST check of the completed Markdown passed for **40 tables and 545 columns**, with no missing, extra, duplicated, or reordered table/column entries. It also checked base schema types, timestamp timezone declarations, decimal precision/scale, table source lines, summary column counts, and exact classification labels. Totals were **492 High, 21 Medium, and 32 Other**; declaration #41 was confirmed as `user_auth_provider`.

The AST check inspected only the first 41 declarations to establish the batch boundary; it does not claim coverage of later schema declarations. JSON type clues and classification reasons were reviewed from source, not mechanically proven. This does not inspect live rows, evaluate runtime writers, validate migrations against a deployed database, or establish that TypeScript JSON shapes are enforced at runtime.

## Material follow-ups

1. **Runtime payloads and free text:** inspect writers/validators for all JSON and unrestricted strings, especially export cursors, redacted errors, failure contexts, campaign labels, provider request/response data, deletion evidence, and attribution URLs/labels. Confirm actual shapes, redaction guarantees, credential ownership, and unexpected nested identifiers without copying secrets or live personal values into this document.
2. **Retention and deletion:** trace actual deletion/anonymization and export-cleanup implementations, schedules, retries, failure recovery, object lifecycle rules, backups, and retention exceptions. Verify effects on hashes/HMACs, tombstones, orphan references, provider credentials, staff audit trails, and rows surviving foreign-key nulling. Schema constraints/comments and timestamp names alone do not prove erasure or retention compliance.
3. **External joins and ownership:** verify resolution of payment, invoice, dispute, affiliate, support-ticket, store, object, cookie, and referral identifiers. Confirm organization versus natural-person/sole-trader ownership and staff/member relationships. High classifications based on linkability are preliminary; these joins have not been executed or traced here.
4. **Other stores:** inventory export files and multipart uploads in R2/object storage, provider systems, logs/telemetry, caches, queues, session/blob stores, Durable Object/other databases, replicas, and backups. The PostgreSQL table inventory does not establish their contents or deletion behavior.
5. **Next batch:** start at table **#41, `user_auth_provider`**, `packages/db/src/schema.ts:2510`.
