# Personal data audit — batch 02

## Scope, date, and sources

- Date: 2026-09-03.
- Scope: `pgTable` declarations **#41–80 inclusive** in `packages/db/src/schema.ts`, from `user_auth_provider` through `organization_groups`: **40 tables and 360 physical columns**. Every physical column appears once in its table's inventory, in declaration order. JSON members are evidence, not additional physical columns.
- Sources: root `AGENTS.md`, `packages/db/AGENTS.md`, the introduction and representative sections of `personal-data-audit-batch-01.md`, `packages/db/src/schema.ts:2510–3838`, and local type definitions cited below. Table citations identify declaration starts in this checkout. The reused `idPrimaryKeyColumn` resolves to `uuid` at `packages/db/src/schema.ts:3160–3163`.
- This is a **source-only preliminary audit**, applying the user's broad definition of personal data as **any data about a user**, not just names, email addresses, or IP addresses. No live data, secrets, application writers, runtime payloads, deployed database catalogs, or retention/deletion execution were inspected or validated. This is not a legal determination.
- Schema types describe PostgreSQL types; `timestamptz` means `timestamp({ withTimezone: true, mode: 'string' })`, and `date` uses string mode. `text[]` is a physical array column. An annotation after `;` names the declared TypeScript `$type`; `or` renders union separators. Nullability/defaults are omitted. TypeScript annotations do not prove runtime JSON validation. User identifiers are arbitrary `text`, not necessarily UUIDs.

## Classification legend

| Classification | Meaning |
| --- | --- |
| High | High confidence the column identifies or describes a natural person directly or through a user-specific record: identifiers including hashed, encrypted, opaque, and external identifiers; financial data; preferences; activity, state, lifecycle timestamps; staff/admin identity and actions. Confidence of personal relevance, not a sensitivity ranking. |
| Medium | Plausible embedded personal information or uncertain ownership/content: generic free text, diagnostic strings, opaque shared credentials, or organization-only records requiring writer/ownership inspection. This does not mean an enclosing user-linked record is nonpersonal. |
| Other | Genuinely shared dictionary/configuration values or narrow technical plumbing with no independent personal meaning established here. An Other value retained in a personal record remains part of that record; it is not permission to publish it or omit the whole row from privacy handling. |

Row context matters. User-associated settings, financial amounts, request performance, assessments, and timestamps are High even when technical. Retry counts and a plan revision number are narrow plumbing exceptions. Organization financial/configuration records are Medium when only organization-level ownership is established; a recorded creator is High, but does not make the organization's aggregate spend that creator's personal spend. Staff-attributed change records and ledger references to `credit_transactions.kilo_user_id` establish stronger personal linkage and are classified accordingly. Nullable user/actor references and foreign-key nulling do not prove anonymity.

Shared lookup values are distinguished from their use: a city/country name or product feature label is not by itself a person's location or activity, while the corresponding reference in a user's usage record is High. IP addresses and client fingerprints remain High even when deduplicated or hashed. Unconstrained shared user-agent/prompt strings are Medium pending content/writer review. High JSON classifications rely on user-specific record context or explicit personal fields, not invented nested content; additional contents remain unverified.

## Local JSON/type evidence

- `CustomLlmDefinition`: `packages/db/src/schema-types.ts:2134–2143` combines metadata (`:2065–2072`) and API configuration (`:2083–2094`) with `display_name`, `organization_ids`, optional `group_ids`, and pricing (`:2056–2063`). API configuration includes `internal_id`, `base_url`, optional extra headers (string values, `:2050–2052`) and extra body (arbitrary values, `:2046–2048`). Nested OpenCode settings/variants have provider/family/prompt enums and verbosity/reasoning options (`:1983–2044`). This establishes configuration and organization/group association, not a particular person's ownership or actual embedded credentials. `CustomLlmCredentials` is a separate type, not the declared type of `definition`; its fields are not assumed present here.
- `EncryptedData`: `packages/db/src/schema-types.ts:1214–1218` declares only `iv`, `data`, and `authTag`. It does not identify the plaintext owner or prove anonymity. No ciphertext or keys were read.
- `OrganizationSettings`: `packages/db/src/schema-types.ts:975–1017` explicitly includes `minimum_balance_alert_email` (email array), model/provider preferences, billing/feature flags, sponsorship fields, repository URL, and reset timestamps. Auto-model routes/fallback are defined at `:944–973`. The email field establishes High personal-content confidence for the physical JSON column, without asserting every row populates it.
- `OrganizationGroupPolicies`: `packages/db/src/schema-types.ts:1022–1038` is an array of `model_access` policies with `all`, `none`, or `selected` mode; selected mode contains model/provider allow lists. No member identifiers are declared inside the JSON. The source explicitly delegates runtime contracts to the web app; those writers/validators were not traced.
- Inline JSON annotations: feedback context is `Record<string, unknown>` (`packages/db/src/schema.ts:3053`); organization audit before/after values are nullable `Record<string, unknown>` (`:3765–3766`). Payment provider data (`:2572`), API request/error data (`:2759–2761`), and fingerprint data (`:3088`) have no declared member shape. Their established user/payment/request/assessment context supports High; extra embedded contents are unknown.
- Supporting non-JSON types: authentication providers (`packages/db/src/schema-types.ts:1222–1232`), abuse assessments (`:1236–1242`), API-kind dictionary (`:1246–1256`), organization role/plan (`:935–939`), and domain-claim status (`packages/db/src/schema.ts:3223`) inform the classifications without changing physical types.

## Table summary

Classification totals: **244 High**, **88 Medium**, **28 Other** (360 columns).

| # | Table | Columns | High | Medium | Other |
| --- | --- | ---: | ---: | ---: | ---: |
| 41 | user_auth_provider | 8 | 8 | 0 | 0 |
| 42 | payment_methods | 31 | 30 | 1 | 0 |
| 43 | microdollar_usage | 17 | 16 | 1 | 0 |
| 44 | microdollar_usage_daily | 6 | 5 | 1 | 0 |
| 45 | microdollar_usage_daily_repairs | 11 | 8 | 2 | 1 |
| 46 | microdollar_usage_metadata | 37 | 37 | 0 | 0 |
| 47 | api_request_log | 12 | 11 | 1 | 0 |
| 48 | http_user_agent | 2 | 0 | 2 | 0 |
| 49 | http_ip | 2 | 2 | 0 | 0 |
| 50 | vercel_ip_country | 2 | 0 | 0 | 2 |
| 51 | vercel_ip_city | 2 | 0 | 0 | 2 |
| 52 | system_prompt_prefix | 2 | 0 | 2 | 0 |
| 53 | ja4_digest | 2 | 2 | 0 | 0 |
| 54 | finish_reason | 2 | 0 | 0 | 2 |
| 55 | editor_name | 2 | 0 | 0 | 2 |
| 56 | api_kind | 2 | 0 | 0 | 2 |
| 57 | feature | 2 | 0 | 0 | 2 |
| 58 | mode | 2 | 0 | 0 | 2 |
| 59 | auto_model | 2 | 0 | 0 | 2 |
| 60 | custom_llm2 | 3 | 0 | 3 | 0 |
| 61 | user_admin_notes | 5 | 5 | 0 | 0 |
| 62 | user_feedback | 8 | 8 | 0 | 0 |
| 63 | stytch_fingerprints | 23 | 23 | 0 | 0 |
| 64 | referral_codes | 6 | 6 | 0 | 0 |
| 65 | referral_code_usages | 8 | 8 | 0 | 0 |
| 66 | organizations | 20 | 3 | 17 | 0 |
| 67 | organization_domain_claims | 9 | 0 | 9 | 0 |
| 68 | kilo_pass_org_term_versions | 11 | 2 | 1 | 8 |
| 69 | kilo_pass_org_agreements | 22 | 0 | 22 | 0 |
| 70 | kilo_pass_org_term_transitions | 8 | 6 | 2 | 0 |
| 71 | kilo_pass_org_allocation_plans | 6 | 4 | 1 | 1 |
| 72 | kilo_pass_org_allocation_plan_rows | 5 | 4 | 1 | 0 |
| 73 | kilo_pass_org_processing_runs | 11 | 0 | 10 | 1 |
| 74 | kilo_pass_org_notification_deliveries | 9 | 8 | 0 | 1 |
| 75 | kilo_pass_org_issuance_snapshots | 22 | 19 | 3 | 0 |
| 76 | kilo_pass_org_supplements | 6 | 6 | 0 | 0 |
| 77 | kilo_pass_org_qualifying_spend_events | 7 | 6 | 1 | 0 |
| 78 | kilo_pass_org_audit_records | 9 | 7 | 2 | 0 |
| 79 | organization_memberships | 8 | 8 | 0 | 0 |
| 80 | organization_groups | 8 | 2 | 6 | 0 |
| | **Total** | **360** | **244** | **88** | **28** |

## 41. user_auth_provider

Source: `packages/db/src/schema.ts:2510`.
Purpose: authentication-provider identities associated with a user.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `kilo_user_id` | text | High | Identifies the user owning the provider identity. |
| `provider` | text; AuthProviderId | High | Authentication service associated with this user, not a shared dictionary row. |
| `provider_account_id` | text | High | External account identifier. |
| `email` | text | High | Provider identity email address. |
| `avatar_url` | text | High | User profile image reference. |
| `display_name` | text | High | User's displayed identity. |
| `hosted_domain` | text | High | Domain associated with this user's provider identity. |
| `created_at` | timestamptz | High | Time the user's provider association was recorded. |

## 42. payment_methods

Source: `packages/db/src/schema.ts:2535`.
Purpose: user-linked payment instruments, billing address, verification, and network metadata; optionally associated with an organization.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Linkable identifier of a user's payment instrument. |
| `stripe_fingerprint` | text | High | Payment-instrument fingerprint; hashing does not make it anonymous. |
| `user_id` | text | High | Payment method's user identifier. |
| `stripe_id` | text | High | External payment-method identifier. |
| `created_at` | timestamptz | High | User payment-method creation activity. |
| `updated_at` | timestamptz | High | User payment-method update activity. |
| `last4` | text | High | Partial account/card digits linked to the user. |
| `brand` | text | High | Brand of this user's payment instrument. |
| `address_line1` | text | High | User-linked billing address line. |
| `address_line2` | text | High | Additional billing address detail. |
| `address_city` | text | High | Billing city attached to a user, not a shared city dictionary. |
| `address_state` | text | High | User-linked billing region. |
| `address_zip` | text | High | User-linked billing postal code. |
| `address_country` | text | High | Billing country of this user, unlike an unassociated country label. |
| `name` | text | High | Name on the user's payment method. |
| `three_d_secure_supported` | boolean | High | Security capability of the user's payment instrument. |
| `funding` | text | High | Funding classification of this user's payment method. |
| `regulated_status` | text | High | Regulatory classification attached to this payment method. |
| `address_line1_check_status` | text | High | Result of checking this user's billing address. |
| `postal_code_check_status` | text | High | Result of checking this user's postal code. |
| `http_x_forwarded_for` | text | High | Network address/header associated with payment activity. |
| `http_x_vercel_ip_city` | text | High | Inferred city of user-linked payment activity. |
| `http_x_vercel_ip_country` | text | High | Inferred country of user-linked payment activity. |
| `http_x_vercel_ip_latitude` | real | High | Latitude associated with the user's request. |
| `http_x_vercel_ip_longitude` | real | High | Longitude associated with the user's request. |
| `http_x_vercel_ja4_digest` | text | High | Client fingerprint associated with the user; digest remains linkable. |
| `eligible_for_free_credits` | boolean | High | Credit eligibility assessment attached to this user's payment method. |
| `deleted_at` | timestamptz | High | Payment-method removal time; does not establish erasure. |
| `stripe_data` | jsonb | High | User-specific payment-provider data; no member shape declared, additional contents unverified. |
| `type` | text | High | Type of payment instrument held by this user. |
| `organization_id` | uuid | Medium | Organization association; natural-person ownership/membership not established by this reference alone. |

## 43. microdollar_usage

Source: `packages/db/src/schema.ts:2584`.
Purpose: individual user inference usage, charges, model selection, and abuse assessment.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of the user's usage event. |
| `kilo_user_id` | text | High | User whose usage is recorded. |
| `cost` | bigint | High | Cost incurred by the user's request. |
| `input_tokens` | bigint | High | User input consumption. |
| `output_tokens` | bigint | High | User output consumption. |
| `cache_write_tokens` | bigint | High | Cache-writing consumption on this user's request. |
| `cache_hit_tokens` | bigint | High | Cached consumption on this user's request. |
| `created_at` | timestamptz | High | User usage activity time. |
| `provider` | text | High | Provider used for this user's request. |
| `model` | text | High | Model used for this user's activity. |
| `requested_model` | text | High | User's requested model choice. |
| `cache_discount` | bigint | High | Discount applied to the user's usage. |
| `has_error` | boolean | High | Outcome of this user's request. |
| `abuse_classification` | smallint; AbuseClassification | High | Abuse assessment about user-associated activity. |
| `organization_id` | uuid | Medium | Organization billing context; exact natural-person organizational relationship unverified. |
| `inference_provider` | text | High | Inference service used for the user's request. |
| `project_id` | text | High | Project reference attached to identifiable user activity. |

## 44. microdollar_usage_daily

Source: `packages/db/src/schema.ts:2624`.
Purpose: per-user, per-day usage totals, optionally scoped to an organization; aggregation is not anonymization while keyed by user.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user-specific daily rollup. |
| `kilo_user_id` | text | High | Identifies the user in the aggregate. |
| `organization_id` | uuid | Medium | Organization scope; ownership/member relationship requires confirmation. |
| `usage_date` | date | High | Day of this user's activity. |
| `total_cost_microdollars` | bigint | High | User's daily financial consumption. |
| `updated_at` | timestamptz | High | Update time of the user's usage aggregate. |

## 45. microdollar_usage_daily_repairs

Source: `packages/db/src/schema.ts:2657`.
Purpose: durable per-usage repair work for personal daily usage rollups.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `usage_id` | uuid | High | Direct link to a user's source usage event. |
| `kilo_user_id` | text | High | User whose usage is being repaired. |
| `organization_id` | uuid | Medium | Organization scope, with natural-person relationship unverified. |
| `usage_date` | date | High | Day of the user's usage needing repair. |
| `next_attempt_at` | timestamptz | High | Processing schedule for identifiable user usage. |
| `claimed_at` | timestamptz | High | Processing lifecycle time for the user's repair. |
| `claim_token` | uuid | High | Linkable processing token for this user-specific repair. |
| `attempt_count` | integer | Other | Retry counter used as narrow queue plumbing; enclosing usage repair remains personal. |
| `last_error_redacted` | text | Medium | Diagnostic text may retain personal details; redaction not verified. |
| `created_at` | timestamptz | High | Creation time of the user's usage repair work. |
| `updated_at` | timestamptz | High | Update activity for the user's repair work. |

## 46. microdollar_usage_metadata

Source: `packages/db/src/schema.ts:2696`.
Purpose: detailed request context joined to individual user usage by `id`; the source view establishes this join at `packages/db/src/schema.ts:2991–3004` even without a declared usage foreign key.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Joins metadata to the user's usage record. |
| `created_at` | timestamptz | High | User-request metadata time. |
| `message_id` | text | High | Identifier of the user's message/request. |
| `http_user_agent_id` | integer | High | Associates a client user-agent with this user's request. |
| `http_ip_id` | integer | High | Indirect reference to the user's request IP address. |
| `vercel_ip_city_id` | integer | High | Associates a shared city value with this user's location. |
| `vercel_ip_country_id` | integer | High | Associates a shared country value with this user's location. |
| `vercel_ip_latitude` | real | High | Request-associated latitude. |
| `vercel_ip_longitude` | real | High | Request-associated longitude. |
| `ja4_digest_id` | integer | High | Associates a client fingerprint with the user. |
| `user_prompt_prefix` | text | High | User-supplied request content; may also describe others, actual contents unverified. |
| `system_prompt_prefix_id` | integer | High | Prompt context used for this user's request, irrespective of shared prefix ownership. |
| `system_prompt_length` | integer | High | Context size for identifiable user activity. |
| `max_tokens` | bigint | High | Generation limit selected/applied for the user's request. |
| `has_middle_out_transform` | boolean | High | Transformation applied to this user's request. |
| `status_code` | smallint | High | Outcome of identifiable user activity. |
| `upstream_id` | text | High | External correlation identifier for the user's request. |
| `finish_reason_id` | integer | High | Associates a shared outcome label with this user's result. |
| `latency` | real | High | Performance experienced by the user's request. |
| `moderation_latency` | real | High | Moderation processing measurement for this user's activity. |
| `generation_time` | real | High | Generation duration of the user's request. |
| `is_byok` | boolean | High | Credential-sourcing state applied to this user's request. |
| `is_user_byok` | boolean | High | Records use of the user's own provider credentials. |
| `streamed` | boolean | High | Delivery mode of this user's result. |
| `cancelled` | boolean | High | Cancellation state of identifiable user activity. |
| `editor_name_id` | integer | High | Editor/client used by this user, unlike the shared editor-name dictionary. |
| `api_kind_id` | integer | High | API operation used in this user's activity. |
| `has_tools` | boolean | High | Tool availability/use context of this user's request. |
| `machine_id` | text | High | User-associated device identifier. |
| `feature_id` | integer | High | Feature used by this user; association is personal even if the label is shared. |
| `session_id` | text | High | User session identifier. |
| `mode_id` | integer | High | Mode used for this user's activity. |
| `auto_model_id` | integer | High | Automatic model choice associated with the user's request. |
| `market_cost` | bigint | High | Financial valuation of the user's request. |
| `is_free` | boolean | High | Charging/entitlement state for this user activity. |
| `abuse_delay` | integer | High | Abuse-related delay applied to this user's request, not a generic retry counter. |
| `abuse_downgraded_from` | text | High | Prior model affected by an abuse-related restriction on user activity. |

## 47. api_request_log

Source: `packages/db/src/schema.ts:2747`.
Purpose: potentially user/session-linked API request, response, error, and outcome logging; nullable identity does not guarantee anonymity.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | bigserial | High | Correlatable identifier of a potentially identified user's API event. |
| `created_at` | timestamptz | High | Time of user-associated API activity. |
| `kilo_user_id` | text | High | Requesting user identifier when populated. |
| `organization_id` | text | Medium | Organization context; natural-person ownership/membership uncertain. |
| `session_id` | text | High | User session correlation identifier. |
| `vercel_request_id` | text | High | External request identifier correlatable with user activity. |
| `provider` | text | High | Provider used for the user's logged activity. |
| `model` | text | High | Model used for the user's logged activity. |
| `status_code` | integer | High | Outcome of the user's API request. |
| `request` | jsonb | High | User-associated request contents; no member shape declared, additional contents unverified. |
| `response` | text | High | Response to user activity; content and possible third-party personal details unverified. |
| `error` | jsonb | High | Error details concerning the user's request; structure and additional embedded content unverified. |

## 48. http_user_agent

Source: `packages/db/src/schema.ts:2766`.
Purpose: deduplicated client user-agent strings referenced by request metadata.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `http_user_agent_id` | serial | Medium | Shared string key, not a user ID; can resolve potentially identifying/custom client strings, content uncertain. |
| `http_user_agent` | text | Medium | Usually shared client/software description, but unrestricted strings can embed identifiers; request associations are High separately. |

## 49. http_ip

Source: `packages/db/src/schema.ts:2777`.
Purpose: deduplicated request network addresses; deduplication does not remove IP identifiability.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `http_ip_id` | serial | High | Indirect identifier resolving to an IP address and linked request history. |
| `http_ip` | text | High | IP/network address is intrinsically potentially identifying even in a shared lookup. |

## 50. vercel_ip_country

Source: `packages/db/src/schema.ts:2788`.
Purpose: shared country-value dictionary, not individual users' location records.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `vercel_ip_country_id` | serial | Other | Key for a shared country value; personal location arises in request associations. |
| `vercel_ip_country` | text | Other | Country label alone is shared geography, not a person's location; writer validation of labels remains a follow-up. |

## 51. vercel_ip_city

Source: `packages/db/src/schema.ts:2798`.
Purpose: shared city-value dictionary, separate from user-linked coordinates and location references.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `vercel_ip_city_id` | serial | Other | Shared city key rather than a user identifier; user-request references are High. |
| `vercel_ip_city` | text | Other | Shared city label has no individual location attribution here; unexpected custom contents require writer review. |

## 52. system_prompt_prefix

Source: `packages/db/src/schema.ts:2808`.
Purpose: deduplicated system-prompt prefixes; schema does not establish exclusively shared boilerplate content.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `system_prompt_prefix_id` | serial | Medium | Key resolves to possibly user-customized prompt content; exclusively nonpersonal ownership not established. |
| `system_prompt_prefix` | text | Medium | Free-form prompt text may contain personal context rather than only shared instructions; inspect writers. |

## 53. ja4_digest

Source: `packages/db/src/schema.ts:2819`.
Purpose: deduplicated client TLS fingerprints referenced by identifiable requests; fingerprints may be shared across clients without being anonymous.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `ja4_digest_id` | serial | High | Indirect client-fingerprint identifier used to correlate request characteristics. |
| `ja4_digest` | text | High | Client fingerprint relevant to profiling/linkability; digest and non-uniqueness do not establish anonymity. |

## 54. finish_reason

Source: `packages/db/src/schema.ts:2830`.
Purpose: shared inference completion-outcome vocabulary.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `finish_reason_id` | serial | Other | Dictionary key, not an individual outcome record. |
| `finish_reason` | text | Other | Shared outcome label; a user's actual outcome is represented by the metadata association. |

## 55. editor_name

Source: `packages/db/src/schema.ts:2839`.
Purpose: shared editor/client product-name dictionary, not names of human editors.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `editor_name_id` | serial | Other | Shared client-product dictionary key. |
| `editor_name` | text | Other | Client/editor product label; per-user client selection is High in request metadata. |

## 56. api_kind

Source: `packages/db/src/schema.ts:2848`.
Purpose: shared API operation categories; declared values are in `packages/db/src/schema-types.ts:1246–1256`.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `api_kind_id` | serial | Other | Identifier of a shared API category. |
| `api_kind` | text; GatewayApiKind | Other | Shared operation vocabulary, not a user's operation history until associated with usage. |

## 57. feature

Source: `packages/db/src/schema.ts:2857`.
Purpose: shared feature-name dictionary.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `feature_id` | serial | Other | Shared feature key; it identifies a feature, not a person. |
| `feature` | text | Other | Product feature name normally shared; usage associations reveal personal activity, custom labels remain a follow-up. |

## 58. mode

Source: `packages/db/src/schema.ts:2866`.
Purpose: shared mode-name dictionary.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `mode_id` | serial | Other | Shared mode key; personal choice is in the usage association. |
| `mode` | text | Other | Shared mode label, not a user preference record by itself; custom content needs writer review. |

## 59. auto_model

Source: `packages/db/src/schema.ts:2875`.
Purpose: shared automatic-model label dictionary.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `auto_model_id` | serial | Other | Shared model dictionary key, rather than a user request identifier. |
| `auto_model` | text | Other | Shared model label; assignment to a user's activity is High in metadata. |

The `microdollar_usage_view` declaration at `packages/db/src/schema.ts:2884–3005` is encountered **between tables #59 and #60**. It is a `pgView`, **not a table**, and neither it nor its projected columns are counted in this batch. Its SQL joins usage, metadata, and the shared lookup dictionaries (`:2991–3004`), exposing derived user IDs, costs, prompt content, IP/location/fingerprint values, and activity choices together. A future view audit must assess that derived exposure and access/retention behavior; dictionary values classified Other here become personal context when joined to users.

## 60. custom_llm2

Source: `packages/db/src/schema.ts:3009`.
Purpose: custom model configuration and encrypted API-key material; the declared model definition associates organizations/groups, not a direct user owner.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `public_id` | text | Medium | Custom model identifier could encode a person or resolve to person-owned configuration; ownership uncertain. |
| `definition` | jsonb; CustomLlmDefinition | Medium | Organization/group IDs, display name, URL, arbitrary extra headers/body and model configuration per cited local types; possible personal content, no personal owner established. |
| `encrypted_api_key` | jsonb; EncryptedData | Medium | Encrypted credential envelope contains iv/data/authTag; shared versus personal credential ownership unknown, encryption is not anonymity. |

## 61. user_admin_notes

Source: `packages/db/src/schema.ts:3018`.
Purpose: staff-authored notes about identified users.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a note about a user. |
| `kilo_user_id` | text | High | Subject user identifier. |
| `note_content` | text | High | Explicitly user-related staff note; additional personal details/third parties unverified. |
| `admin_kilo_user_id` | text | High | Staff/admin author identity. |
| `created_at` | timestamptz | High | Time of staff activity concerning the user. |

## 62. user_feedback

Source: `packages/db/src/schema.ts:3038`.
Purpose: user feedback, product/source context, and submission activity; nulling the user foreign key does not prove content anonymous.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Linkable feedback submission identifier. |
| `kilo_user_id` | text | High | Feedback author's user identifier when populated. |
| `feedback_text` | text | High | User-authored feedback/opinion; additional personal contents unverified. |
| `feedback_for` | text | High | Subject of this user's feedback, not merely the shared category vocabulary. |
| `feedback_batch` | text | High | Grouping/cohort assignment of this user's feedback; actual label contents unverified. |
| `source` | text | High | Origin of this user's feedback submission. |
| `context_json` | jsonb; Record<string, unknown> | High | User-specific feedback context; only arbitrary keys/values declared, additional content unverified. |
| `created_at` | timestamptz | High | User feedback submission time. |

## 63. stytch_fingerprints

Source: `packages/db/src/schema.ts:3068`.
Purpose: user-linked device/network fingerprints, anti-abuse assessments, and eligibility decisions.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user's fingerprint assessment. |
| `kilo_user_id` | text | High | Assessed user's identifier. |
| `visitor_fingerprint` | text | High | Visitor correlation fingerprint; pseudonymization is not anonymity. |
| `browser_fingerprint` | text | High | Browser fingerprint associated with the user. |
| `browser_id` | text | High | User-associated browser identifier. |
| `hardware_fingerprint` | text | High | User-associated hardware fingerprint. |
| `network_fingerprint` | text | High | User-associated network fingerprint. |
| `visitor_id` | text | High | Visitor tracking identifier. |
| `verdict_action` | text | High | Anti-abuse decision concerning the user/device. |
| `detected_device_type` | text | High | Device characteristic of this user. |
| `is_authentic_device` | boolean | High | Authenticity assessment of the user's device. |
| `reasons` | text[] | High | Reasons for the user's assessment; additional textual personal content unverified. |
| `created_at` | timestamptz | High | Time of user assessment activity. |
| `status_code` | integer | High | Result/status of this user's fingerprint assessment. |
| `fingerprint_data` | jsonb | High | User-specific fingerprint assessment data; no members declared, additional contents unverified. |
| `kilo_free_tier_allowed` | boolean | High | User's free-tier eligibility decision. |
| `http_x_forwarded_for` | text | High | User-associated network address/header. |
| `http_x_vercel_ip_city` | text | High | City associated with this user activity, not an unassociated lookup label. |
| `http_x_vercel_ip_country` | text | High | Country associated with this user activity. |
| `http_x_vercel_ip_latitude` | real | High | User-associated request latitude. |
| `http_x_vercel_ip_longitude` | real | High | User-associated request longitude. |
| `http_x_vercel_ja4_digest` | text | High | Client fingerprint tied to this user. |
| `http_user_agent` | text | High | Client/browser information attached to an identified user. |

## 64. referral_codes

Source: `packages/db/src/schema.ts:3109`.
Purpose: user-owned referral codes and their allowed redemption capacity.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user's referral code record. |
| `kilo_user_id` | text | High | Referring user's identifier. |
| `code` | text | High | Public/opaque code resolves to a person; publicity does not remove personal relevance. |
| `max_redemptions` | integer | High | Referral entitlement/capacity assigned to this user, not generic plumbing. |
| `created_at` | timestamptz | High | User referral-code creation time. |
| `updated_at` | timestamptz | High | User referral-code update activity. |

## 65. referral_code_usages

Source: `packages/db/src/schema.ts:3131`.
Purpose: referral relationships, redemption activity, and associated payments.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of an interpersonal referral event. |
| `referring_kilo_user_id` | text | High | Identifies the referring person. |
| `redeeming_kilo_user_id` | text | High | Identifies the referred/redeeming person. |
| `code` | text | High | Referral code connecting identified people. |
| `amount_usd` | bigint | High | User-related referral payment amount. |
| `paid_at` | timestamptz | High | User-related referral payment time. |
| `created_at` | timestamptz | High | Referral usage creation activity. |
| `updated_at` | timestamptz | High | Referral usage update activity. |

## 66. organizations

Source: `packages/db/src/schema.ts:3165`.
Purpose: organization accounts, billing totals, settings, hierarchy, and creator attribution. Organization-only attributes remain Medium pending membership/sole-trader ownership review; settings explicitly permit personal email contacts.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | Medium | Organization identifier; natural-person owner/member mapping requires confirmation. |
| `name` | text | Medium | Organization name may identify a sole trader or contain personal names. |
| `created_at` | timestamptz | High | Organization creation activity attributable to the recorded user creator when populated. |
| `updated_at` | timestamptz | Medium | Organization edit time; editor identity or personal ownership not established. |
| `microdollars_used` | bigint | Medium | Organization aggregate spend, potentially person-linked but not necessarily any individual's spend. |
| `microdollars_balance` | bigint | Medium | Deprecated organization balance remains financial data; personal ownership unresolved. |
| `total_microdollars_acquired` | bigint | Medium | Organization credit total; personal financial ownership unresolved. |
| `next_credit_expiration_at` | timestamptz | Medium | Organization entitlement expiry, potentially personal through ownership. |
| `stripe_customer_id` | text | Medium | External organization customer reference; natural-person payer/account linkage needs review. |
| `auto_top_up_enabled` | boolean | Medium | Organization billing preference; personal controller/owner unresolved. |
| `settings` | jsonb; OrganizationSettings | High | Declared minimum_balance_alert_email array establishes personal contact content; other settings and extra runtime contents as discussed above. |
| `seat_count` | integer | Medium | Organization seat allocation may describe a small identifiable group; individual attribution unverified. |
| `require_seats` | boolean | Medium | Organization entitlement policy; member/owner linkage unverified. |
| `created_by_kilo_user_id` | text | High | Identifies organization creator, including staff/admin actors. |
| `deleted_at` | timestamptz | Medium | Organization lifecycle activity may concern owners; actor/ownership and deletion effects unverified. |
| `sso_domain` | text | Medium | Organization login domain could identify a person-owned domain or affiliation. |
| `parent_organization_id` | uuid | Medium | Organization hierarchy linkage; personal ownership/membership unresolved. |
| `plan` | text; OrganizationPlan | Medium | Organization's purchased plan, potentially personal through ownership rather than a shared plan dictionary. |
| `free_trial_end_at` | timestamptz | Medium | Organization trial entitlement time; personal beneficiary unresolved. |
| `company_domain` | text | Medium | Company/domain information may identify a natural-person business. |

## 67. organization_domain_claims

Source: `packages/db/src/schema.ts:3225`.
Purpose: organization domain ownership/verification records and external WorkOS references; no natural-person actor is declared.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | Medium | Organization domain-claim identifier; personal ownership unverified. |
| `organization_id` | uuid | Medium | Organization owner reference requiring membership/ownership review. |
| `domain` | text | Medium | Claimed domain may identify a person-owned business or individual. |
| `status` | text; OrganizationDomainClaimStatus | Medium | Verification state of a potentially person-owned domain, not a shared status dictionary. |
| `workos_organization_id` | text | Medium | External organization identifier; personal identity linkage unverified. |
| `workos_domain_id` | text | Medium | External domain-claim reference; possible natural-person domain ownership. |
| `verified_at` | timestamptz | Medium | Domain verification activity time; actor/owner personal linkage unresolved. |
| `created_at` | timestamptz | Medium | Organization claim creation time; no identified individual actor declared. |
| `updated_at` | timestamptz | Medium | Organization claim update activity; individual attribution unresolved. |

## 68. kilo_pass_org_term_versions

Source: `packages/db/src/schema.ts:3274`.
Purpose: reusable organization pass term/pricing versions, distinct from an organization's purchased agreement, with creator attribution.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | Other | Shared term-version identifier, not a customer transaction ID. |
| `version_key` | text | Medium | Unconstrained version label could encode a customer/person; naming writers unverified. |
| `tier` | text; KiloPassTier | Other | Shared product tier definition, not an individual's selection. |
| `cadence` | text; KiloPassCadence | Other | Shared term billing cadence. |
| `billing_price_microdollars_per_pass` | bigint | Other | Reusable unit price, not a user's actual payment. |
| `base_credit_microdollars_per_pass` | bigint | Other | Shared per-pass credit term. |
| `bonus_credit_microdollars_per_pass` | bigint | Other | Shared per-pass bonus term. |
| `unlock_spend_microdollars_per_pass` | bigint | Other | Shared qualifying-spend threshold, not observed user spending. |
| `bonus_mode` | text; KiloPassOrgBonusMode | Other | Shared bonus mechanics configuration. |
| `created_by_kilo_user_id` | text | High | Staff/admin creator identifier. |
| `created_at` | timestamptz | High | Creation activity attributable to the identified term creator. |

## 69. kilo_pass_org_agreements

Source: `packages/db/src/schema.ts:3311`.
Purpose: organization-specific pass purchase agreements and billing lifecycle; unlike shared terms, these describe an organization's actual account, with natural-person payer/controller linkage unresolved.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | Medium | Organization financial agreement identifier; natural-person ownership unverified. |
| `parent_organization_id` | uuid | Medium | Organization purchasing entity reference, potentially person-owned. |
| `term_version_id` | uuid | Medium | Terms selected by this organization, not an unassociated shared dictionary key. |
| `state` | text; KiloPassOrgAgreementState | Medium | Organization agreement lifecycle state; personal beneficiary unresolved. |
| `processing_condition` | text; KiloPassOrgProcessingCondition | Medium | Account-specific processing assessment, potentially relevant to a natural-person owner. |
| `purchase_channel` | text; KiloPassOrgPurchaseChannel | Medium | Organization purchasing behavior; individual purchaser not established. |
| `cadence` | text; KiloPassCadence | Medium | Organization's actual billing choice; personal controller unverified. |
| `purchased_pass_capacity` | integer | Medium | Actual organization purchase capacity, possibly attributable to an individual owner. |
| `next_purchased_pass_capacity` | integer | Medium | Organization's scheduled purchase change; requester/owner unresolved. |
| `next_capacity_effective_at` | timestamptz | Medium | Organization purchase-change effective time; personal linkage unresolved. |
| `paid_from` | timestamptz | Medium | Organization paid entitlement start, potentially person-linked. |
| `paid_until` | timestamptz | Medium | Organization paid entitlement end, potentially person-linked. |
| `issuance_anchor_at` | timestamptz | Medium | Account-specific credit issuance schedule; personal ownership unresolved. |
| `provider_subscription_id` | text | Medium | External organization subscription identifier; natural-person payer resolution needed. |
| `provider_seat_add_on_item_id` | text | Medium | External organization billing-item identifier; payer ownership uncertain. |
| `activation_provider_event_id` | text | Medium | External financial activation event; possible personal payer linkage requires tracing. |
| `external_contract_id` | text | Medium | Contract reference may identify a natural-person contracting party. |
| `payment_review_required_at` | timestamptz | Medium | Organization payment review activity, possibly concerning a natural-person payer. |
| `cancellation_effective_at` | timestamptz | Medium | Organization subscription cancellation time; personal requester/beneficiary unresolved. |
| `manually_issued_through` | timestamptz | Medium | Organization credit issuance coverage; individual recipient/controller unresolved. |
| `created_at` | timestamptz | Medium | Organization agreement creation activity; no individual actor declared here. |
| `updated_at` | timestamptz | Medium | Organization agreement update activity; editor/owner linkage needs confirmation. |

## 70. kilo_pass_org_term_transitions

Source: `packages/db/src/schema.ts:3397`.
Purpose: staff/user-attributed changes between an organization's term versions; selected values describe the actor's recorded action, even when organization finances are not personal finances.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a transition attributable to the recorded user creator. |
| `agreement_id` | uuid | Medium | Organization agreement target; natural-person ownership unresolved. |
| `from_term_version_id` | uuid | High | Prior terms changed in the identified actor's action. |
| `to_term_version_id` | uuid | High | New terms selected in the identified actor's action. |
| `effective_at` | timestamptz | High | Effective time chosen for the actor-attributed change. |
| `created_by_kilo_user_id` | text | High | Staff/admin/user responsible for creating the transition. |
| `reason` | text | Medium | Free-text rationale may include personal details; additional contents unverified despite actor linkage. |
| `created_at` | timestamptz | High | Time of the creator's term-change activity. |

## 71. kilo_pass_org_allocation_plans

Source: `packages/db/src/schema.ts:3439`.
Purpose: versioned organization pass-allocation plans with individual creator attribution.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a plan attributable to an individual creator. |
| `agreement_id` | uuid | Medium | Organization purchase agreement; natural-person ownership unresolved. |
| `effective_window_start` | timestamptz | High | Effective time of the creator-attributed allocation decision. |
| `version` | integer | Other | Plan revision ordinal for sequencing/uniqueness, retained within an actor-attributed record. |
| `created_by_kilo_user_id` | text | High | Identifies plan creator, including staff/admin. |
| `created_at` | timestamptz | High | Time of the identified creator's planning activity. |

## 72. kilo_pass_org_allocation_plan_rows

Source: `packages/db/src/schema.ts:3470`.
Purpose: allocation decisions within creator-attributed plans; personal actor linkage is indirect through `allocation_plan_id`.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of an allocation decision linkable to the plan's creator. |
| `allocation_plan_id` | uuid | High | Resolves to the individually attributed allocation plan. |
| `allocation_container_organization_id` | uuid | Medium | Recipient organization reference; natural-person ownership/membership unresolved. |
| `pass_capacity` | integer | High | Capacity decision recorded as part of the identifiable creator's plan. |
| `created_at` | timestamptz | High | Creation time of a decision in the actor-attributed plan. |

## 73. kilo_pass_org_processing_runs

Source: `packages/db/src/schema.ts:3504`.
Purpose: processing lifecycle of organization agreement windows; no direct user actor/recipient is declared on this row.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | Medium | Organization processing identifier; possible personal linkage through agreements/deliveries requires review. |
| `agreement_id` | uuid | Medium | Organization financial agreement reference; personal payer linkage unresolved. |
| `window_start` | timestamptz | Medium | Account-specific processing period, potentially person-linked through ownership. |
| `window_end` | timestamptz | Medium | Account-specific period end; natural-person ownership unresolved. |
| `state` | text; KiloPassOrgProcessingRunState | Medium | Organization account processing outcome; personal linkage unresolved. |
| `idempotency_key` | text | Medium | Correlatable organization operation identifier, not dismissed as plumbing; contents/owner unresolved. |
| `lease_expires_at` | timestamptz | Medium | Organization processing lifecycle time; possible personal linkage unresolved. |
| `attempt_count` | integer | Other | Narrow processing retry counter; not an activity/financial quantity for a person. |
| `failure_code` | text | Medium | Account-specific diagnostic code may carry personal context; vocabulary/writers unverified. |
| `created_at` | timestamptz | Medium | Organization processing creation time; personal ownership/actor unresolved. |
| `updated_at` | timestamptz | Medium | Organization processing update time; personal ownership/actor unresolved. |

## 74. kilo_pass_org_notification_deliveries

Source: `packages/db/src/schema.ts:3550`.
Purpose: organization-run notifications to explicitly identified individual recipients.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a person's notification delivery. |
| `processing_run_id` | uuid | High | Associates this person with the organization processing event being notified. |
| `recipient_kilo_user_id` | text | High | Identifies the notification recipient. |
| `status` | text; 'pending' or 'sending' or 'sent' or 'failed' | High | Delivery outcome/state for this person. |
| `attempt_count` | integer | Other | Notification retry plumbing counter, retained within a personal delivery record. |
| `lease_expires_at` | timestamptz | High | Processing lifecycle time of the recipient's notification. |
| `sent_at` | timestamptz | High | Time the person was sent a notification. |
| `created_at` | timestamptz | High | Creation time of the recipient's notification. |
| `updated_at` | timestamptz | High | Update time of the recipient's delivery record. |

## 75. kilo_pass_org_issuance_snapshots

Source: `packages/db/src/schema.ts:3597`.
Purpose: organization credit issuances, allocation decisions, and bonus qualification snapshots. Nullable credit references resolve to `credit_transactions` with mandatory `kilo_user_id` (`packages/db/src/schema.ts:312–319`); allocation plans also expose creator attribution. High financial/activity classifications reflect that indirect personal linkage when populated, not proof all organization spending belongs to one person.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Issuance identifier linkable to user-associated credit transactions and attributed allocation decisions. |
| `agreement_id` | uuid | Medium | Organization agreement identifier; natural-person account ownership unresolved. |
| `processing_run_id` | uuid | Medium | Organization processing reference; individual processing actor/owner not established. |
| `allocation_plan_id` | uuid | High | Link to the creator-attributed allocation decision. |
| `term_version_id` | uuid | High | Terms applied to this linkable credit issuance, not merely shared term vocabulary. |
| `allocation_container_organization_id` | uuid | Medium | Organization receiving allocation; personal ownership/membership unresolved. |
| `window_start` | timestamptz | High | Start of the user-linkable credit issuance window. |
| `window_end` | timestamptz | High | End of the user-linkable credit issuance window. |
| `qualifying_spend_starts_at` | timestamptz | High | Spending qualification boundary for the linkable financial record. |
| `kind` | text; KiloPassOrgIssuanceKind | High | Kind of credits in the user-linkable issuance. |
| `tranche_key` | text | High | Correlatable tranche identifier for this credit issuance. |
| `allocated_pass_capacity` | integer | High | Capacity applied in the attributed allocation/credit issuance. |
| `base_credit_microdollars` | bigint | High | Base amount associated with the linkable financial issuance. |
| `bonus_credit_microdollars` | bigint | High | Bonus amount associated with the linkable financial issuance. |
| `unlock_spend_microdollars` | bigint | High | Spend requirement applied to the linkable credit entitlement. |
| `qualifying_spend_microdollars` | bigint | High | Actual qualifying spend attached to the linkable financial record. |
| `bonus_mode` | text; KiloPassOrgBonusMode | High | Bonus rule applied to this issuance rather than shared configuration alone. |
| `bonus_unlocked_at` | timestamptz | High | Bonus eligibility event time in the linkable issuance. |
| `repair_completed_at` | timestamptz | High | Repair lifecycle time for this linkable credit issuance. |
| `bonus_credit_transaction_id` | uuid | High | Resolves to a credit ledger entry with a mandatory user identifier. |
| `base_credit_transaction_id` | uuid | High | Resolves to a credit ledger entry with a mandatory user identifier. |
| `created_at` | timestamptz | High | Creation time of a user-linkable credit issuance snapshot. |

## 76. kilo_pass_org_supplements

Source: `packages/db/src/schema.ts:3682`.
Purpose: supplemental issuance proration and invoice linkage, indirectly linked to credit-ledger users through issuance snapshots.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a supplement to a user-linkable issuance. |
| `issuance_snapshot_id` | uuid | High | Links supplement to issuance and its user-associated credit ledger entries. |
| `provider_invoice_line_id` | text | High | External invoice-line identifier in the linkable financial chain. |
| `remaining_service_numerator` | bigint | High | Financial proration quantity for the linked issuance, not a generic technical counter. |
| `remaining_service_denominator` | bigint | High | Financial proration basis for the linked issuance. |
| `created_at` | timestamptz | High | Creation time of the linkable supplemental credit activity. |

## 77. kilo_pass_org_qualifying_spend_events

Source: `packages/db/src/schema.ts:3709`.
Purpose: credit-backed qualifying spend events; mandatory `credit_transaction_id` resolves to a ledger record with a user identifier.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user-linkable spending event. |
| `issuance_snapshot_id` | uuid | High | Issuance association of the identified ledger user's spending event. |
| `allocation_container_organization_id` | uuid | Medium | Organization allocation context; natural-person organizational ownership unresolved. |
| `credit_transaction_id` | uuid | High | Mandatory reference to a user-associated financial transaction. |
| `spent_microdollars` | bigint | High | Spending amount tied to the identified ledger user. |
| `occurred_at` | timestamptz | High | Time of the user-linkable spending event. |
| `created_at` | timestamptz | High | Recording time of the user-linkable spending event. |

## 78. kilo_pass_org_audit_records

Source: `packages/db/src/schema.ts:3748`.
Purpose: organization agreement action audit trail with individual actor attribution and before/after details.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of an audit event attributable to a person. |
| `agreement_id` | uuid | Medium | Organization financial agreement target; personal ownership uncertain. |
| `actor_kilo_user_id` | text | High | Staff/admin/user actor identity. |
| `action` | text | High | Action performed by the identified actor. |
| `reason` | text | Medium | Unconstrained rationale may embed personal details; exact contents unverified despite actor linkage. |
| `before_json` | jsonb; Record<string, unknown> or null | High | Before-state details of the actor-attributed action; generic keys/values only, additional personal contents unverified. |
| `after_json` | jsonb; Record<string, unknown> or null | High | After-state details of the actor-attributed action; no specific members declared, additional contents unverified. |
| `idempotency_key` | text | High | Correlation key identifying the actor-attributed operation. |
| `created_at` | timestamptz | High | Time of the person's recorded action. |

## 79. organization_memberships

Source: `packages/db/src/schema.ts:3781`.
Purpose: explicit individual organization affiliations, roles, invitation provenance, and membership lifecycle.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a person's membership relationship. |
| `organization_id` | uuid | High | Explicitly records this user's organizational affiliation, unlike an unresolved organization-only owner reference. |
| `kilo_user_id` | text | High | Member identity. |
| `role` | text; OrganizationRole | High | Person's organization role and permissions, including administrative/billing roles. |
| `joined_at` | timestamptz | High | Time the person joined the organization. |
| `invited_by` | text | High | Inviter attribution; exact identifier format is unspecified but concerns a person. |
| `updated_at` | timestamptz | High | Membership update activity. |
| `created_at` | timestamptz | High | Creation time of the person's membership record. |

## 80. organization_groups

Source: `packages/db/src/schema.ts:3805`.
Purpose: organization access-policy groups with creator attribution; individual group assignments are in next-batch table #81, not inventoried here.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | Medium | Group identifier can link to people via assignments; membership/ownership contents not reviewed in this batch. |
| `organization_id` | uuid | Medium | Organization owning the group; natural-person membership/ownership unresolved. |
| `name` | text | Medium | Custom group name may contain personal names or identify a small group. |
| `description` | text | Medium | Free-text group description may contain personal details. |
| `policies` | jsonb; OrganizationGroupPolicies | Medium | Declared model/provider access rules govern groups; individual assignment and custom string contents uncertain, no member IDs declared inside JSON. |
| `created_by_kilo_user_id` | text | High | Identifies group creator, including staff/admin. |
| `created_at` | timestamptz | High | Creation activity attributable to the group's recorded creator. |
| `updated_at` | timestamptz | Medium | Group configuration update time; individual editor/subject attribution not established. |

## Verification and limitations

A read-only TypeScript AST extraction/check of `packages/db/src/schema.ts` passed for **40 ordered tables and 360 ordered physical columns**, with **244 High, 88 Medium, and 28 Other**. It checked exact physical names, one inventory entry per column, no omissions/extras/reordering, global table numbers, declaration source lines, base SQL types, timestamp timezone/string mode, date string mode, array types, resolved column helpers, and declared `$type` annotations. Per-table summary counts and classification totals matched. The AST confirmed that `microdollar_usage_view` is a view between #59 and #60 and that the next table is #81 `organization_group_memberships` at line 3843. The parser enumerated declarations to select this range; inventories outside #41–80 were not audited. The validator ran from an external scratch path and wrote no schema/repository files.

This inventory follows source declaration order, not alphabetical or database-catalog order. AST validation establishes structural inventory accuracy, not the truth of personal-data judgments or deployed schema equivalence. JSON shapes and reasons were reviewed from source, not mechanically proven or checked against actual rows. No application writers were traced; no runtime validation, deletion/anonymization, retention, backups, or external identity resolution was tested. Nulls, foreign-key actions, redaction labels, hashing, and encryption do not establish anonymity or erasure.

## Material follow-ups

1. **Payload and dictionary writers:** inspect constraints/writers for payment JSON, API request/response/error data, feedback context, fingerprint data, audit snapshots, and diagnostic/free text. Confirm whether shared dictionary strings are exclusively expected geography/product labels or may contain custom personal values. Verify system-prompt and user-agent content, without copying live values/secrets into audit files.
2. **Organization and credential ownership:** resolve organization payers, sole traders, members, group assignments, staff actions, custom model visibility, and encrypted-key ownership. Verify credit-ledger user attribution semantics before treating organization aggregates as any individual's finances. Review actual model extra headers/body and runtime validation, not the separate credential type by assumption.
3. **Views and derived data:** audit `microdollar_usage_view` separately, including the join-derived exposure of source tables and shared dictionary values. Review usage rollups, query access, downstream extracts, analytics, and telemetry; user-keyed aggregates are not anonymous.
4. **Retention and deletion:** trace actual soft/hard deletion, anonymization, export coverage, schedules, failures, foreign-key nulling, orphan lookup values, external providers, replicas/backups, and retained staff history. A declared `deleted_at`, redacted error name, or cascade is not runtime evidence of compliance.
5. **Next batch:** begin with **#81, `organization_group_memberships`**, `packages/db/src/schema.ts:3843`. Other database/storage systems and view inventories remain outside this table batch.
