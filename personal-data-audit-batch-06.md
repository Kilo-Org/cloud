# Personal data audit — batch 06

## Scope, date, and sources

- Date: 2026-09-03.
- Scope: `pgTable` declarations **#201–234 inclusive** in `packages/db/src/schema.ts`, from `model_experiment_variant_version` through `quick_chat_messages`, the last declaration: **34 tables and 382 physical columns**. Every physical column appears once in its table's inventory, in declaration order. JSON members are evidence, not additional physical columns.
- Sources: root `AGENTS.md`, `packages/db/AGENTS.md`, the introduction and representative rows of `personal-data-audit-batch-02.md`, root and database package manifests, `packages/db/src/schema.ts:9794–11208`, supporting experiment declarations at `:9722–9783`, the UUID helper at `:3160–3163`, and local types cited below. Table citations identify declaration starts in this checkout.
- This is a **source-only preliminary audit**, applying the broad definition of personal data as **any data about a user**, not just conventional identifying details. No live rows, secrets, application writers, runtime payloads, deployed catalogs, external stores, or retention/deletion execution were inspected or validated. This is not a legal determination.
- This final declaration range completes the source table inventory when combined with preceding batches; this file does not repeat #1–200 or independently verify their audits. Completion of the source table inventory is **not** completion of a comprehensive runtime or privacy audit. Other stores, the source view, and actual deployed table/view/partition catalogs remain separate work.
- `model_experiment_request` and `compute_usage_charge` are described in source as monthly partitioned parents (`packages/db/src/schema.ts:9818–9826`, `:10982–10984`). Their child tables' column coverage is represented here by the parent definitions, not invented child names or a claim to have enumerated deployed partitions.
- Schema types describe PostgreSQL types: `timestamptz` means `timestamp({ withTimezone: true, mode: 'string' })`; `decimal(24,12)` preserves precision and scale and is PostgreSQL numeric/decimal. `bigint; mode 'number'` preserves Drizzle's numeric mapping. `text[]` is a physical PostgreSQL array; `jsonb; string[]` is JSON, not a PostgreSQL array. An annotation after `;` names the declared TypeScript `$type`; `or` renders union separators. Nullability/defaults are omitted. `idPrimaryKeyColumn` resolves to `uuid`. No physical-name aliases occur in this range: physical names match declaration keys. User IDs remain arbitrary `text`, not necessarily UUIDs.

## Classification legend

| Classification | Meaning |
| --- | --- |
| High | High confidence the column identifies or describes a person directly or through a user-specific record: direct, indirect, external, hashed, encrypted, or opaque identifiers; user-related financial data, activity, preferences, content, lifecycle timestamps, and staff/admin actions. Confidence of personal relevance, not a sensitivity ranking. |
| Medium | Plausible personal information or uncertain content/ownership: generic free text/JSON, credentials of uncertain ownership, shared-client registration, or organization-only records needing writer and ownership review. |
| Other | Genuinely shared configuration/vocabulary or narrowly identified technical plumbing with no independent personal meaning established here. This is not permission to publish a column or enclosing record, or omit it from privacy handling. |

Row linkage is part of the classification. User-specific authentication, metering, analytics, moderation, and chat state remain personal even if technically named, encrypted, hashed, aggregated, expired, or associated only through another row. Nullable references, absent foreign keys, and `set null` do not prove anonymity. Request model attribution joins through `usage_id` to `microdollar_usage.kilo_user_id`; provider grants join through connection instances to `kilo_user_id`; message rows join through threads to `user_id`.

MCP configurations and routes explicitly support personal as well as organization ownership. High settings/lifecycle classifications reflect that supported personal context and user assignments, not a claim that every organization-owned configuration belongs to one natural person. Arbitrary discovery/registry/header payload contents and shared credential ownership remain Medium where the declared shape does not settle them. OAuth client registrations have no declared individual owner and may represent shared software; their uncertain registration/identity fields are Medium, unlike a client's use in an identified user's grant, which is High.

Container intervals support user or organization subjects and user or bot actors; High columns cover explicit user activity/financial attribution, without treating every organization/bot row as one person's activity. Standalone organization references and organization-aggregate demo spend remain Medium: recording an owner does not make all organization spend that owner's personal spend. Shared SKU rates are Other; the same rates applied to identifiable usage are High. Version counters and heartbeat ordering counters are narrow plumbing exceptions, but rate-limit attempt counts and attested-key signing counts describe attributable security activity and are High.

## Local JSON/type evidence

- `CustomLlmApiConfig`: `packages/db/src/schema-types.ts:2083–2094` declares `internal_id`, `base_url`, optional cache/sanitization flags, `extra_headers`, `extra_body`, `remove_from_body`, and `reasoning_details_transform`. Headers are a string record (`:2050–2052`); extra body is an arbitrary-value record (`:2046–2048`); the transform vocabulary is at `:2074–2081`. This is not `CustomLlmDefinition`, so its organization/pricing fields are not assumed present. Shared endpoint/header/body contents need runtime review.
- `EncryptedData`: `packages/db/src/schema-types.ts:1214–1218` declares only `iv`, `data`, and `authTag`; it does not establish plaintext ownership. The experiment source describes a separately encrypted API key (`packages/db/src/schema.ts:9788–9793`), not proof that runtime upstream JSON contains no secrets. MCP encrypted columns are plain `text` with no declared plaintext structure; none was inferred.
- MCP JSON annotations are inline: config discovery is `Record<string, unknown> or null`, registry is `Record<string, unknown>`, headers are `Record<string, string>` (`packages/db/src/schema.ts:9898–9900`); execution context is `Record<string, unknown>` in grants/requests/codes/refresh/pending rows (`:10212`, `:10276`, `:10351`, `:10404`, `:10463`); audit correlation is the same unknown-value record (`:10568`). No specific nested identifiers, tokens, or payload fields are asserted. User-linked execution/audit context supports High independently of unknown members.
- `UserModelPreferenceLastSelected`: `packages/db/src/schema.ts:10587–10590` declares `model` and optional `variant`. `favorites` is annotated `string[]` (`:10602`), and `last_selected` permits null (`:10603`); both are user preferences stored in JSONB.
- Container metadata is `Record<string, string>` (`packages/db/src/schema.ts:10685`). Ledger `canonical_result` is `Record<string, unknown> or null` (`:10864`); analytics `properties` is `Record<string, unknown>` (`:10909`). These are user-linked records without a more specific member contract in these declarations.
- `ExternalSideEffectOutboxPayload`: `packages/db/src/schema.ts:10939–10945` explicitly declares `invitationId`, `to`, `organizationName`, `inviterName`, and `acceptInviteUrl`, establishing recipient/inviter/invitation content. No actual addresses or URLs were accessed.
- Moderation `context_json` is `Record<string, unknown>` (`packages/db/src/schema.ts:11068`). The source comment at `:11052–11053` describes minimized metadata, not message bodies; the annotation does not enforce this and runtime minimization was not checked. It remains personal through reporter/target/session linkage even if that intention holds.
- Supporting non-JSON types: MCP owner/auth/sharing/status/secret/outcome vocabularies (`packages/db/src/schema-types.ts:2319–2430`); SKU unit (`packages/db/src/schema.ts:10616`); container subject/actor/status/billing/close-reason unions (`:10642–10652`); native platform (`:10820`); outbox operation/status unions (`:10954–10958`). These annotations do not change physical PostgreSQL types or prove runtime validation.

## Table summary

Classification totals: **327 High**, **31 Medium**, **24 Other** (382 columns).

| # | Table | Columns | High | Medium | Other |
| --- | --- | ---: | ---: | ---: | ---: |
| 201 | model_experiment_variant_version | 7 | 3 | 2 | 2 |
| 202 | model_experiment_request | 8 | 8 | 0 | 0 |
| 203 | mcp_gateway_configs | 20 | 16 | 3 | 1 |
| 204 | mcp_gateway_connect_resources | 12 | 11 | 0 | 1 |
| 205 | mcp_gateway_assignments | 8 | 8 | 0 | 0 |
| 206 | mcp_gateway_connection_instances | 12 | 11 | 0 | 1 |
| 207 | mcp_gateway_provider_grants | 12 | 11 | 0 | 1 |
| 208 | mcp_gateway_config_secrets | 8 | 6 | 1 | 1 |
| 209 | mcp_gateway_oauth_clients | 14 | 0 | 10 | 4 |
| 210 | mcp_gateway_oauth_grants | 19 | 18 | 0 | 1 |
| 211 | mcp_gateway_authorization_requests | 24 | 23 | 0 | 1 |
| 212 | mcp_gateway_authorization_codes | 21 | 20 | 0 | 1 |
| 213 | mcp_gateway_refresh_tokens | 18 | 18 | 0 | 0 |
| 214 | mcp_gateway_pending_provider_authorizations | 23 | 22 | 0 | 1 |
| 215 | mcp_gateway_rate_limit_windows | 6 | 6 | 0 | 0 |
| 216 | mcp_gateway_audit_events | 12 | 12 | 0 | 0 |
| 217 | user_model_preferences | 6 | 6 | 0 | 0 |
| 218 | cloud_billing_sku | 8 | 2 | 1 | 5 |
| 219 | container_usage_interval | 24 | 22 | 0 | 2 |
| 220 | container_usage_segment | 6 | 6 | 0 | 0 |
| 221 | github_install_states | 9 | 9 | 0 | 0 |
| 222 | native_admission_challenges | 4 | 0 | 4 | 0 |
| 223 | native_attested_keys | 8 | 8 | 0 | 0 |
| 224 | operation_ledgers | 16 | 15 | 1 | 0 |
| 225 | analytics_event_outbox | 12 | 10 | 1 | 1 |
| 226 | external_side_effect_outbox | 11 | 9 | 1 | 1 |
| 227 | compute_usage_charge | 10 | 9 | 1 | 0 |
| 228 | sales_demo_spend_ledger | 6 | 1 | 5 | 0 |
| 229 | content_moderation_reports | 14 | 14 | 0 | 0 |
| 230 | user_moderation_blocks | 4 | 4 | 0 | 0 |
| 231 | user_moderation_mutes | 4 | 4 | 0 | 0 |
| 232 | user_terms_acceptances | 5 | 5 | 0 | 0 |
| 233 | quick_chat_threads | 5 | 4 | 1 | 0 |
| 234 | quick_chat_messages | 6 | 6 | 0 | 0 |
| | **Total** | **382** | **327** | **31** | **24** |

## 201. model_experiment_variant_version

Source: `packages/db/src/schema.ts:9794`.
Purpose: shared model-experiment upstream configuration versions with creator attribution and separately encrypted API credentials; request usage links to these versions.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid; idPrimaryKeyColumn | Other | Shared configuration-version key; its association in an individual request is personal. |
| `variant_id` | uuid | Other | Shared experiment-variant reference, not an individual allocation here. |
| `upstream` | jsonb; CustomLlmApiConfig | Medium | Shared upstream configuration permits arbitrary headers/body; personal contents are unverified. |
| `encrypted_api_key` | jsonb; EncryptedData | Medium | Encrypted shared upstream credential; natural-person account ownership is not established. |
| `effective_at` | timestamptz | High | Effective time of this creator-attributed configuration change. |
| `created_by` | text | High | Identifies the user or staff member creating this version. |
| `created_at` | timestamptz | High | Time of the attributed creation action. |

## 202. model_experiment_request

Source: `packages/db/src/schema.ts:9827`.
Purpose: per-request experiment attribution linked to a user's `microdollar_usage` record, with a prompt-body hash referencing R2; partition-parent column inventory.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `usage_id` | uuid | High | Joins the request to identifiable user usage. |
| `variant_version_id` | uuid | High | Experiment version used for this user's request. |
| `allocation_subject` | text | High | Whether this user's allocation used user, machine, or IP grouping; category, not the identifier itself. |
| `client_request_id` | text | High | Correlates the user's client request. |
| `request_kind` | text | High | API shape used in this user's request. |
| `request_body_sha256` | text | High | Hash linking user request content to external storage; failure/deletion sentinels do not erase attribution. |
| `was_truncated` | boolean | High | Records truncation of this user's request content. |
| `created_at` | timestamptz | High | Time of identifiable experimental usage. |

## 203. mcp_gateway_configs

Source: `packages/db/src/schema.ts:9876`.
Purpose: personally or organizationally owned MCP configuration, sharing, endpoint, and provider settings, with creator attribution and downstream assignments.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `config_id` | uuid | High | Linkable identifier of a potentially personal configuration and its assignments. |
| `owner_scope` | text; MCPGatewayOwnerScope | High | Records personal versus organization ownership context for the configuration. |
| `owner_id` | text | High | Identifies a user in personal scope; organizational cases require ownership joins. |
| `name` | text | High | Name chosen for a potentially personal configuration; may additionally contain personal text. |
| `remote_url` | text | High | User-associated endpoint choice; URL paths or queries may carry further identifiers. |
| `auth_mode` | text; MCPGatewayAuthMode | High | Authentication preference applied to a potentially personal configuration. |
| `sharing_mode` | text; MCPGatewaySharingMode | High | User-associated access/sharing setting. |
| `provider_scopes` | text[] | High | Provider permissions requested/configured for this ownership context. |
| `provider_scope_source` | text; MCPGatewayProviderScopeSource | High | Whether this configuration's permissions were discovered or overridden. |
| `provider_resource` | text | High | Provider resource associated with a potentially personal connection. |
| `enabled` | boolean | High | Availability state of the owner-associated configuration. |
| `path_passthrough` | boolean | High | Routing preference applied to the owner-associated configuration. |
| `config_version` | integer | Other | Narrow configuration revision counter; enclosing owner-linked record remains personal. |
| `discovered_provider_metadata` | jsonb; Record<string, unknown> or null | Medium | Arbitrary provider discovery data; shared versus embedded personal contents are unknown. |
| `registry_metadata` | jsonb; Record<string, unknown> | Medium | Registry metadata with unconstrained members and uncertain personal content. |
| `auxiliary_headers` | jsonb; Record<string, string> | Medium | Arbitrary header values may identify people or carry credentials; actual ownership/content unknown. |
| `created_by_kilo_user_id` | text | High | Creator's user identifier, including staff actions. |
| `deleted_at` | timestamptz | High | Owner-associated removal lifecycle time, not proof of erasure. |
| `created_at` | timestamptz | High | Time the owner-associated configuration was created. |
| `updated_at` | timestamptz | High | Time the owner-associated settings changed. |

## 204. mcp_gateway_connect_resources

Source: `packages/db/src/schema.ts:9933`.
Purpose: owner-scoped connect routes linked to MCP configurations, including route rotation/revocation state.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `connect_resource_id` | uuid | High | Linkable identifier of an owner-associated connect route. |
| `config_id` | uuid | High | Associates the route with its potentially personal configuration. |
| `owner_scope` | text; MCPGatewayOwnerScope | High | Personal/organization context of this connect route. |
| `owner_id` | text | High | Personal owner identifier where scope is personal; not anonymous when opaque. |
| `route_key` | text | High | Opaque, linkable route identifier for the owner's connection. |
| `canonical_url` | text | High | Address of the owner-associated connect resource. |
| `route_status` | text; MCPGatewayRouteStatus | High | Active, rotated, or revoked state of the owner's route. |
| `route_version` | integer | Other | Narrow route revision counter; route identity remains personal. |
| `rotated_at` | timestamptz | High | Rotation time for the owner-associated route. |
| `revoked_at` | timestamptz | High | Revocation time for the owner-associated route. |
| `created_at` | timestamptz | High | Creation time of the owner-associated route. |
| `updated_at` | timestamptz | High | Update time of the owner-associated route. |

## 205. mcp_gateway_assignments

Source: `packages/db/src/schema.ts:9981`.
Purpose: individual user access assignments to configurations, including the assigning actor and revocation lifecycle.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `assignment_id` | uuid | High | Identifier of a user's access assignment. |
| `config_id` | uuid | High | Configuration assigned to this user. |
| `kilo_user_id` | text | High | Assigned user's identifier. |
| `assigned_by_kilo_user_id` | text | High | User/staff actor who made the assignment. |
| `single_user_slot` | text | High | Records this user's placement in a single-user assignment slot. |
| `revoked_at` | timestamptz | High | Time this user's access was revoked. |
| `created_at` | timestamptz | High | Time this user's assignment was created. |
| `updated_at` | timestamptz | High | Time this user's assignment changed. |

## 206. mcp_gateway_connection_instances

Source: `packages/db/src/schema.ts:10018`.
Purpose: user-specific MCP connection instances, owner context, authentication state, and usage/removal lifecycle.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `instance_id` | uuid | High | Identifier of an individual user's connection. |
| `config_id` | uuid | High | Configuration used by this user's instance. |
| `owner_scope` | text; MCPGatewayOwnerScope | High | Ownership context applied to the identified user's connection. |
| `owner_id` | text | High | Owner association recorded on the user's connection, personal or organizational. |
| `kilo_user_id` | text | High | User who owns/uses the connection instance. |
| `instance_status` | text; MCPGatewayInstanceStatus | High | Authentication/access state of this user's connection. |
| `instance_version` | integer | Other | Narrow revision counter for connection-state coordination. |
| `last_used_at` | timestamptz | High | Most recent recorded use of this user's connection. |
| `revoked_at` | timestamptz | High | Time this user's connection was revoked. |
| `removed_at` | timestamptz | High | Time this user's connection was removed. |
| `created_at` | timestamptz | High | Creation time of this user's connection. |
| `updated_at` | timestamptz | High | Update time of this user's connection. |

## 207. mcp_gateway_provider_grants

Source: `packages/db/src/schema.ts:10067`.
Purpose: provider authorization linked through `instance_id` to a specific user's MCP connection.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `provider_grant_id` | uuid | High | Identifier of a user's provider authorization. |
| `instance_id` | uuid | High | Joins the grant to the user's connection instance. |
| `encrypted_grant` | text | High | Encrypted authorization material attached to a user; plaintext members unverified. |
| `provider_subject` | text | High | External provider subject/account identifier. |
| `grant_scope` | text | High | Permissions associated with the user's provider grant. |
| `expires_at` | timestamptz | High | Expiration of this user's provider authorization. |
| `grant_status` | text; MCPGatewayProviderGrantStatus | High | Active/revoked state of the user's authorization. |
| `grant_version` | integer | Other | Narrow grant revision counter; not evidence that the grant is nonpersonal. |
| `last_used_at` | timestamptz | High | Usage time of the user's provider grant. |
| `revoked_at` | timestamptz | High | Revocation time of the user's provider grant. |
| `created_at` | timestamptz | High | Creation time of the user's provider grant. |
| `updated_at` | timestamptz | High | Update time of the user's provider grant. |

## 208. mcp_gateway_config_secrets

Source: `packages/db/src/schema.ts:10108`.
Purpose: encrypted configuration credentials linked to potentially personal or shared organization MCP configuration; plaintext ownership is not declared.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `config_secret_id` | uuid | High | Linkable secret-record identifier associated with a potentially personal configuration. |
| `config_id` | uuid | High | Joins the secret record to its owner-associated configuration. |
| `secret_kind` | text; MCPGatewaySecretKind | High | Credential category used by the owner-associated configuration. |
| `encrypted_secret` | text | Medium | Personal versus shared provider credential ownership and plaintext contents remain unverified. |
| `secret_version` | integer | Other | Narrow credential revision counter; encryption and versioning do not establish anonymity. |
| `revoked_at` | timestamptz | High | Credential revocation lifecycle for the owner-associated configuration. |
| `created_at` | timestamptz | High | Credential creation lifecycle for the owner-associated configuration. |
| `updated_at` | timestamptz | High | Credential update lifecycle for the owner-associated configuration. |

## 209. mcp_gateway_oauth_clients

Source: `packages/db/src/schema.ts:10141`.
Purpose: OAuth software-client registration, hashes, callback configuration, and lifecycle; no natural-person owner is declared on this shared-client row.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `oauth_client_id` | uuid | Medium | Client registration key; individual versus shared ownership needs review. |
| `client_id` | text | Medium | OAuth client identifier, potentially per-person or shared software. |
| `client_name` | text | Medium | Free-form client name may embed a person's identity. |
| `registration_token_hash` | text | Medium | Hashed registration credential with uncertain owner; hashing is not anonymity. |
| `client_secret_hash` | text | Medium | Hashed software-client credential; personal ownership is not established. |
| `token_endpoint_auth_method` | text; MCPGatewayOAuthClientAuthMethod | Other | Shared software client's protocol authentication setting, not an individual grant. |
| `redirect_uris` | text[] | Medium | Callback URLs may contain personal domains, paths, or identifiers. |
| `grant_types` | text[] | Other | Shared client's supported OAuth grant vocabulary. |
| `response_types` | text[] | Other | Shared client's supported OAuth response vocabulary. |
| `declared_scopes` | text[] | Other | Shared client permission configuration; an individual's granted scopes are separately High. |
| `registration_access_token_expires_at` | timestamptz | Medium | Registration credential lifecycle; individual ownership remains uncertain. |
| `deleted_at` | timestamptz | Medium | Client registration removal time with uncertain individual linkage. |
| `created_at` | timestamptz | Medium | Client registration time; registrant identity is not declared here. |
| `updated_at` | timestamptz | Medium | Client registration update time with uncertain actor/ownership. |

## 210. mcp_gateway_oauth_grants

Source: `packages/db/src/schema.ts:10186`.
Purpose: individual user's OAuth grant binding client, configuration, connect resource, and instance to approved permissions and execution context.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `oauth_grant_id` | uuid | High | Identifier of a user's OAuth grant. |
| `oauth_client_id` | uuid | High | Client authorized by this identified user. |
| `kilo_user_id` | text | High | Grant subject's user identifier. |
| `owner_scope` | text; MCPGatewayOwnerScope | High | Ownership context of the user's authorization. |
| `owner_id` | text | High | Owner association recorded with the user's grant. |
| `config_id` | uuid | High | Configuration authorized for this user. |
| `connect_resource_id` | uuid | High | Connect resource bound to the user's grant. |
| `instance_id` | uuid | High | Specific user connection authorized by the grant. |
| `redirect_uri` | text | High | Callback destination for this user's authorization. |
| `granted_scopes` | text[] | High | Permissions approved for this user/client binding. |
| `execution_context` | jsonb; Record<string, unknown> | High | User-specific authorization context; additional members are unknown. |
| `config_version` | integer | Other | Narrow configuration-revision snapshot used for grant coordination. |
| `grant_status` | text; MCPGatewayOAuthGrantStatus | High | State of the user's authorization. |
| `approved_at` | timestamptz | High | Time the user's grant was approved. |
| `last_used_at` | timestamptz | High | Time the user's grant was last used. |
| `revoked_at` | timestamptz | High | Time the user's grant was revoked. |
| `revocation_reason` | text | High | Reason for removing this user's authorization; may contain additional personal text. |
| `created_at` | timestamptz | High | Creation time of the user's authorization. |
| `updated_at` | timestamptz | High | Update time of the user's authorization. |

## 211. mcp_gateway_authorization_requests

Source: `packages/db/src/schema.ts:10248`.
Purpose: pending/completed user OAuth authorization exchanges, state/PKCE binding, requested permissions, and request lifecycle.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `authorization_request_id` | uuid | High | Identifier of a user's authorization request. |
| `request_state_hash` | text | High | Hashed correlation state for a user's authorization flow. |
| `oauth_client_id` | uuid | High | Client involved in the user's request. |
| `oauth_grant_id` | uuid | High | Link to the user's resulting or associated grant. |
| `client_id` | text | High | OAuth client identity recorded for this user's flow. |
| `owner_scope` | text; MCPGatewayOwnerScope | High | Ownership context of this user's request. |
| `owner_id` | text | High | Owner association on the identified user's request. |
| `config_id` | uuid | High | Configuration being authorized for the user. |
| `route_key` | text | High | Correlatable connect-route key used by this user. |
| `canonical_resource_url` | text | High | Connect-resource address used for this user's authorization. |
| `redirect_uri` | text | High | User-flow callback destination. |
| `requested_scopes` | text[] | High | Permissions requested in this user's authorization flow. |
| `granted_scopes` | text[] | High | Permissions granted in this user's authorization flow. |
| `oauth_state` | text | High | Client correlation state associated with this user's flow. |
| `code_challenge` | text | High | PKCE binding value for this user's authorization exchange. |
| `code_challenge_method` | text | Other | Narrow PKCE algorithm/protocol label, distinct from the user-bound challenge. |
| `execution_context` | jsonb; Record<string, unknown> | High | Execution context of the identified user's request; members unverified. |
| `kilo_user_id` | text | High | Identifies the authorizing user. |
| `instance_id` | uuid | High | User connection involved in the request. |
| `request_status` | text; MCPGatewayAuthorizationRequestStatus | High | Outcome/state of this user's authorization request. |
| `expires_at` | timestamptz | High | Expiration time of the user's authorization request. |
| `consumed_at` | timestamptz | High | Consumption time of the user's authorization request. |
| `created_at` | timestamptz | High | Start time of the user's authorization request. |
| `updated_at` | timestamptz | High | Update time of the user's authorization request. |

## 212. mcp_gateway_authorization_codes

Source: `packages/db/src/schema.ts:10320`.
Purpose: user-bound OAuth code hashes and exchange context linked to authorization requests, grants, and connection instances.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `authorization_code_id` | uuid | High | Identifier of the user's authorization-code record. |
| `code_hash` | text | High | Hashed credential bound to an identified user's exchange. |
| `authorization_request_id` | uuid | High | Link to the user's originating authorization request. |
| `oauth_client_id` | uuid | High | Software client used in the user's exchange. |
| `oauth_grant_id` | uuid | High | Associated user's OAuth grant. |
| `client_id` | text | High | OAuth client identity used in this user's exchange. |
| `owner_scope` | text; MCPGatewayOwnerScope | High | Ownership context applied to this user-bound code. |
| `owner_id` | text | High | Owner association recorded with this user's code. |
| `config_id` | uuid | High | Configuration associated with the user's authorization. |
| `route_key` | text | High | User-flow connect-route correlation identifier. |
| `canonical_resource_url` | text | High | Connect-resource URL associated with the user's exchange. |
| `redirect_uri` | text | High | Callback address for this user's exchange. |
| `granted_scopes` | text[] | High | Permissions approved for this user's code exchange. |
| `code_challenge` | text | High | PKCE value binding this identified user's exchange. |
| `code_challenge_method` | text | Other | Narrow PKCE protocol algorithm label, not the user-bound challenge. |
| `execution_context` | jsonb; Record<string, unknown> | High | User-bound exchange context; actual members remain unknown. |
| `kilo_user_id` | text | High | Identifies the user associated with the code. |
| `instance_id` | uuid | High | User connection associated with the code. |
| `expires_at` | timestamptz | High | Expiration of this user's code. |
| `consumed_at` | timestamptz | High | Exchange/consumption time of this user's code. |
| `created_at` | timestamptz | High | Creation time of this user's code. |

## 213. mcp_gateway_refresh_tokens

Source: `packages/db/src/schema.ts:10380`.
Purpose: hashed user refresh tokens, rotation lineage, and retained grant/resource execution context.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `refresh_token_id` | uuid | High | Identifier of a user's refresh credential. |
| `token_hash` | text | High | Hashed user credential; still correlated to the user. |
| `rotated_from_refresh_token_id` | uuid | High | Links the user's credential rotation history despite no declared foreign key. |
| `oauth_client_id` | uuid | High | Client used by the user's refresh token. |
| `oauth_grant_id` | uuid | High | Link to the user's authorization grant. |
| `client_id` | text | High | OAuth client identity in this user's refresh context. |
| `owner_scope` | text; MCPGatewayOwnerScope | High | Ownership context for the user's refresh authorization. |
| `owner_id` | text | High | Owner association recorded with the user's token. |
| `config_id` | uuid | High | Configuration authorized for this user's refresh. |
| `route_key` | text | High | Connect-route identifier associated with the user's token. |
| `canonical_resource_url` | text | High | Resource URL associated with the user's refresh authorization. |
| `granted_scopes` | text[] | High | Permissions retained by the user's refresh authorization. |
| `execution_context` | jsonb; Record<string, unknown> | High | User-specific refresh execution context; nested contents unverified. |
| `kilo_user_id` | text | High | Identifies the refresh-token subject. |
| `instance_id` | uuid | High | User connection associated with this refresh credential. |
| `consumed_at` | timestamptz | High | Time this user's refresh token was consumed. |
| `revoked_at` | timestamptz | High | Time this user's refresh token was revoked. |
| `created_at` | timestamptz | High | Time this user's refresh token was created. |

## 214. mcp_gateway_pending_provider_authorizations

Source: `packages/db/src/schema.ts:10430`.
Purpose: per-user upstream-provider authorization exchanges, encrypted state, endpoint context, and lifecycle.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `pending_provider_authorization_id` | uuid | High | Identifier of the user's provider authorization attempt. |
| `state_hash` | text | High | Hashed correlation state for the identified user's attempt. |
| `authorization_request_id` | uuid | High | Link to the user's downstream authorization request. |
| `oauth_grant_id` | uuid | High | Link to the user's OAuth grant. |
| `config_id` | uuid | High | MCP configuration used in the user's provider authorization. |
| `instance_id` | uuid | High | Specific user's connection requiring provider authorization. |
| `owner_scope` | text; MCPGatewayOwnerScope | High | Ownership context applied to this user's attempt. |
| `owner_id` | text | High | Owner association recorded for this user's attempt. |
| `kilo_user_id` | text | High | Identifies the authorizing user. |
| `route_key` | text | High | Connect-route identifier involved in the user's attempt. |
| `canonical_resource_url` | text | High | Connect-resource URL used by this user. |
| `remote_url` | text | High | Upstream endpoint selected for this user's connection. |
| `auth_mode` | text; MCPGatewayAuthMode | High | Authentication mode used for this user's attempt. |
| `provider_authorization_endpoint` | text | High | Provider authorization endpoint contacted in this user's flow. |
| `provider_token_endpoint` | text | High | Provider token endpoint associated with this user's flow. |
| `encrypted_state` | text | High | Encrypted state of an identified user's authorization; plaintext members unknown. |
| `execution_context` | jsonb; Record<string, unknown> | High | Execution context of the user's provider exchange; members unverified. |
| `config_version` | integer | Other | Narrow configuration-revision snapshot for authorization coordination. |
| `pending_status` | text; MCPGatewayPendingProviderAuthorizationStatus | High | State/outcome of the user's provider authorization attempt. |
| `expires_at` | timestamptz | High | Expiration of this user's provider authorization attempt. |
| `consumed_at` | timestamptz | High | Consumption time of this user's provider authorization state. |
| `created_at` | timestamptz | High | Creation time of this user's provider authorization attempt. |
| `updated_at` | timestamptz | High | Update time of this user's provider authorization attempt. |

## 215. mcp_gateway_rate_limit_windows

Source: `packages/db/src/schema.ts:10511`.
Purpose: IP-hash-keyed attempt windows; hashing and aggregation do not eliminate network/client linkage.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `rate_limit_window_id` | uuid | High | Identifier of an IP-linked security activity window. |
| `ip_hash` | text | High | Hashed network address identifier; pseudonymous rather than necessarily anonymous. |
| `window_started_at` | timestamptz | High | Time window associated with activity from this network identifier. |
| `attempt_count` | integer | High | Counts IP-linked attempts, not a generic internal retry counter. |
| `created_at` | timestamptz | High | Creation time of this IP-associated activity record. |
| `updated_at` | timestamptz | High | Update time of this IP-associated activity record. |

## 216. mcp_gateway_audit_events

Source: `packages/db/src/schema.ts:10543`.
Purpose: actor/owner-associated MCP access or configuration audit events with optional user-instance/grant references; nullable links do not prove anonymity.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `audit_event_id` | uuid | High | Correlatable identifier of a user/actor-associated audit event. |
| `actor_kilo_user_id` | text | High | Identifies the acting user or staff member. |
| `owner_scope` | text; MCPGatewayOwnerScope | High | Personal/organization context of the audited action. |
| `owner_id` | text | High | Personal owner identifier or owner association for the audited action. |
| `config_id` | uuid | High | Configuration involved in the actor/owner-associated event. |
| `connect_resource_id` | uuid | High | Connect route involved in the audited action. |
| `instance_id` | uuid | High | Connection instance linking the event to a user. |
| `oauth_grant_id` | uuid | High | User authorization grant involved in the event. |
| `event_type` | text | High | Action recorded about the user/actor's activity. |
| `outcome` | text; MCPGatewayAuditOutcome | High | Result of the user/actor-associated action. |
| `correlation_metadata` | jsonb; Record<string, unknown> | High | Correlation context attached to personal audit activity; nested contents unknown. |
| `created_at` | timestamptz | High | Time of the audited user/staff/owner-associated event. |

## 217. user_model_preferences

Source: `packages/db/src/schema.ts:10592`.
Purpose: per-user favorite and most-recently selected model preferences.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of the user's preference record. |
| `user_id` | text | High | User whose model preferences are stored. |
| `favorites` | jsonb; string[] | High | User's favorite model choices, stored as JSON. |
| `last_selected` | jsonb; UserModelPreferenceLastSelected or null | High | User's last model and optional variant selection. |
| `created_at` | timestamptz | High | Creation time of the user's preference record. |
| `updated_at` | timestamptz | High | Update time of the user's preferences. |

## 218. cloud_billing_sku

Source: `packages/db/src/schema.ts:10620`.
Purpose: shared commercial usage-product catalog with immutable units/rates and creator attribution, distinct from individual charges.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | text | Other | Shared commercial product identifier, not a purchaser identifier. |
| `name` | text | Other | Shared product label rather than a user's selected purchase. |
| `description` | text | Medium | Free-form product description could contain personal or staff-entered details. |
| `unit` | text; CloudBillingSkuUnit | Other | Shared metering unit vocabulary. |
| `rate_cents_per_unit` | decimal(24,12) | Other | Shared catalog price, not an individual user's charge. |
| `accepts_new_usage` | boolean | Other | Shared product admission configuration. |
| `created_by_user_id` | text | High | User/staff member who created the catalog entry. |
| `created_at` | timestamptz | High | Time of the creator-attributed catalog action. |

## 219. container_usage_interval

Source: `packages/db/src/schema.ts:10656`.
Purpose: metered awake intervals with user/org subject, user/bot actor, session/resource linkage, and accepted billing terms; attribution is polymorphic rather than a declared user foreign key.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | text | High | Correlatable identifier of attributable metered activity. |
| `service` | text | High | Service consumed in the user-attributable interval. |
| `instance_id` | text | High | Runtime instance identifier linked to the subject/actor's activity. |
| `start_epoch_ms` | bigint; mode 'number' | High | Millisecond start time of attributable runtime activity. |
| `cloud_billing_sku_id` | text | High | Commercial usage product applied to this subject's interval. |
| `context_fingerprint` | text | High | Hashed context correlation for attributed activity; hashing does not remove linkage. |
| `subject_type` | text; ContainerUsageSubjectType | High | User/org attribution category applied to the metered interval. |
| `subject_id` | text | High | Identifies the billed user in user scope; org-only ownership requires separate interpretation. |
| `actor_type` | text; ContainerUsageActorType | High | Whether attributed activity was performed by a user or bot. |
| `actor_id` | text | High | User actor identifier in user scope, or bot identity linked to the activity. |
| `session_id` | text | High | Correlates the interval to a user's/session's activity. |
| `started_at` | timestamptz | High | Start time of attributable compute activity. |
| `last_seen_at` | timestamptz | High | Last observed activity time of the attributed interval. |
| `last_heartbeat_seq` | integer | Other | Narrow heartbeat ordering counter, distinct from measured user usage. |
| `confirmed_seconds` | integer | High | Confirmed duration of attributable compute use. |
| `billing_mode` | text; ContainerUsageBillingMode | High | Paid versus shadow charging state applied to the interval. |
| `rate_cents_per_unit` | decimal(24,12) | High | Accepted price applied to this subject's usage, not merely a catalog price. |
| `settled_billable_seconds` | integer | High | Amount of attributable compute usage already settled. |
| `stopped_at` | timestamptz | High | End time of attributable compute activity. |
| `close_reason` | text; ContainerUsageCloseReason | High | Why this subject/actor's compute interval ended. |
| `exit_code` | integer | High | Execution outcome of the attributable runtime. |
| `final_stop_seq` | integer | Other | Narrow stop-event ordering marker; enclosing interval remains attributable. |
| `status` | text; ContainerUsageIntervalStatus | High | Open/closed state of attributable compute activity. |
| `metadata` | jsonb; Record<string, string> | High | Metadata attached to user-attributable activity; actual keys and org-only cases need review. |

## 220. container_usage_segment

Source: `packages/db/src/schema.ts:10746`.
Purpose: individual metering segments joined to subject/actor-attributed container intervals.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `interval_id` | text | High | Joins segment usage to its attributed interval. |
| `seq` | integer | High | With interval ID identifies a particular segment of attributable usage. |
| `idempotency_key` | text | High | Unique correlation identifier of the subject's metering event. |
| `reported_seconds` | integer | High | Reported duration of attributable compute activity. |
| `usage_seconds` | integer | High | Counted duration of attributable compute activity. |
| `received_at` | timestamptz | High | Receipt time of the attributable usage report. |

## 221. github_install_states

Source: `packages/db/src/schema.ts:10776`.
Purpose: user-bound GitHub installation-flow state with personal/organization target context and return navigation.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `token` | text | High | Correlation credential for an identified user's installation flow. |
| `kilo_user_id` | text | High | User performing the GitHub installation flow. |
| `owner_type` | text | High | User versus organization target context of the user's action. |
| `owner_id` | text | High | Target owner identifier associated with this user's installation action. |
| `github_app_type` | text | High | GitHub application selected in the user's installation flow. |
| `return_to` | text | High | User-flow navigation destination; may also embed personal URL details. |
| `expires_at` | timestamptz | High | Expiration time of the user's installation state. |
| `consumed_at` | timestamptz | High | Consumption time of the user's installation state. |
| `created_at` | timestamptz | High | Start time of the user's installation flow. |

## 222. native_admission_challenges

Source: `packages/db/src/schema.ts:10800`.
Purpose: native admission/attestation challenges with expiry and consumption state; no user/device link is declared on these rows.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `challenge` | text | Medium | Exchange correlation value may link to a device/user via requests or logs; source ownership unspecified. |
| `expires_at` | timestamptz | Medium | Challenge lifecycle time may describe an attributable admission flow; joins unverified. |
| `consumed_at` | timestamptz | Medium | Consumption activity potentially attributable through the challenge exchange. |
| `created_at` | timestamptz | Medium | Issuance time potentially attributable through request/device context. |

## 223. native_attested_keys

Source: `packages/db/src/schema.ts:10813`.
Purpose: native platform attestation keys explicitly assigned to a user, with signing and usage history.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `key_id` | text | High | User-associated native key/device correlation identifier. |
| `kilo_user_id` | text | High | User associated with the attested key. |
| `platform` | text; 'ios' or 'android' | High | Native platform used by this user/key. |
| `public_key` | text | High | Public cryptographic identifier linked to a user; public key material is not anonymous. |
| `sign_count` | integer | High | Signing/security activity count for this user's key. |
| `last_used_at` | timestamptz | High | Last recorded activity of the user's attested key. |
| `attested_at` | timestamptz | High | Time the user's key was attested. |
| `created_at` | timestamptz | High | Creation time of the user's attested-key record. |

## 224. operation_ledgers

Source: `packages/db/src/schema.ts:10847`.
Purpose: per-user intent/operation outcomes and replay/lease lifecycle; user/resource/provider links are stored as text without declared foreign keys.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user's operation record. |
| `operation_key` | text | High | Correlates a particular operation intent with the user. |
| `domain` | text | High | Product/domain in which this user's operation occurred. |
| `intent` | text | High | Records the intended user-associated action. |
| `kilo_user_id` | text | High | User whose operation is recorded, even without a foreign key. |
| `organization_id` | text | Medium | Organization scope reference; exact natural-person organizational relationship needs joins. |
| `resource_key` | text | High | Resource identifier associated with the user's operation. |
| `provider_ref` | text | High | External-provider reference associated with the user's operation. |
| `taxonomy` | text | High | Classification applied to this user's operation, not a shared taxonomy dictionary. |
| `status` | text | High | Processing/result state of the user's operation. |
| `outcome_code` | text | High | Outcome classification of the user's operation. |
| `canonical_result` | jsonb; Record<string, unknown> or null | High | User-specific operation result; nested contents and minimization unverified. |
| `admitted_at` | timestamptz | High | Admission time of the user's operation. |
| `settled_at` | timestamptz | High | Settlement time of the user's operation. |
| `lease_expires_at` | timestamptz | High | Processing lifecycle boundary for the user's operation. |
| `expires_at` | timestamptz | High | Retention/expiry marker on the user's operation, not evidence of deletion. |

## 225. analytics_event_outbox

Source: `packages/db/src/schema.ts:10899`.
Purpose: analytics event delivery queue with distinct-user identity and arbitrary event properties; source describes delivery to PostHog, not verified external-store contents.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of an identifiable subject's analytics delivery record. |
| `event_uuid` | uuid | High | Cross-system correlation/deduplication identifier for a personal analytics event. |
| `event_name` | text | High | Activity/event recorded for the analytics subject. |
| `distinct_id` | text | High | Analytics subject identifier, potentially linkable across events and stores. |
| `properties` | jsonb; Record<string, unknown> | High | Properties of the subject's analytics event; actual members unverified. |
| `status` | text | High | Delivery state of the subject's personal event. |
| `attempts` | integer | Other | Narrow internal delivery retry counter, not the user's activity count. |
| `next_attempt_at` | timestamptz | High | Planned processing time of this subject's analytics event. |
| `claimed_at` | timestamptz | High | Processing lifecycle time of this subject's event. |
| `created_at` | timestamptz | High | Creation time of the subject's analytics delivery record. |
| `delivered_at` | timestamptz | High | Time the subject's event was marked delivered. |
| `last_error` | text | Medium | Unconstrained delivery diagnostic may contain identifiers or payload fragments. |

## 226. external_side_effect_outbox

Source: `packages/db/src/schema.ts:10947`.
Purpose: organization invitation-email outbox with recipient, inviter, acceptance URL, and delivery lifecycle; invitation reference has no declared foreign key here.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a personal invitation delivery record. |
| `operation` | text; 'send_org_invite_email' | High | Email action concerning an identifiable invitee/inviter. |
| `invitation_id` | uuid | High | Linkable identifier of the individual's invitation. |
| `payload` | jsonb; ExternalSideEffectOutboxPayload | High | Explicit recipient, inviter name, invitation identifier and acceptance URL fields. |
| `status` | text; 'pending' or 'sending' or 'delivered' or 'failed' | High | Delivery state of the personal invitation. |
| `attempts` | integer | Other | Narrow internal email retry count, not an invitee action count. |
| `next_attempt_at` | timestamptz | High | Scheduled processing time of the individual's invitation. |
| `claimed_at` | timestamptz | High | Processing claim time for the individual's invitation. |
| `created_at` | timestamptz | High | Creation time of the individual's invitation delivery record. |
| `delivered_at` | timestamptz | High | Recorded delivery time of the personal invitation. |
| `last_error` | text | Medium | Delivery diagnostic may retain addresses or other personal payload fragments. |

## 227. compute_usage_charge

Source: `packages/db/src/schema.ts:10985`.
Purpose: metered infrastructure debit ledger with exactly one user or organization payer and source-event identity; partition-parent column inventory, not deployed child enumeration.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `usage_source` | text | High | Origin/domain of a potentially individual user's compute charge. |
| `usage_source_id` | text | High | Correlates the charge to attributable source usage; source joins are not foreign keys here. |
| `user_id` | text | High | Individual payer identifier when the charge is user-billed. |
| `organization_id` | uuid | Medium | Organization payer reference; does not by itself identify a natural-person payer. |
| `cloud_billing_sku_id` | text | High | Commercial product billed in the potentially individual usage record. |
| `quantity` | decimal(24,12) | High | Metered quantity charged to the payer, including individual users. |
| `settled_quantity_after` | decimal(24,12) | High | Cumulative settled consumption for the attributable source. |
| `rate_cents_per_unit` | decimal(24,12) | High | Price actually applied to the payer's usage, not just shared catalog configuration. |
| `amount_microdollars` | bigint; mode 'number' | High | Financial charge associated with the payer's compute usage. |
| `created_at` | timestamptz | High | Immutable effective timestamp of the attributable charge per source description. |

## 228. sales_demo_spend_ledger

Source: `packages/db/src/schema.ts:11031`.
Purpose: organization-aggregate demo spend preserved across resets, with optional owner identity; does not establish an owner's individual consumption.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | Medium | Identifier of organization-level spend record; natural-person attribution is uncertain. |
| `organization_id` | uuid | Medium | Demo organization identity; personal ownership/membership requires joins. |
| `owner_kilo_user_id` | text | High | Optional natural-person owner identifier, retained without a declared user foreign key. |
| `period_start` | timestamptz | Medium | Organization spend-period boundary, not necessarily one person's activity. |
| `period_end` | timestamptz | Medium | Organization spend-period/reset boundary; individual attribution unverified. |
| `microdollars_used` | bigint; mode 'number' | Medium | Organization aggregate spend; creator/owner attribution is not proof of personal spend. |

## 229. content_moderation_reports

Source: `packages/db/src/schema.ts:11054`.
Purpose: user-submitted content reports, target/session context, receipts, triage and appeal state; no declared user/target foreign keys are required for personal relevance.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user's moderation report. |
| `kilo_user_id` | text | High | User associated with the report. |
| `surface` | text | High | Product surface involved in this user's report. |
| `target_kind` | text | High | Type of content/entity reported by this user. |
| `target_id` | text | High | Correlatable moderation target identifier, potentially identifying another person/content owner. |
| `model_id` | text | High | Model associated with the user's reported interaction. |
| `session_id` | text | High | Session associated with the user's report. |
| `reason` | text | High | User's reporting reason; may additionally contain personal narrative. |
| `context_json` | jsonb; Record<string, unknown> | High | User/report-associated context even if minimized; runtime member restrictions unverified. |
| `receipt_id` | uuid | High | Unique correlation identifier for the user's report receipt. |
| `triage_status` | text | High | Moderation processing outcome/state concerning the user's report. |
| `appeal_status` | text | High | Appeal state associated with the report. |
| `created_at` | timestamptz | High | Time the user's report was created. |
| `updated_at` | timestamptz | High | Time the user's report or moderation state changed. |

## 230. user_moderation_blocks

Source: `packages/db/src/schema.ts:11090`.
Purpose: user blocking preferences tied to an external GitHub login; records concern both blocker and blocked subject.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user's blocking relationship. |
| `blocker_user_id` | text | High | User choosing to block another account. |
| `blocked_github_login` | text | High | External identity of the blocked subject. |
| `created_at` | timestamptz | High | Time the user's block relationship was recorded. |

## 231. user_moderation_mutes

Source: `packages/db/src/schema.ts:11112`.
Purpose: user mute preferences tied to an external GitHub login; records concern both acting user and muted subject.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user's mute relationship. |
| `blocker_user_id` | text | High | Physical column name identifies the user choosing the mute. |
| `muted_github_login` | text | High | External identity of the muted subject. |
| `created_at` | timestamptz | High | Time the user's mute preference was recorded. |

## 232. user_terms_acceptances

Source: `packages/db/src/schema.ts:11134`.
Purpose: individual terms acceptance and recorded age posture, without requiring a declared user foreign key.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user's acceptance record. |
| `kilo_user_id` | text | High | User whose terms acceptance is recorded. |
| `terms_version` | text | High | Terms version accepted by this user, not a standalone shared document version. |
| `age_posture` | text | High | Recorded age-related posture about this user; default does not prove age verification. |
| `accepted_at` | timestamptz | High | Time of the user's terms acceptance. |

## 233. quick_chat_threads

Source: `packages/db/src/schema.ts:11157`.
Purpose: individual user's quick-chat thread, personal or organization-scoped, anchoring message ownership.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of the user's chat thread and join key for messages. |
| `user_id` | text | High | User owning the chat thread. |
| `organization_id` | uuid | Medium | Organization scope reference; precise natural-person organizational relationship needs joins. |
| `created_at` | timestamptz | High | Creation time of the user's chat thread. |
| `updated_at` | timestamptz | High | Update time of the user's chat thread. |

## 234. quick_chat_messages

Source: `packages/db/src/schema.ts:11187`.
Purpose: chat messages linked through `thread_id` to the thread's `user_id`, including generated replies as part of the user's conversation.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a message in the user's conversation. |
| `thread_id` | uuid | High | Joins the message to the user's chat thread. |
| `role` | text | High | Speaker/function of this message in the user's conversation. |
| `content` | text | High | User-associated conversation content, potentially including information about other people. |
| `client_id` | text | High | Client correlation identifier attached to the user's message. |
| `created_at` | timestamptz | High | Time the user's conversation message was recorded. |

## Source-only verification results

A read-only TypeScript 5.9.3 AST comparison of the source and this Markdown found **234 total `pgTable` declarations** and matched the final **34 tables (#201–234)** with **382 ordered physical column rows**, **34 declaration-start source lines**, and **382 base types**. It checked **49 declared `$type` annotations**, **1 UUID helper use**, **10 physical array columns**, **5 decimal precision/scale declarations**, and **3 bigint number-mode declarations**; there were **0 physical-name aliases** in scope. All **34 per-table summary rows** and the aggregate **327 High / 31 Medium / 24 Other** counts matched, with **0 verification errors**. These counts measure column classifications, not live records or affected people. The AST check validates structural coverage and arithmetic, not the substantive privacy judgments, writer behavior, runtime data, deletion, or deployed catalogs.

## Material follow-ups and limitations

1. **Runtime content and ownership:** trace writers and validators for every Medium field and open JSON/text payload. Confirm personal versus organization MCP configuration ownership, shared OAuth client registration, provider credential ownership, native challenge/request linkage, and organization/bot metering attribution. Inspect controlled synthetic examples or approved minimized evidence rather than copying live secrets. TypeScript annotations alone do not constrain persisted JSON, arbitrary headers/URLs, or diagnostics.
2. **Joins and indirect identity:** verify polymorphic `owner_id`, `subject_id`, `actor_id`, source-charge IDs, analytics `distinct_id`, external provider references, GitHub logins, route keys, and message/client IDs across services. Confirm text identifiers without foreign keys, including ledger users, demo owners, moderation users/targets, invitation IDs, and terms acceptances, are handled by export/deletion policies. Deduplication, hashes, public keys, encryption, nullable references, and aggregation do not establish anonymization.
3. **Retention and deletion:** establish actual policies, scheduled jobs, execution evidence, backup handling, and legal retention requirements. Schema comments describe ledger expiry after 30 days (`packages/db/src/schema.ts:10837–10845`) and analytics outbox purge after 7/30 days (`:10888–10897`); these are source intentions, not verified behavior. Expiry, consumed/revoked/deleted markers and `__deleted__` prompt sentinels do not prove physical erasure. Review retained demo spend, staff audit history, moderation and terms evidence, invitation payloads, credential rotation chains, and failed-delivery diagnostics.
4. **Foreign-key behavior is not a deletion audit:** compare `cascade`, `set null`, `restrict`, and missing constraints to actual workflows. In particular, compute payer references and quick-chat user references are restrictive; actor nulling may leave reidentifiable history, and no-FK user IDs may survive account deletion. Organization-thread cascading and thread-message cascading do not establish that every deletion path runs. No deletion implementation or tests were inspected.
5. **External copies and content:** trace request hashes to R2 objects, including shared hashes/reference counting and failed/deleted sentinels; inspect independently scoped retention/access/export/deletion for analytics destinations such as PostHog, email providers, MCP/OAuth providers, GitHub, runtime/session stores, logs, traces, caches, exports, replicas and backups. The source names some destinations, but this audit neither inventories their contents nor verifies delivery or deletion.
6. **Separate catalog and store inventory:** compare source declarations with authorized deployed PostgreSQL catalogs, migrations, views, and actual partitions. Inventory the source `pgView` separately, including joins/access exposure; it is not an additional `pgTable` in this sequence. Enumerate real partition children for both partitioned parents separately instead of assuming dates, names, schema drift, or retention. Durable Object SQLite and all other non-PostgreSQL stores remain outside this source-table inventory.
7. **Completion boundary:** all remaining declarations in this final range have column-level coverage, not runtime guarantees. Preceding batches, downstream stores, legal-purpose assessment, access controls, runtime data minimization, writer behavior, and working export/deletion coverage require their own evidence. No application tests, lint, or typecheck were run for this documentation-only audit.
