# Personal data audit — batch 03

## Scope, date, and sources

- Date: 2026-09-03.
- Scope: `pgTable` declarations **#81–120 inclusive** in `packages/db/src/schema.ts`, from `organization_group_memberships` through `cloud_agent_code_review_attempts`: **40 tables and 487 physical columns**. This is the next bounded installment after batches 01/02, not all remaining PostgreSQL tables. The next declaration is **#121 `code_review_analytics_results`** at `packages/db/src/schema.ts:5667`.
- Sources: root `AGENTS.md`, `packages/db/AGENTS.md`, the introduction and representative rows of `personal-data-audit-batch-02.md`, root and database package manifests, `packages/db/src/schema.ts:3843–5663`, and the local type definitions cited below. Table citations identify declaration starts in this checkout. Physical table `organization_modes` is included despite its misspelled TypeScript export `orgnaization_modes`.
- This is a **source-only preliminary audit** using the broad definition **any data about a user**, including prospective users, external contributors, PR authors, and staff. No live rows, secrets, deployed catalogs, application writers, runtime payloads, or retention/deletion execution were inspected or validated. This is not a legal determination.
- Every physical column appears once in its table inventory, in declaration order. JSON members are evidence, not extra physical columns. Types describe PostgreSQL storage: `timestamptz` denotes `timestamp({ withTimezone: true, mode: 'string' })`; `date` uses default string mode; `decimal` is the PostgreSQL `numeric` alias, with precision and scale shown when declared. `number mode` records the explicit Drizzle mapping, not a different SQL type. `vector(1536)` records dimensions, and `text[]` is a physical array. `serial` is the integer sequence shorthand.
- `idPrimaryKeyColumn` resolves to `uuid().default(...).primaryKey().notNull()` at `packages/db/src/schema.ts:3160–3163`; uses are annotated in the inventory. Other annotations after `;` name declared TypeScript `$type` shapes; `or` renders union separators. A JSON array annotation is not a PostgreSQL array. Nullability/defaults are omitted. TypeScript annotations do not establish runtime validation. User IDs are arbitrary text, not necessarily UUIDs.

## Classification legend

| Classification | Meaning |
| --- | --- |
| High | High confidence of personal relevance: direct/indirect, external, opaque, hashed, or encrypted identifiers; user-associated financial data, activity, preferences, content, assessments, lifecycle timestamps, and staff actions. This is confidence, not a sensitivity ranking. |
| Medium | Personal content or natural-person ownership remains uncertain, including free text/JSON with unclear contents, organization-only records, and shared/bot credentials. Requires content, writer, or ownership review; does not declare the enclosing record nonpersonal. |
| Other | Genuinely shared configuration/vocabulary/model metrics or narrow technical plumbing without independent personal meaning established here. Not a claim that an enclosing record is safe to publish or can be excluded from privacy handling. |

Row linkage matters. Membership/invitation rows directly describe a person and their organization/group relationship. User-capable integrations, deployments, automation, and code-review records are conservatively High for identifiers and bound activity/settings, even when some rows are organization-owned; the organization-only ownership reference itself remains Medium where it does not establish a person's membership. Child builds, events, environment settings, threats, and review attempts inherit linkage through their parent. A nullable user/actor reference, `SET NULL`, hashing, encryption, or a public contribution does not prove anonymity. No claim is made that every row identifies a natural person, or that an organization bill is its administrator's personal spending.

Shared model metrics are distinguished from a staff member's promotion action; the metric itself is not the staff member's performance or spend. Retry/optimistic-concurrency version counters are narrow plumbing exceptions, but authentication-attempt counts and user-workload counts describe activity and remain High. Generic diagnostic text is Medium pending content review even where surrounding job status and timestamps are High. For JSON classified High, record context or declared content establishes personal relevance; undeclared members are not assumed.

## Local JSON/type evidence

- `OrganizationGroupPolicies` (`packages/db/src/schema-types.ts:1022–1038`) is an array of model-access policies, with all/none/selected mode and selected model/provider allow lists. It declares no member identities. Organization defaults are Medium; runtime contracts are delegated to the web app and were not traced.
- `OrganizationModeConfig` (`packages/db/src/schema-types.ts:1040–1061`) contains role definition, optional usage/description/custom instructions, and tool groups; edit-group tuples can contain `fileRegex` and description. The physical column uses `Partial<OrganizationModeConfig>`. Shared organizational text may embed names or paths; actual contents are unknown.
- `IntegrationPermissions` is `Record<string, string>`; `PlatformRepository` has `id`, `name`, `full_name`, `private`, and optional `default_branch` (`packages/db/src/schema-types.ts:1260–1268`). Repositories here use number-or-string IDs. These support account-linked access/repository metadata, not invented owner/email members.
- `CodeReviewAgentConfig` (`packages/db/src/schema-types.ts:1668–1714`) includes review/model preferences, custom instructions, repository selections/overrides, council settings, gate thresholds, and memory/analytics flags. Supporting repository definitions are at `:1407–1414` and `:1651–1666`; council configuration at `:1500–1587` includes specialist IDs/names/lenses/instructions and model settings. Specialist identities are software-role configuration, not assumed human identities. `agent_configs.config` also accepts arbitrary `Record<string, unknown>`; `runtime_state` is an arbitrary record, so additional members are unverified.
- `ManualCodeReviewConfig` (`packages/db/src/schema-types.ts:1716–1724`) contains `agentConfig`, nullable instructions, and output mode. `CodeReviewCouncilResult` (`:1592–1639`) includes aggregate decision/strategy and specialist results with names, model/effort, votes, severities, and findings containing path, optional line, and rationale. These are settings/content/assessments associated with a review and PR author, not a claim that specialist names identify humans.
- `ReviewMemoryEvidenceItem` (`packages/db/src/schema-types.ts:1284`) contains only `excerpt` and nullable `prNumber`. It supports feedback-content and PR linkage; no author/email member is assumed.
- `OpenRouterModel` (`packages/db/src/schema-types.ts:1881–1917`) combines model slug/name/author/description, modalities/context/group/update time, and nullable endpoint with provider display name, pricing, and data policy. `NormalizedOpenRouterResponse` (`:1954–1981`) adds provider names/slugs/policies, optional headquarters/datacenters/icon, model arrays, counts, and generation time. Free strings, author names, and URLs require content review even though these are shared catalogs.
- `StoredModel` (`packages/db/src/schema-types.ts:2147–2193`) combines model ID/name/type/reasoning settings with endpoints containing optional tag/provider name/context length and pricing strings. These are catalog objects, not declared user prompts or credentials; shared names/tags retain content uncertainty. The nested reasoning-effort vocabulary is defined at `packages/db/src/schema-types.ts:2004–2014`.
- `ModelStatsBenchmarks` (`packages/db/src/schema.ts:5076–5117`) declares optional Artificial Analysis scores/update time and Kilo benchmark scores plus evaluation records containing task source/display name, costs/tokens/timing/trial counts/errors/promotion time. `ModelStatsChartData` (`:5119–5147`) declares weekly date/token points and mode rankings with update times. No user identifiers are declared; text provenance and aggregation/cohort guarantees remain unverified, so both JSON columns are Medium.
- Untyped JSON columns include enrichment payloads, integration metadata, provider metadata, deployment-event payloads, search metadata, and webhook payloads/headers/errors. User-linked enrichment/search/content is High by context, not by presumed members. Integration metadata, provider metadata, webhook headers/errors, and generic runtime state are Medium for unknown contents. No credential/header values were read and no redaction claim is made.
- Supporting scalar aliases include organization roles (`packages/db/src/schema-types.ts:935–939`), audit actions (`:1168–1210`), deployment provider/build status (`:1288–1301`), contributor tiers (`:920–927`), review-memory enums (`:1270–1282`), review type/source (`:1450–1457`), and organization limit/subscription/billing-cycle types (`packages/db/src/schema.ts:3955–3956`, `:4014–4025`). `CodeReviewPlatform` is re-exported from `@kilocode/app-shared/code-review` (`packages/db/src/schema-types.ts:1405`); physical storage remains text.

## Table summary

Classification totals: **370 High**, **70 Medium**, **47 Other** (487 columns).

| # | Table | Columns | High | Medium | Other |
| --- | --- | ---: | ---: | ---: | ---: |
| 81 | organization_group_memberships | 5 | 5 | 0 | 0 |
| 82 | organization_group_policy_settings | 6 | 2 | 3 | 1 |
| 83 | organization_membership_removals | 6 | 6 | 0 | 0 |
| 84 | organization_invitations | 12 | 12 | 0 | 0 |
| 85 | organization_user_limits | 7 | 7 | 0 | 0 |
| 86 | organization_user_usage | 8 | 8 | 0 | 0 |
| 87 | organization_seats_purchases | 12 | 0 | 12 | 0 |
| 88 | organization_audit_logs | 8 | 8 | 0 | 0 |
| 89 | organization_modes | 8 | 2 | 6 | 0 |
| 90 | enrichment_data | 7 | 7 | 0 | 0 |
| 91 | source_embeddings | 13 | 13 | 0 | 0 |
| 92 | platform_integrations | 26 | 23 | 3 | 0 |
| 93 | user_github_app_tokens | 15 | 13 | 1 | 1 |
| 94 | platform_oauth_credentials | 18 | 14 | 3 | 1 |
| 95 | platform_access_token_credentials | 19 | 15 | 3 | 1 |
| 96 | slack_oauth_credentials | 20 | 10 | 8 | 2 |
| 97 | deployments | 17 | 16 | 1 | 0 |
| 98 | deployments_ephemeral | 12 | 12 | 0 | 0 |
| 99 | deployment_env_vars | 7 | 7 | 0 | 0 |
| 100 | deployment_builds | 6 | 6 | 0 | 0 |
| 101 | deployment_events | 5 | 5 | 0 | 0 |
| 102 | deployment_threat_detections | 5 | 5 | 0 | 0 |
| 103 | code_indexing_search | 7 | 7 | 0 | 0 |
| 104 | code_indexing_manifest | 11 | 10 | 1 | 0 |
| 105 | agent_configs | 12 | 9 | 2 | 1 |
| 106 | organization_recommendation_dismissals | 5 | 5 | 0 | 0 |
| 107 | webhook_events | 14 | 11 | 3 | 0 |
| 108 | cloud_agent_webhook_triggers | 14 | 13 | 1 | 0 |
| 109 | magic_link_tokens | 9 | 9 | 0 | 0 |
| 110 | model_stats | 25 | 0 | 7 | 18 |
| 111 | model_eval_ingestions | 26 | 5 | 3 | 18 |
| 112 | contributor_champion_contributors | 10 | 10 | 0 | 0 |
| 113 | contributor_champion_events | 10 | 10 | 0 | 0 |
| 114 | contributor_champion_memberships | 10 | 10 | 0 | 0 |
| 115 | contributor_champion_sync_state | 4 | 0 | 2 | 2 |
| 116 | models_by_provider | 4 | 0 | 3 | 1 |
| 117 | cloud_agent_code_reviews | 40 | 37 | 3 | 0 |
| 118 | code_review_feedback_events | 12 | 11 | 1 | 0 |
| 119 | code_review_memory_proposals | 16 | 15 | 1 | 0 |
| 120 | cloud_agent_code_review_attempts | 16 | 12 | 3 | 1 |
| | **Total** | **487** | **370** | **70** | **47** |

## 81. organization_group_memberships

Source: `packages/db/src/schema.ts:3843`.
Purpose: assigns organization members to groups, recording assigner and assignment time.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `organization_id` | uuid | High | Organization affiliation of the identified member. |
| `group_id` | uuid | High | Group assignment of the identified member. |
| `kilo_user_id` | text | High | Identifies the member. |
| `assigned_by_kilo_user_id` | text | High | Identifies the assigning user or staff actor. |
| `created_at` | timestamptz | High | Time of the person's group assignment. |

## 82. organization_group_policy_settings

Source: `packages/db/src/schema.ts:3879`.
Purpose: organization-wide default group policy and last updater attribution.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `organization_id` | uuid | Medium | Organization-only policy owner; natural-person relationship needs joins. |
| `default_policies` | jsonb; OrganizationGroupPolicies | Medium | Shared organization access policies; member effects require membership joins. |
| `policy_revision` | integer | Other | Narrow policy-version bookkeeping; enclosing record remains attributable. |
| `updated_by_kilo_user_id` | text | High | User responsible for the policy update. |
| `created_at` | timestamptz | Medium | Organization policy lifecycle time without declared creator. |
| `updated_at` | timestamptz | High | Time associated with the recorded updater's action. |

## 83. organization_membership_removals

Source: `packages/db/src/schema.ts:3905`.
Purpose: retains a user's removed membership, previous role, and removing actor.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid; idPrimaryKeyColumn | High | Identifier of a person's membership-removal record. |
| `organization_id` | uuid | High | Organization from which the person was removed. |
| `kilo_user_id` | text | High | Identifies the removed member. |
| `removed_at` | timestamptz | High | Time of the user's membership removal. |
| `removed_by` | text | High | Removing actor attribution. |
| `previous_role` | text; OrganizationRole | High | Person's former organizational role. |

## 84. organization_invitations

Source: `packages/db/src/schema.ts:3924`.
Purpose: email-addressed invitations with access role, authentication requirements, and acceptance lifecycle.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid; idPrimaryKeyColumn | High | Identifier of an invitation to a person. |
| `organization_id` | uuid | High | Organization to which the recipient is invited. |
| `email` | text | High | Recipient email identity. |
| `role` | text; OrganizationRole | High | Role offered to the recipient. |
| `invited_by` | text | High | Identifies the inviting actor. |
| `token` | text | High | Recipient-linked invitation credential; opaque is not anonymous. |
| `expires_at` | timestamptz | High | Expiry of the recipient's invitation. |
| `accepted_at` | timestamptz | High | Recipient acceptance activity time. |
| `authentication_requirement` | text; 'default' or 'workos' | High | Authentication condition for this recipient's access. |
| `sso_source_organization_id` | uuid | High | SSO organization context attached to the recipient's invitation. |
| `updated_at` | timestamptz | High | Update time of the person-specific invitation. |
| `created_at` | timestamptz | High | Invitation issuance activity time. |

## 85. organization_user_limits

Source: `packages/db/src/schema.ts:3958`.
Purpose: per-user spending limits within an organization.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid; idPrimaryKeyColumn | High | Identifier of an individual limit record. |
| `organization_id` | uuid | High | Organization scope of this user's limit. |
| `kilo_user_id` | text | High | User subject to the limit. |
| `limit_type` | text; OrganizationUserLimitType | High | Limit period applied to this user. |
| `microdollar_limit` | bigint; number mode | High | User-specific financial allowance. |
| `created_at` | timestamptz | High | Creation time of the user's allowance. |
| `updated_at` | timestamptz | High | Update time of the user's allowance. |

## 86. organization_user_usage

Source: `packages/db/src/schema.ts:3985`.
Purpose: user-attributed organizational usage by date and limit period; user-keyed aggregation is not anonymization.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid; idPrimaryKeyColumn | High | Identifier of a user's usage aggregate. |
| `organization_id` | uuid | High | Organization scope of the user's consumption. |
| `kilo_user_id` | text | High | Identifies the consuming user. |
| `usage_date` | date | High | Date of the user's activity. |
| `limit_type` | text; OrganizationUserLimitType | High | Accounting period applied to the user's usage. |
| `microdollar_usage` | bigint; number mode | High | User-attributed financial consumption. |
| `created_at` | timestamptz | High | Creation time of the user's usage record. |
| `updated_at` | timestamptz | High | Update time of the user's usage record. |

## 87. organization_seats_purchases

Source: `packages/db/src/schema.ts:4027`.
Purpose: organization-level seat subscriptions and purchase periods; individual purchaser/beneficiary linkage is not declared here.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid; idPrimaryKeyColumn | Medium | Organization purchase identifier; individual association requires joins. |
| `organization_id` | uuid | Medium | Organization-level financial owner. |
| `subscription_stripe_id` | text | Medium | External organization subscription identifier; customer identity unverified. |
| `seat_count` | integer | Medium | Organization entitlement size, not assigned seats here. |
| `amount_usd` | decimal; number mode | Medium | Organization purchase amount; not established as a person's spend. |
| `created_at` | timestamptz | Medium | Organization purchase lifecycle time. |
| `expires_at` | timestamptz | Medium | Organization entitlement expiry. |
| `updated_at` | timestamptz | Medium | Organization subscription update time. |
| `subscription_status` | text; SubscriptionStatus | Medium | Organization financial status, individual relevance requires joins. |
| `idempotency_key` | text | Medium | Correlates organization purchase processing; external identity linkage uncertain. |
| `starts_at` | timestamptz | Medium | Organization entitlement start time. |
| `billing_cycle` | text; BillingCycle | Medium | Organization billing preference, individual ownership unverified. |

## 88. organization_audit_logs

Source: `packages/db/src/schema.ts:4060`.
Purpose: actor-attributed organization administrative actions and messages.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid; idPrimaryKeyColumn | High | Identifier of an attributable audit event. |
| `action` | text; AuditLogAction | High | Recorded action of a user or staff actor. |
| `actor_id` | text | High | Actor identity. |
| `actor_email` | text | High | Actor email address. |
| `actor_name` | text | High | Actor display/name identity. |
| `organization_id` | uuid | High | Organization context of the recorded actor's action. |
| `message` | text | High | Narrative of attributable administrative activity; may describe other people. |
| `created_at` | timestamptz | High | Time of the attributable audit event. |

## 89. organization_modes

Source: `packages/db/src/schema.ts:4084`.
Purpose: organization-shared custom modes and creator attribution; physical name differs from export `orgnaization_modes`.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid; idPrimaryKeyColumn | Medium | Shared organization mode identifier; individual use needs joins. |
| `organization_id` | uuid | Medium | Organization owner, not individual ownership. |
| `name` | text | Medium | Custom shared name may include personal information. |
| `slug` | text | Medium | Custom shared identifier may embed personal labels. |
| `created_by` | text | High | Identifies the mode creator. |
| `created_at` | timestamptz | High | Time of the identified creator's action. |
| `updated_at` | timestamptz | Medium | Shared mode update time without updater attribution. |
| `config` | jsonb; Partial<OrganizationModeConfig> | Medium | Shared instructions/descriptions/path patterns may embed personal content. |

## 90. enrichment_data

Source: `packages/db/src/schema.ts:4107`.
Purpose: user-linked enrichment data from named external sources, with no declared JSON member shapes.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid; idPrimaryKeyColumn | High | Identifier of the user's enrichment record. |
| `user_id` | text | High | Identifies the enriched user. |
| `github_enrichment_data` | jsonb | High | Enrichment about the user; exact GitHub payload unverified. |
| `linkedin_enrichment_data` | jsonb | High | Enrichment about the user; exact LinkedIn payload unverified. |
| `clay_enrichment_data` | jsonb | High | Enrichment about the user; exact Clay payload unverified. |
| `created_at` | timestamptz | High | Time the user's enrichment record was created. |
| `updated_at` | timestamptz | High | Time the user's enrichment record was updated. |

## 91. source_embeddings

Source: `packages/db/src/schema.ts:4132`.
Purpose: user-linked indexed source chunks, embeddings, and repository coordinates.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid; idPrimaryKeyColumn | High | Identifier of user-linked source content. |
| `organization_id` | uuid | High | Organization context of the identified user's indexed source. |
| `kilo_user_id` | text | High | User associated with the source embedding. |
| `project_id` | text | High | Project reference tied to the user's source activity. |
| `embedding` | vector(1536) | High | Derived representation of user-linked content; not proven anonymous. |
| `file_path` | text | High | Path of the user's indexed content; may also embed identity. |
| `file_hash` | text | High | Linkable fingerprint of user-associated content. |
| `start_line` | integer | High | Location within the user's indexed source. |
| `end_line` | integer | High | Extent of the user's indexed source chunk. |
| `git_branch` | text | High | Branch associated with the user's indexed content. |
| `is_base_branch` | boolean | High | Branch role of user-associated source, not global configuration. |
| `created_at` | timestamptz | High | User-linked indexing lifecycle time. |
| `updated_at` | timestamptz | High | User-linked source update time. |

## 92. platform_integrations

Source: `packages/db/src/schema.ts:4189`.
Purpose: user-or-organization platform connections, account/requester identities, repository access, and installation lifecycle.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid; idPrimaryKeyColumn | High | Linkable integration identifier with user/creator/requester associations. |
| `owned_by_organization_id` | uuid | Medium | Organization-only ownership does not establish individual membership. |
| `owned_by_user_id` | text | High | Identifies the individual integration owner when present. |
| `created_by_user_id` | text | High | Integration creator identity. |
| `platform` | text | High | Service connected for this account-linked integration. |
| `integration_type` | text | High | Connection/authentication method used for this integration. |
| `platform_installation_id` | text | High | External installation identifier linkable to account activity. |
| `platform_account_id` | text | High | External account identity; organization accounts may also occur. |
| `platform_account_login` | text | High | External account login/handle. |
| `permissions` | jsonb; IntegrationPermissions | High | Permissions granted on the account-linked integration; arbitrary string map. |
| `scopes` | text[] | High | Access scopes associated with the connected account. |
| `repository_access` | text | High | Repository access selection for this integration. |
| `repositories` | jsonb; PlatformRepository<number or string>[] | High | Account-linked repository IDs/names/access metadata; no extra members assumed. |
| `repositories_synced_at` | timestamptz | High | Synchronization activity of the linked integration. |
| `auth_invalid_at` | timestamptz | High | Time the account connection became invalid. |
| `auth_invalid_reason` | text | Medium | Diagnostic string; actual personal detail or fixed-code usage unverified. |
| `metadata` | jsonb | Medium | Opaque platform metadata; possible identity/content requires writer review. |
| `kilo_requester_user_id` | text | High | User who requested installation. |
| `platform_requester_account_id` | text | High | External requester account identity. |
| `integration_status` | text | High | State of this account-linked connection. |
| `suspended_at` | timestamptz | High | Account-linked suspension activity time. |
| `suspended_by` | text | High | Suspending actor identity. |
| `github_app_type` | text; 'standard' or 'lite' | High | App/access variant used for this connection. |
| `installed_at` | timestamptz | High | Linked installation activity time. |
| `created_at` | timestamptz | High | Creation time of the attributed connection. |
| `updated_at` | timestamptz | High | Update time of the attributed connection. |

## 93. user_github_app_tokens

Source: `packages/db/src/schema.ts:4315`.
Purpose: user-specific GitHub app identities and encrypted OAuth credentials with usage/revocation history.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid; idPrimaryKeyColumn | High | Identifier of a user's credential record. |
| `kilo_user_id` | text | High | Credential owner's user identity. |
| `github_app_type` | text; 'standard' or 'lite' | High | GitHub app variant authorized by this user. |
| `github_user_id` | text | High | External GitHub user identifier. |
| `github_login` | text | High | GitHub account handle. |
| `access_token_encrypted` | text | High | Encrypted user credential remains personal and linkable. |
| `access_token_expires_at` | timestamptz | High | Expiry of the user's access authorization. |
| `refresh_token_encrypted` | text | High | Encrypted user refresh credential; not anonymized. |
| `refresh_token_expires_at` | timestamptz | High | Expiry of the user's refresh authorization. |
| `credential_version` | integer | Other | Narrow credential-version bookkeeping, not a separate identity. |
| `revoked_at` | timestamptz | High | Time of the user's authorization revocation. |
| `revocation_reason` | text | Medium | Diagnostic/reason text; actual contents unverified. |
| `last_used_at` | timestamptz | High | User credential usage activity time. |
| `created_at` | timestamptz | High | Creation time of the user's credentials. |
| `updated_at` | timestamptz | High | Update time of the user's credentials. |

## 94. platform_oauth_credentials

Source: `packages/db/src/schema.ts:4355`.
Purpose: external OAuth subject identities and encrypted credentials attached to integrations and authorizing users.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid; idPrimaryKeyColumn | High | Identifier of a subject-linked credential. |
| `platform_integration_id` | uuid | High | Joins credentials to account/user-linked integration. |
| `platform` | text | High | OAuth service associated with the authorizing account. |
| `authorized_by_user_id` | text | High | Authorizing user's identity. |
| `provider_subject_id` | text | High | External authorization subject identifier. |
| `provider_subject_login` | text | High | External subject login/handle. |
| `provider_base_url` | text | Medium | Provider endpoint may be shared or tenant/personal; contents unverified. |
| `access_token_encrypted` | text | High | Encrypted subject-bound access credential. |
| `access_token_expires_at` | timestamptz | High | Subject authorization expiry time. |
| `refresh_token_encrypted` | text | High | Encrypted subject-bound refresh credential. |
| `refresh_token_expires_at` | timestamptz | High | Subject refresh authorization expiry time. |
| `oauth_client_secret_encrypted` | text | Medium | May be shared application or tenant-specific secret; ownership unverified. |
| `credential_version` | integer | Other | Narrow credential-version bookkeeping within a personal record. |
| `revoked_at` | timestamptz | High | Subject authorization revocation time. |
| `revocation_reason` | text | Medium | Generic diagnostic/reason text needs content review. |
| `last_used_at` | timestamptz | High | Subject-linked credential usage time. |
| `created_at` | timestamptz | High | Creation time of the subject-linked authorization. |
| `updated_at` | timestamptz | High | Update time of the subject-linked authorization. |

## 95. platform_access_token_credentials

Source: `packages/db/src/schema.ts:4397`.
Purpose: platform/resource access-token authorizations associated with integrations and optional authorizing users; token types include personal and shared resources.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid; idPrimaryKeyColumn | High | Linkable credential/authorization record identifier. |
| `platform_integration_id` | uuid | High | Links authorization to its user-capable integration. |
| `owned_by_organization_id` | uuid | Medium | Organization ownership, not direct individual attribution. |
| `platform` | text; 'bitbucket' | High | Service selected for this account-linked authorization. |
| `integration_type` | text; 'workspace_access_token' | High | Method associated with this integration authorization. |
| `token_encrypted` | text | High | Account-linked credential, potentially personal token; encryption is not anonymity. |
| `expires_at` | timestamptz | High | Expiry of the linked authorization. |
| `provider_credential_type` | text; 'workspace_access_token' or 'personal_access_token' or 'project_access_token' | High | Credential/access type associated with this authorization. |
| `provider_resource_id` | text | High | External resource identifier linking authorization and account activity. |
| `provider_base_url` | text | Medium | Shared or tenant/personal endpoint; actual contents unverified. |
| `authorized_by_user_id` | text | High | Identifies the authorizing user. |
| `provider_metadata` | jsonb | Medium | Untyped provider details may embed identities or shared resource metadata. |
| `provider_scopes` | text[] | High | Permissions associated with this authorization. |
| `provider_verified_at` | timestamptz | High | Verification time of this account-linked authorization. |
| `credential_version` | integer | Other | Narrow credential-version bookkeeping. |
| `last_validated_at` | timestamptz | High | Validation activity time of this authorization. |
| `last_used_at` | timestamptz | High | Account-linked token usage activity. |
| `created_at` | timestamptz | High | Creation time of the authorization. |
| `updated_at` | timestamptz | High | Update time of the authorization. |

## 96. slack_oauth_credentials

Source: `packages/db/src/schema.ts:4476`.
Purpose: encrypted Slack bot credentials and refresh lifecycle, linked through `platform_integrations`; bot/workspace identifiers are not assumed to identify humans.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid; idPrimaryKeyColumn | High | Identifier linkable through the user-capable integration record. |
| `platform_integration_id` | uuid | High | Join to integration owner, creator, and requester. |
| `slack_team_id` | text | Medium | External workspace identifier; individual affiliation needs joins. |
| `slack_enterprise_id` | text | Medium | External enterprise identifier; natural-person relationship unverified. |
| `is_enterprise_install` | boolean | Medium | Workspace/enterprise installation property, not direct individual detail. |
| `bot_user_id` | text | Medium | Bot identity, not assumed a natural person; human linkage needs joins. |
| `access_token_encrypted` | text | Medium | Shared bot credential; plaintext ownership/identity unverified. |
| `access_token_expires_at` | timestamptz | High | Expiry lifecycle of the account-linked integration authorization. |
| `refresh_token_encrypted` | text | Medium | Shared bot refresh credential; encryption does not settle personal relevance. |
| `granted_scopes` | text[] | Medium | Bot/workspace grants; individual access implications require joins. |
| `credential_version` | integer | Other | Narrow credential-version bookkeeping. |
| `refresh_claimed_at` | timestamptz | High | Processing lifecycle time of the account-linked authorization. |
| `refresh_attempt_count` | integer | Other | Narrow refresh retry counter, not standalone user behavior. |
| `next_refresh_attempt_at` | timestamptz | High | Scheduled lifecycle activity for the linked authorization. |
| `last_refreshed_at` | timestamptz | High | Refresh activity time for the linked authorization. |
| `revoked_at` | timestamptz | High | Revocation lifecycle time of the linked authorization. |
| `revocation_reason` | text | Medium | Diagnostic text; fixed-code versus embedded personal contents unverified. |
| `last_used_at` | timestamptz | High | Usage activity time of the linked integration. |
| `created_at` | timestamptz | High | Creation time of the linked credential record. |
| `updated_at` | timestamptz | High | Update time of the linked credential record. |

## 97. deployments

Source: `packages/db/src/schema.ts:4535`.
Purpose: user-or-organization deployments with creator, source, credentials, destination, build linkage, and threat assessment.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user-capable deployment activity record. |
| `created_by_user_id` | text | High | Deployment creator identity. |
| `owned_by_user_id` | text | High | Individual deployment owner identity. |
| `owned_by_organization_id` | uuid | Medium | Organization-only ownership; individual relationship needs joins. |
| `deployment_slug` | text | High | Linkable deployment address/identifier. |
| `internal_worker_name` | text | High | External compute locator for attributable deployment, not anonymous plumbing. |
| `repository_source` | text | High | Source repository of attributable deployment content. |
| `branch` | text | High | Source branch used for deployment activity. |
| `deployment_url` | text | High | Published destination linked to creator/owner content. |
| `platform_integration_id` | uuid | High | Link to the account integration used for deployment. |
| `source_type` | text; Provider | High | Source method used for this deployment. |
| `git_auth_token` | text | High | Repository credential linked to deployment/account activity. |
| `created_at` | timestamptz | High | Attributable deployment creation time. |
| `last_deployed_at` | timestamptz | High | Most recent deployment activity time. |
| `last_build_id` | uuid | High | Links to build history for attributable deployment activity. |
| `threat_status` | text; 'pending_scan' or 'safe' or 'flagged' | High | Safety assessment of owner/creator-associated content. |
| `created_from` | text; 'deploy' or 'app-builder' | High | Product workflow used for the deployment. |

## 98. deployments_ephemeral

Source: `packages/db/src/schema.ts:4584`.
Purpose: short-lived user-linked HTML deployments and cleanup lifecycle; nulling owner references does not establish erasure.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user-associated ephemeral deployment. |
| `owned_by_user_id` | text | High | User owner identity, nullable on deletion. |
| `source_type` | text; 'html' | High | Content type of the user's deployment activity. |
| `internal_worker_name` | text | High | Linkable external worker locator for user content. |
| `deployment_slug` | text | High | Linkable user deployment address. |
| `status` | text; 'pending' or 'active' or 'cleanup_retry' | High | Lifecycle state of the user's deployment. |
| `expires_at` | timestamptz | High | Expiry of the user's deployment. |
| `next_cleanup_at` | timestamptz | High | Scheduled handling of user-associated deployed content. |
| `cleanup_claim_token` | uuid | High | Correlation token bound to a user deployment cleanup. |
| `cleanup_claimed_until` | timestamptz | High | Processing lifecycle time of the user deployment. |
| `created_at` | timestamptz | High | User deployment creation time. |
| `updated_at` | timestamptz | High | User deployment update time. |

## 99. deployment_env_vars

Source: `packages/db/src/schema.ts:4624`.
Purpose: deployment-linked environment settings; parent deployment supplies creator/owner linkage.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of an attributable deployment setting. |
| `deployment_id` | uuid | High | Join to deployment owner/creator and activity. |
| `key` | text | High | Setting selected for this deployment, potentially custom identifying text. |
| `value` | text | High | Deployment-associated configuration/content; may include credentials or personal data. |
| `is_secret` | boolean | High | Confidentiality setting applied to this deployment value. |
| `created_at` | timestamptz | High | Creation time of the deployment setting. |
| `updated_at` | timestamptz | High | Update time of the deployment setting. |

## 100. deployment_builds

Source: `packages/db/src/schema.ts:4651`.
Purpose: build lifecycle for attributable deployments through `deployment_id`.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of attributable build activity. |
| `deployment_id` | uuid | High | Join to deployment owner/creator. |
| `status` | text; BuildStatus | High | Outcome/state of deployment-associated build activity. |
| `started_at` | timestamptz | High | Build activity start time. |
| `completed_at` | timestamptz | High | Build activity completion time. |
| `created_at` | timestamptz | High | Creation time of the attributable build. |

## 101. deployment_events

Source: `packages/db/src/schema.ts:4674`.
Purpose: build log/status events linked through build and deployment to owners/creators.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `build_id` | uuid | High | Links event to attributable deployment activity. |
| `event_id` | integer | High | Identifies an activity event within its linked build. |
| `event_type` | text; 'log' or 'status_change' | High | Kind of activity recorded for this build. |
| `timestamp` | timestamptz | High | Time of the attributable build event. |
| `payload` | jsonb | High | Build-associated log/status content; extra members and redaction unverified. |

## 102. deployment_threat_detections

Source: `packages/db/src/schema.ts:4695`.
Purpose: threat findings about attributable deployed content; build references may be nulled independently of deployment linkage.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a deployment-linked safety assessment. |
| `deployment_id` | uuid | High | Links finding to deployed content and owner/creator. |
| `build_id` | uuid | High | Links finding to attributable build activity. |
| `threat_type` | text | High | Safety classification of creator/owner-associated content. |
| `created_at` | timestamptz | High | Time of the attributable threat finding. |

## 103. code_indexing_search

Source: `packages/db/src/schema.ts:4719`.
Purpose: identified users' source-code searches and associated metadata.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user's search activity. |
| `organization_id` | uuid | High | Organization context of the identified user's search. |
| `kilo_user_id` | text | High | Searching user's identity. |
| `query` | text | High | User search content/interests. |
| `project_id` | text | High | Project searched by the user. |
| `metadata` | jsonb | High | User-search metadata; no member shape declared. |
| `created_at` | timestamptz | High | Time of the user's search activity. |

## 104. code_indexing_manifest

Source: `packages/db/src/schema.ts:4745`.
Purpose: indexed-file manifests and source/AI line counts with optional user attribution and organization/project scope.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of user-capable indexed-content record. |
| `organization_id` | uuid | Medium | Organization scope; individual relationship uncertain for userless rows. |
| `kilo_user_id` | text | High | User identity when attribution is present. |
| `project_id` | text | High | Project identifier attached to user-capable indexing activity. |
| `git_branch` | text | High | Branch of the indexed content/activity. |
| `file_hash` | text | High | Linkable fingerprint of indexed user-associated content. |
| `file_path` | text | High | Indexed source location; may also embed identity. |
| `chunk_count` | integer | High | Extent of indexed content, not a retry counter. |
| `total_lines` | integer | High | Size of the associated source content/work. |
| `total_ai_lines` | integer | High | AI-origin measure of associated source content/work. |
| `created_at` | timestamptz | High | Time of user-capable indexing activity. |

## 105. agent_configs

Source: `packages/db/src/schema.ts:4785`.
Purpose: user-or-organization automation preferences, creator attribution, and runtime state.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid; idPrimaryKeyColumn | High | Identifier of attributed/user-capable automation settings. |
| `owned_by_organization_id` | uuid | Medium | Organization ownership alone does not identify individual membership. |
| `owned_by_user_id` | text | High | Individual configuration owner. |
| `agent_type` | text | High | Automation feature selected for this owner. |
| `platform` | text | High | Platform selected for this owner's automation. |
| `config` | jsonb; CodeReviewAgentConfig or Record<string, unknown> | High | Owner-associated instructions/preferences/repository selections; arbitrary extension contents unverified. |
| `is_enabled` | boolean | High | Owner-associated activation preference. |
| `runtime_state` | jsonb; Record<string, unknown> | Medium | Opaque runtime details; actual activity/identity contents unverified. |
| `created_by` | text | High | Configuration creator identity. |
| `created_at` | timestamptz | High | Attributed configuration creation time. |
| `updated_at` | timestamptz | High | Update lifecycle of owner-associated settings. |
| `config_revision` | integer | Other | Narrow optimistic-concurrency revision counter. |

## 106. organization_recommendation_dismissals

Source: `packages/db/src/schema.ts:4866`.
Purpose: actor-attributed dismissals of organization recommendations, retained with nullable actor reference.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid; idPrimaryKeyColumn | High | Identifier of an attributable dismissal action. |
| `owned_by_organization_id` | uuid | High | Organization context of the recorded user's dismissal. |
| `recommendation_key` | text | High | Recommendation dismissed by an actor, not a standalone shared rule. |
| `dismissed_by_user_id` | text | High | Dismissing user identity; nulling does not erase all context. |
| `dismissed_at` | timestamptz | High | Time of the recorded dismissal action. |

## 107. webhook_events

Source: `packages/db/src/schema.ts:4890`.
Purpose: owner-scoped external platform events, payloads, headers, and processing history.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid; idPrimaryKeyColumn | High | Identifier of user-capable platform activity. |
| `owned_by_organization_id` | uuid | Medium | Organization owner without direct individual membership evidence. |
| `owned_by_user_id` | text | High | Identifies individual event owner. |
| `platform` | text | High | Platform generating this owner-associated activity. |
| `event_type` | text | High | Kind of owner-associated platform activity. |
| `event_action` | text | High | Action recorded by the owner-associated event. |
| `payload` | jsonb | High | Owner-linked event content; identities/content may extend beyond owner. |
| `headers` | jsonb | Medium | Untyped headers may contain identities/network data/credentials; redaction unverified. |
| `processed` | boolean | High | Handling state of the owner-associated event. |
| `processed_at` | timestamptz | High | Processing time of the owner-associated event. |
| `handlers_triggered` | text[] | High | Processing actions taken for this event, not a shared handler dictionary. |
| `errors` | jsonb | Medium | Opaque diagnostic payload; embedded personal contents unverified. |
| `event_signature` | text | High | Linkable deduplication signature of activity; not proven anonymous. |
| `created_at` | timestamptz | High | Time the owner-associated event was recorded. |

## 108. cloud_agent_webhook_triggers

Source: `packages/db/src/schema.ts:4947`.
Purpose: user-or-organization automation ownership/listing index, target and schedule settings; schema comments place authoritative configuration in TriggerDO, not verified at runtime.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of an owner-associated automation trigger. |
| `trigger_id` | text | High | Trigger correlation identifier linking to external configuration. |
| `user_id` | text | High | Individual trigger owner. |
| `organization_id` | uuid | Medium | Organization-only ownership; individual relationship requires joins. |
| `target_type` | text | High | Owner-associated automation destination choice. |
| `kiloclaw_instance_id` | uuid | High | Linkable target instance for this owner's automation. |
| `activation_mode` | text | High | Owner-associated activation preference. |
| `cron_expression` | text | High | User-capable scheduled automation pattern. |
| `cron_timezone` | text | High | Schedule timezone preference; not proof of physical location. |
| `github_repo` | text | High | Repository targeted by owner-associated automation. |
| `is_active` | boolean | High | Owner-associated activation state. |
| `profile_id` | uuid | High | Reference to the environment selected for this owner's automation. |
| `created_at` | timestamptz | High | Creation time of owner-associated automation. |
| `updated_at` | timestamptz | High | Update time of owner-associated automation. |

## 109. magic_link_tokens

Source: `packages/db/src/schema.ts:5035`.
Purpose: email-linked sign-in and data-export authorization challenges with consumption/attempt history.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `token_hash` | text | High | Hashed recipient-bound authorization identifier remains linkable. |
| `email` | text | High | Recipient identity. |
| `expires_at` | timestamptz | High | Expiry of recipient authorization. |
| `consumed_at` | timestamptz | High | Recipient authorization usage time. |
| `created_at` | timestamptz | High | Challenge issuance time. |
| `attempts` | integer | High | Authentication/authorization attempt history for the recipient, not generic queue retries. |
| `reserved_until` | timestamptz | High | Reservation lifecycle of the recipient's challenge. |
| `purpose` | text; 'magic_link' or 'sign_in_code' or 'data_export_download' | High | Recipient's authorization workflow, including data-export access. |
| `challenge_id` | uuid | High | Recipient-linked challenge identifier. |

## 110. model_stats

Source: `packages/db/src/schema.ts:5149`.
Purpose: shared model catalog, benchmark/cache data, display flags, pricing, and specifications; no user-owner column is declared.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | Other | Shared model-catalog key, not a user/account key. |
| `is_active` | boolean | Other | Shared catalog availability flag. |
| `is_featured` | boolean | Other | Shared model presentation flag. |
| `is_stealth` | boolean | Other | Shared model visibility flag. |
| `is_recommended` | boolean | Other | Shared recommendation flag, not an individual recommendation event. |
| `openrouter_id` | text | Other | Shared external model identifier, not external user identity. |
| `slug` | text | Other | Shared model lookup slug. |
| `aa_slug` | text | Other | Shared benchmark-model lookup slug. |
| `name` | text | Medium | Unconstrained display text may embed a person's name. |
| `description` | text | Medium | Shared free text may mention individuals. |
| `model_creator` | text | Medium | Creator may be an organization or a natural person. |
| `creator_slug` | text | Medium | Creator reference may resolve to an individual. |
| `release_date` | date | Other | Model release date, not user lifecycle time. |
| `price_input` | decimal(10,6) | Other | Shared model input price, not someone's billed usage. |
| `price_output` | decimal(10,6) | Other | Shared model output price, not someone's billed usage. |
| `coding_index` | decimal(5,2) | Other | Model benchmark score, not a person's assessment. |
| `speed_tokens_per_sec` | decimal(8,2) | Other | Shared model performance metric. |
| `context_length` | integer | Other | Model capability specification. |
| `max_output_tokens` | integer | Other | Model output capability limit. |
| `input_modalities` | text[] | Other | Shared model capability vocabulary. |
| `openrouter_data` | jsonb; OpenRouterModel | Medium | Shared model JSON includes author/description strings; personal contents unverified. |
| `benchmarks` | jsonb; ModelStatsBenchmarks | Medium | Evaluation labels/source strings and provenance need content review. |
| `chart_data` | jsonb; ModelStatsChartData | Medium | Aggregate usage/rankings lack verified cohort/provenance guarantees. |
| `created_at` | timestamptz | Other | Shared cache-row creation time, no staff/user action attribution declared. |
| `updated_at` | timestamptz | Other | Shared cache refresh time, not identified user activity. |

## 111. model_eval_ingestions

Source: `packages/db/src/schema.ts:5220`.
Purpose: model evaluation metrics promoted by an identified staff member; promotion audit data is personal even where metrics are shared.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a staff-attributed promotion/ingestion record. |
| `bench_eval_name` | text | Medium | Evaluation name may embed personal labels; naming convention unverified. |
| `bench_eval_url` | text | Medium | Evaluation URL may identify people or restricted artifacts. |
| `provider` | text | Other | Shared model-provider vocabulary, not the promoter's provider account. |
| `model` | text | Other | Model being measured, not a user-specific usage selection. |
| `model_stats_id` | uuid | Other | Shared model-catalog reference. |
| `variant` | text | Other | Model evaluation variant, not user/account preference. |
| `task_source` | text | Medium | Evaluation source label/path may embed personal provenance. |
| `n_total_trials` | integer | Other | Model evaluation trial count, not individual user's activity aggregate. |
| `n_attempts` | integer | Other | Model evaluation attempt count, not authentication history. |
| `total_score` | decimal(14,6); number mode | Other | Model evaluation score, not an assessment of staff. |
| `overall_score` | decimal(12,8); number mode | Other | Shared model performance score. |
| `n_errored` | integer | Other | Model evaluation error metric. |
| `avg_cost_microdollars` | bigint; number mode | Other | Benchmark cost metric, not staff's personal spend. |
| `total_cost_microdollars` | bigint; number mode | Other | Benchmark total cost, not an individual financial account. |
| `avg_input_tokens` | integer | Other | Model evaluation input metric. |
| `total_input_tokens` | bigint; number mode | Other | Model evaluation input total. |
| `avg_output_tokens` | integer | Other | Model evaluation output metric. |
| `total_output_tokens` | bigint; number mode | Other | Model evaluation output total. |
| `avg_cache_read_tokens` | integer | Other | Model evaluation cache metric. |
| `total_cache_read_tokens` | bigint; number mode | Other | Model evaluation cache total. |
| `avg_execution_ms` | integer | Other | Model evaluation timing metric, not staff performance. |
| `promoted_at` | timestamptz | High | Time of the identified staff member's promotion action. |
| `promoted_by_email` | text | High | Staff actor email identity. |
| `promotion_note` | text | High | Staff-attributed action narrative; may mention additional people. |
| `created_at` | timestamptz | High | Creation time of the staff-attributed ingestion record. |

## 112. contributor_champion_contributors

Source: `packages/db/src/schema.ts:5272`.
Purpose: external contributor identities, contact information, and contribution history; public identity is still personal data.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Internal identifier for an external contributor. |
| `github_login` | text | High | Contributor's GitHub handle. |
| `github_profile_url` | text | High | Contributor profile locator. |
| `github_user_id` | bigint; number mode | High | External contributor account identifier. |
| `first_contribution_at` | timestamptz | High | Contributor's first recorded contribution time. |
| `last_contribution_at` | timestamptz | High | Contributor's most recent contribution time. |
| `all_time_contributions` | integer | High | Person-specific contribution activity aggregate. |
| `manual_email` | text | High | Contributor contact email. |
| `created_at` | timestamptz | High | Contributor record creation time. |
| `updated_at` | timestamptz | High | Contributor record update time. |

## 113. contributor_champion_events

Source: `packages/db/src/schema.ts:5303`.
Purpose: contributor-linked pull-request contribution events with author identity and merge history.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a person's contribution event. |
| `contributor_id` | uuid | High | Joins event to contributor identity. |
| `repo_full_name` | text | High | Repository associated with the person's contribution. |
| `github_pr_number` | integer | High | External activity identifier within the repository. |
| `github_pr_url` | text | High | Link to the contributor's external activity/content. |
| `github_pr_title` | text | High | Title/content of the contribution. |
| `github_author_login` | text | High | External author identity. |
| `github_author_email` | text | High | Author email identity. |
| `merged_at` | timestamptz | High | Time of the contributor's merged work. |
| `created_at` | timestamptz | High | Contribution event recording time. |

## 114. contributor_champion_memberships

Source: `packages/db/src/schema.ts:5338`.
Purpose: contributors' program tiers, enrollment, credit benefits, and optional internal account linkage.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a person's program membership. |
| `contributor_id` | uuid | High | Joins benefits to external contributor identity. |
| `selected_tier` | text; ContributorChampionTier | High | Tier selected for the person. |
| `enrolled_tier` | text; ContributorChampionTier | High | Person's actual program tier. |
| `enrolled_at` | timestamptz | High | Person's enrollment time. |
| `credit_amount_microdollars` | bigint; number mode | High | Financial benefit assigned to the contributor. |
| `credits_last_granted_at` | timestamptz | High | Time the person last received credit benefits. |
| `linked_kilo_user_id` | text | High | Internal user identity linked to the contributor. |
| `created_at` | timestamptz | High | Person's membership record creation time. |
| `updated_at` | timestamptz | High | Person's membership record update time. |

## 115. contributor_champion_sync_state

Source: `packages/db/src/schema.ts:5382`.
Purpose: repository-level contribution import cursors, without a declared contributor/actor reference.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `repo_full_name` | text | Medium | Repository namespace may identify a person; repository ownership unverified. |
| `last_merged_at` | timestamptz | Medium | Cursor may correlate to an identifiable contribution via repository/event joins. |
| `last_synced_at` | timestamptz | Other | Repository import housekeeping time, no user/actor attribution declared. |
| `updated_at` | timestamptz | Other | Shared cursor maintenance time, not a person-specific lifecycle record. |

## 116. models_by_provider

Source: `packages/db/src/schema.ts:5394`.
Purpose: shared provider/model catalog snapshots, with free-string content uncertainty rather than declared user ownership.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | serial | Other | Shared catalog snapshot sequence key. |
| `data` | jsonb; NormalizedOpenRouterResponse | Medium | Shared provider/model data includes authors, descriptions, and URLs; contents unverified. |
| `openrouter` | jsonb; Record<string, StoredModel> | Medium | Catalog names/keys/tags may contain identifying text; not declared user prompts. |
| `vercel` | jsonb; Record<string, StoredModel> | Medium | Shared catalog strings and endpoint metadata require content review. |

## 117. cloud_agent_code_reviews

Source: `packages/db/src/schema.ts:5401`.
Purpose: owner-scoped code-review runs, PR author identity, instructions/results, external/session links, and usage/lifecycle history; PR authors provide personal linkage even for organization-owned jobs.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid; idPrimaryKeyColumn | High | Identifier of an attributable review run. |
| `owned_by_organization_id` | uuid | Medium | Organization-only ownership; individual membership not established by this reference. |
| `owned_by_user_id` | text | High | Individual review owner identity. |
| `platform_integration_id` | uuid | High | Link to account integration used for the review. |
| `manual_config` | jsonb; ManualCodeReviewConfig | High | Run-specific instructions and preferences linked to review activity. |
| `review_type` | text; CodeReviewType | High | Review workflow used for this attributable run. |
| `trigger_source` | text; CodeReviewTriggerSource | High | Origin of this review activity. |
| `council_result` | jsonb; CodeReviewCouncilResult | High | Findings/assessments of an author's work and execution choices; software specialists are not assumed human. |
| `repo_full_name` | text | High | Repository context of the author's reviewed work. |
| `pr_number` | integer | High | Repository-scoped identifier of the author's activity. |
| `pr_url` | text | High | External locator for authored content/activity. |
| `pr_title` | text | High | Content/title of the author's work. |
| `pr_author` | text | High | External PR author identity. |
| `pr_author_github_id` | text | High | External GitHub author identifier. |
| `base_ref` | text | High | Source comparison context for authored work. |
| `head_ref` | text | High | Branch of the author's reviewed work. |
| `head_sha` | text | High | Linkable commit hash for authored content, not anonymization. |
| `platform` | text; CodeReviewPlatform | High | Platform hosting this attributable activity. |
| `platform_project_id` | integer | High | External project identifier attached to authored work. |
| `session_id` | text | High | Cloud session correlation identifier for review activity. |
| `cli_session_id` | text | High | CLI session locator linking to further activity/content. |
| `status` | text | High | State/outcome of the attributable review. |
| `dispatch_reservation_id` | text | High | Linkable dispatch identifier for this review run. |
| `error_message` | text | Medium | Diagnostic string; actual content/redaction unverified. |
| `terminal_reason` | text | Medium | Generic terminal reason may contain identifying details; writer usage unverified. |
| `agent_version` | text | High | Execution backend used for this run, not global version vocabulary. |
| `check_run_id` | bigint; number mode | High | External check identifier tied to the author's reviewed work. |
| `repository_review_instructions_used` | boolean | High | Instruction usage on this attributable review. |
| `repository_review_instructions_ref` | text | High | Reference to instructions used for the reviewed content. |
| `repository_review_instructions_truncated` | boolean | High | Processing outcome for the review's instruction content. |
| `previous_summary_body` | text | High | Prior review narrative about authored work; may embed other personal content. |
| `previous_summary_head_sha` | text | High | Commit fingerprint linking prior review narrative to authored work. |
| `model` | text | High | Model used for this specific review activity. |
| `total_tokens_in` | integer | High | Input consumption of the attributable review. |
| `total_tokens_out` | integer | High | Output consumption of the attributable review. |
| `total_cost_musd` | integer | High | Financial consumption of the attributable review run. |
| `started_at` | timestamptz | High | Review activity start time. |
| `completed_at` | timestamptz | High | Review activity completion time. |
| `created_at` | timestamptz | High | Creation time of the attributable review. |
| `updated_at` | timestamptz | High | Update time of the attributable review. |

## 118. code_review_feedback_events

Source: `packages/db/src/schema.ts:5525`.
Purpose: owner-scoped feedback replies/excerpts on review comments and their external activity references.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid; idPrimaryKeyColumn | High | Identifier of feedback activity/content. |
| `owned_by_organization_id` | uuid | Medium | Organization-only ownership; individual membership requires joins. |
| `owned_by_user_id` | text | High | Individual feedback owner identity. |
| `platform` | text; ReviewMemoryPlatform | High | Platform of the recorded feedback activity. |
| `repo_full_name` | text | High | Repository context of feedback/content. |
| `pr_number` | integer | High | PR activity reference associated with feedback. |
| `kilo_comment_id` | text | High | External comment locator linking to replies/authors. |
| `reply_excerpt` | text | High | Reply content expressing feedback; may identify its author or others. |
| `kilo_comment_excerpt` | text | High | Review content associated with the feedback and authored work. |
| `dedupe_hash` | text | High | Linkable fingerprint of feedback content/activity. |
| `occurred_at` | timestamptz | High | Feedback activity occurrence time. |
| `created_at` | timestamptz | High | Feedback recording time. |

## 119. code_review_memory_proposals

Source: `packages/db/src/schema.ts:5563`.
Purpose: owner-scoped proposals derived from review feedback, preserving evidence/content, sentiment counts, and change-request lifecycle.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid; idPrimaryKeyColumn | High | Identifier of a feedback-derived proposal. |
| `owned_by_organization_id` | uuid | Medium | Organization ownership alone does not establish individual membership. |
| `owned_by_user_id` | text | High | Individual proposal owner identity. |
| `platform` | text; ReviewMemoryPlatform | High | Platform associated with this feedback-derived activity. |
| `repo_full_name` | text | High | Repository linked to feedback/content and proposal. |
| `status` | text; ReviewMemoryProposalStatus | High | State/outcome of owner-associated proposal activity. |
| `title` | text | High | Feedback-derived proposal content. |
| `rationale` | text | High | Narrative explaining feedback-derived changes; may assess user work/preferences. |
| `proposed_markdown` | text | High | Proposed review-memory content/instructions associated with feedback. |
| `evidence` | jsonb; ReviewMemoryEvidenceItem[] | High | Feedback excerpts and PR references; no undeclared author fields assumed. |
| `positive_count` | integer | High | Feedback sentiment aggregate tied to this proposal, not proven anonymized. |
| `negative_count` | integer | High | Negative feedback measure tied to content/owner context. |
| `neutral_count` | integer | High | Neutral feedback measure tied to content/owner context. |
| `change_request_url` | text | High | External activity/content locator for the proposed change. |
| `created_at` | timestamptz | High | Proposal creation activity time. |
| `updated_at` | timestamptz | High | Proposal update activity time. |

## 120. cloud_agent_code_review_attempts

Source: `packages/db/src/schema.ts:5621`.
Purpose: individual execution attempts and retries linked to personally attributable code reviews, sessions, and execution history.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid; idPrimaryKeyColumn | High | Identifier of a review execution attempt. |
| `code_review_id` | uuid | High | Join to review owner, PR author, and content/activity. |
| `attempt_number` | integer | Other | Narrow per-review retry ordinal; does not make the attempt record nonpersonal. |
| `retry_of_attempt_id` | uuid | High | Correlation link to prior attributable execution. |
| `retry_reason` | text | Medium | Generic reason text; fixed vocabulary versus embedded content unverified. |
| `session_id` | text | High | Cloud session identifier for attributable execution. |
| `cli_session_id` | text | High | CLI session identifier linking to activity/content. |
| `execution_id` | text | High | Execution correlation identifier tied to this review. |
| `analytics_enabled_at_dispatch` | boolean | High | Analytics setting captured for attributable review activity. |
| `status` | text | High | Outcome/state of the attributable attempt. |
| `error_message` | text | Medium | Diagnostic content may contain personal details; redaction unverified. |
| `terminal_reason` | text | Medium | Generic terminal reason requires writer/content review. |
| `started_at` | timestamptz | High | Attributable execution start time. |
| `completed_at` | timestamptz | High | Attributable execution completion time. |
| `created_at` | timestamptz | High | Attempt creation time. |
| `updated_at` | timestamptz | High | Attempt update time. |

## Material follow-ups and limitations

1. **Runtime contents and ownership:** trace writers/validators before asserting population or absence of personal data. Prioritize enrichment, environment values, webhook headers/payloads/errors, opaque integration/provider/runtime JSON, diagnostics, shared mode text, catalog author/name/URL fields, and benchmark provenance/cohort sizes. Distinguish organization, service/bot, personal, and external author accounts. Do not inspect credentials or live personal rows merely to complete this preliminary inventory.
2. **Retention and deletion:** define retention for invitations/challenges, removed memberships/audits, OAuth credentials, deployment artifacts/events, embeddings/search history, contributor identities/credits, and review feedback/evidence/summaries. Review soft-delete/export coverage and scheduled cleanup separately. Declared cascades, expiry fields, and schema comments are not evidence of executed erasure. In particular, organization-owned rows may survive a user's departure; nulling attribution can leave email, handles, paths, external IDs, and narrative content. Slack deletion comments at `packages/db/src/schema.ts:4472–4474` were treated as source assertions, not verified behavior.
3. **Joins and external stores:** map `platform_integrations` to credential/account owners and external GitHub/GitLab/Bitbucket/Slack systems; organization purchases to Stripe customers/subscriptions and seat assignments; deployment/build/event identifiers to Cloudflare workers, deployed content and logs; trigger IDs to TriggerDO configuration and profiles; code-review IDs/session IDs/commit hashes/comment URLs to CLI/cloud sessions, repository hosts and stored artifacts. Examine linked external stores, queues, logs, backups, analytics/exports, and replicas for retention and deletion propagation. Their actual contents and implementations were not checked.
4. **People beyond owners:** include invitees, members removed from an organization, external contributors, PR/reply authors, enrichment subjects, and staff actors. Contributor GitHub identities remain personal even without `linked_kilo_user_id`. Review findings, sentiment counts, source/AI line counts, and embedding vectors may describe or enable inferences about people through content/activity linkage.
5. **Boundary:** continue at **#121 `code_review_analytics_results`**. This batch neither inventories later tables nor establishes complete PostgreSQL/application coverage.

## Source-only verification

Read-only TypeScript AST parsing was used without importing/executing the schema or connecting to PostgreSQL. Results for this checkout:

- **40/40** table names, global ordinals, and declaration-start line references matched; physical `organization_modes` and the next boundary **#121 `code_review_analytics_results`** were confirmed.
- **487/487** physical columns matched once, in exact declaration order, with **0 missing, extra, duplicate, or misordered columns**. All **487** inventory rows had one of exactly High/Medium/Other and a nonempty reason.
- **487/487** rendered schema types matched AST-derived base types/options/annotations: **21** `idPrimaryKeyColumn` uses resolved to UUID; **70** explicitly named columns included **20** property-to-physical-name differences; **44** `$type` annotations matched. This included **25** JSONB columns, **5** PostgreSQL arrays, **7** decimal/numeric columns (**6** with explicit precision/scale), **13** explicit number-mode mappings, and **1** 1536-dimensional vector.
- **40/40** summary rows and the grand total matched the inventory: **370 High + 70 Medium + 47 Other = 487**. Classification labels/counts were checked mechanically; semantic confidence judgments remain preliminary, not AST-proven facts.
- **0 structural/type/count discrepancies**. These are source-document consistency checks only. Local JSON/type definitions were read for the evidence above; actual runtime validation, data population, ownership, and retention remain unverified. No application tests, lint/typecheck, formatter, runtime writers, database migrations, deployed schema, live data, or deletion behavior were verified.
