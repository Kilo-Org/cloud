# Personal data audit — batch 04

## Scope, date, and sources

- Date: 2026-09-03.
- Scope: `pgTable` declarations **#121–160 inclusive** in `packages/db/src/schema.ts`, from `code_review_analytics_results` through `app_builder_feedback`: **40 tables and 565 physical columns**. This is one bounded continuation of the remaining-table audit after batches 01/02, not a claim to cover every remaining table. The next declaration is **#161 `cloud_agent_feedback`**, at `packages/db/src/schema.ts:8101`, outside this inventory.
- Every physical column appears once in its table's inventory, in declaration order. Physical table names are used: `cli_sessions` and `shared_cli_sessions`, not their TypeScript export identifiers `cliSessions` and `sharedCliSessions`. JSON members are evidence, not additional physical columns.
- Sources: root `AGENTS.md`, `packages/db/AGENTS.md`, batch 02's introduction and representative rows, `packages/db/src/schema.ts:5667–8097`, supporting review linkage at `:5401–5518` and `:5621–5665`, and local types cited below. Table citations identify declaration starts in this checkout. Root and database package manifests were read before the JavaScript verification command.
- This is a **source-only preliminary audit**, applying the broad definition of personal data as **any data about a user**, including external people and staff, not only names, emails, or IP addresses. No live rows, secrets, deployed catalogs, application writers, runtime payloads, or retention/deletion execution were inspected or validated. This is not a legal determination.
- Schema types describe PostgreSQL types. `timestamptz` denotes `timestamp({ withTimezone: true, mode: 'string' })`; `decimal(p, s)` preserves precision and scale. `text[]` denotes a physical PostgreSQL array, whereas an array after `jsonb;` describes JSON contents. An annotation after `;` names the declared TypeScript `$type`, builder enum hint, or numeric mode; union separators are rendered as `or`. Nullability/defaults are omitted. `idPrimaryKeyColumn` resolves to `uuid` at `packages/db/src/schema.ts:3160–3163`; it supplies no physical-name override. User IDs are arbitrary text, not necessarily UUIDs. TypeScript annotations do not establish runtime validation.

## Classification legend

| Classification | Meaning |
| --- | --- |
| High | High confidence of direct or indirect personal relevance: identity, including external, opaque, hashed, or encrypted identifiers; user-linked financial data, activity, preferences, content, assessments, lifecycle timestamps, and staff actions. Confidence, not a sensitivity score. |
| Medium | Plausible personal contents or uncertain ownership: generic diagnostic/free text, unstructured or imported/shared configuration, or organization-only association needing writer/content/ownership review. The enclosing user-linked record may still be personal. |
| Other | Genuinely shared configuration/vocabulary or narrow plumbing with no independent personal meaning established here. An Other value in a personal record is not permission to publish it, ignore joins, or exclude the enclosing record from privacy handling. |

Row linkage is part of the assessment. Review analytics join to reviews containing PR authors; sessions, device tokens, notifications, reports, feedback, and profile children link to users directly or through their resource. Activity status, costs, model use, performance, vulnerability assessments, and timestamps are not downgraded merely because they are technical. External issue authors and Slack senders remain identifiable even when the owning tenant is an organization or a local owner reference is null.

For XOR user/organization ownership, High resource/activity classifications reflect the expressly supported user-owned branch and any separately evidenced author, actor, or session linkage. They do not assert that every organization-owned resource belongs to a natural person, or that all later activity is attributable to its recorded creator. Organization ownership references are Medium where that relationship alone does not identify a person. Free-form shared/imported profile contents and diagnostics are Medium where their personal contents remain uncertain; selected settings and lifecycle values on the user-owned branch are High. The exceptions classified Other are format/taxonomy revisions, retry mechanics, and a finding ordinal, not general user-associated technical data. Hashes, encryption, public sharing, FK nulling, and deletion timestamps do not establish anonymization.

## Local JSON/type evidence

- `EncryptedData`, `packages/db/src/schema-types.ts:1214–1218`, declares only `iv`, `data`, and `authTag`. BYOK user ownership and creator attribution establish linkability; the type neither reveals the plaintext nor proves whose external account an organization credential represents.
- `DependabotAlertRaw`, `packages/db/src/schema-types.ts:1767–1811`, includes dependency/package/manifest information, advisory details, URLs, lifecycle times, optional `dismissed_by.login`, dismissal reason, and dismissal comment. This supports High for the entire `raw_data` column without assuming the optional login is populated in every row.
- `SecurityFindingAnalysis`, `packages/db/src/schema-types.ts:1866–1877`, includes optional `triggeredByUserId`, `correlationId`, model fields, markdown, analysis time, and nested triage, sandbox analysis, and finding snapshot. The referenced definitions at `:1813–1819` and `:1831–1864` include reasoning, usage locations, suggested fixes, markdown, source/repository identifiers, and vulnerability details. These are evidence of user attribution/content, not extra database columns.
- `AgentConfigSchema`, `packages/db/src/schema-types.ts:1136–1159`, is explicitly referenced for profile agents by `packages/db/src/schema.ts:8009–8012`. It declares optional prompt, description, mode, model, variant, generation controls, visibility flags, color, permission, and free-form `options`. Permission definitions at `packages/db/src/schema-types.ts:1074–1117` permit tool/path-pattern maps and unknown tool keys. The physical column itself has no `$type`; validator presence does not prove writers invoke it.
- Inline annotations: worktree `runtime_locations` and `deletion_manifest` are `unknown` (`packages/db/src/schema.ts:5887–5891`); reported-message signature/message are `Record<string, unknown>` (`:6479–6480`); remediation results/evidence (`:7031–7033`), command results (`:7169`), and audit snapshots (`:7295–7303`) are generic records or arrays of records. No undocumented members are inferred.
- Skill `files` is a `Record<string, string>` (`packages/db/src/schema.ts:7970–7973`), with the source describing relative-path-to-file-content entries. App Builder feedback explicitly declares recent-message objects with `role`, `text`, and numeric `ts` (`:8086`). Neither is a physical SQL array.
- Untyped JSON remains untyped: triage `action_metadata` (`packages/db/src/schema.ts:7480`), period-cache `data` (`:7700`), and MCP `config` (`:7933`). MCP source comments at `:7928–7932` describe command/args/URL and encrypted environment/header values, but are not a checked local JSON type or proof of runtime encryption. They must not be conflated with `EncryptedData`.
- Supporting types: review capture/assessment taxonomy at `packages/db/src/schema-types.ts:1305–1401`; session failure/run types at `packages/db/src/schema.ts:5980–6022` and `:6125–6157`; remediation/command types at `:6915–6932` and `:7135–7145`. Literal categories applied to someone's activity are different from shared dictionary entries.

## Table summary

Classification totals: **503 High**, **50 Medium**, **12 Other** (565 columns).

| # | Table | Columns | High | Medium | Other |
| --- | --- | ---: | ---: | ---: | ---: |
| 121 | code_review_analytics_results | 13 | 11 | 0 | 2 |
| 122 | code_review_analytics_findings | 7 | 6 | 0 | 1 |
| 123 | cli_sessions | 18 | 16 | 1 | 1 |
| 124 | shared_cli_sessions | 10 | 10 | 0 | 0 |
| 125 | cloud_agent_worktrees | 11 | 10 | 1 | 0 |
| 126 | cli_sessions_v2 | 22 | 20 | 1 | 1 |
| 127 | cloud_agent_sessions | 12 | 11 | 1 | 0 |
| 128 | cloud_agent_pending_uploads | 9 | 9 | 0 | 0 |
| 129 | cloud_agent_session_runs | 14 | 13 | 1 | 0 |
| 130 | github_branch_pull_requests | 15 | 14 | 1 | 0 |
| 131 | device_auth_requests | 13 | 13 | 0 | 0 |
| 132 | device_sessions | 8 | 8 | 0 | 0 |
| 133 | device_refresh_tokens | 5 | 5 | 0 | 0 |
| 134 | app_builder_projects | 15 | 14 | 1 | 0 |
| 135 | app_builder_project_sessions | 7 | 7 | 0 | 0 |
| 136 | app_reported_messages | 8 | 7 | 1 | 0 |
| 137 | byok_api_keys | 10 | 9 | 1 | 0 |
| 138 | security_findings | 38 | 34 | 4 | 0 |
| 139 | security_finding_notifications | 12 | 10 | 1 | 1 |
| 140 | security_analysis_queue | 18 | 13 | 2 | 3 |
| 141 | security_analysis_owner_state | 10 | 9 | 1 | 0 |
| 142 | security_remediations | 20 | 19 | 1 | 0 |
| 143 | security_remediation_attempts | 45 | 42 | 2 | 1 |
| 144 | security_agent_commands | 17 | 15 | 2 | 0 |
| 145 | security_agent_repository_sync_state | 9 | 8 | 1 | 0 |
| 146 | security_audit_log | 21 | 19 | 1 | 1 |
| 147 | slack_bot_requests | 19 | 17 | 2 | 0 |
| 148 | auto_triage_tickets | 31 | 29 | 2 | 0 |
| 149 | auto_fix_tickets | 35 | 33 | 2 | 0 |
| 150 | user_period_cache | 10 | 9 | 0 | 1 |
| 151 | free_model_usage | 5 | 5 | 0 | 0 |
| 152 | agent_environment_profiles | 9 | 6 | 3 | 0 |
| 153 | agent_environment_profile_vars | 7 | 5 | 2 | 0 |
| 154 | agent_environment_profile_commands | 5 | 4 | 1 | 0 |
| 155 | agent_environment_profile_repo_bindings | 7 | 6 | 1 | 0 |
| 156 | agent_environment_profile_mcp_servers | 9 | 7 | 2 | 0 |
| 157 | agent_environment_profile_skills | 11 | 6 | 5 | 0 |
| 158 | agent_environment_profile_agents | 7 | 4 | 3 | 0 |
| 159 | agent_environment_profile_kilo_commands | 12 | 9 | 3 | 0 |
| 160 | app_builder_feedback | 11 | 11 | 0 | 0 |
| | **Total** | **565** | **503** | **50** | **12** |

## 121. code_review_analytics_results

Source: `packages/db/src/schema.ts:5667`.
Purpose: finalized review classifications, joined by review/attempt IDs to `cloud_agent_code_reviews` and its PR author and owner.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of an author-linked review assessment. |
| `code_review_id` | uuid | High | Joins to the review, PR author, and owner. |
| `source_attempt_id` | uuid | High | Links assessment to a specific review execution. |
| `capture_status` | text; CodeReviewAnalyticsCaptureStatus | High | Assessment capture outcome for this review activity. |
| `schema_version` | integer | Other | Shared payload-format revision, not a user assessment. |
| `taxonomy_version` | integer | Other | Shared classification-taxonomy revision. |
| `change_type` | text; CodeReviewAnalyticsChangeType | High | Classification of an identifiable author's work. |
| `impact_level` | text; CodeReviewAnalyticsImpactLevel | High | Impact assessment of author-linked work. |
| `complexity_level` | text; CodeReviewAnalyticsComplexityLevel | High | Complexity assessment of author-linked work. |
| `classification_confidence` | text; CodeReviewAnalyticsClassificationConfidence | High | Confidence attached to that specific assessment. |
| `finalized_at` | timestamptz | High | Time this review assessment was finalized. |
| `created_at` | timestamptz | High | Creation time of the author-linked assessment. |
| `updated_at` | timestamptz | High | Update time of the author-linked assessment. |

## 122. code_review_analytics_findings

Source: `packages/db/src/schema.ts:5744`.
Purpose: individual finding classifications linked through analytics results to reviews and PR authors.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Linkable identifier of an author-associated finding. |
| `analytics_result_id` | uuid | High | Join to review assessment and author linkage. |
| `ordinal` | integer | Other | Positional ordering within the result; narrow structural plumbing. |
| `severity` | text; CodeReviewFindingSeverity | High | Severity assessment attached to someone's work. |
| `category` | text; CodeReviewFindingCategory | High | Finding category applied to author-linked work. |
| `security_class` | text; CodeReviewFindingSecurityClass | High | Security classification of the specific finding. |
| `created_at` | timestamptz | High | Time the author-associated finding was recorded. |

## 123. cli_sessions

Source: `packages/db/src/schema.ts:5791`.
Purpose: user-owned legacy CLI sessions, their content references, ancestry, and activity metadata; exported as `cliSessions`.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `session_id` | uuid | High | Identifier of the user's session. |
| `kilo_user_id` | text | High | Identifies the session owner. |
| `title` | text | High | User-session title/content. |
| `created_on_platform` | text | High | Platform used to create this user's session. |
| `api_conversation_history_blob_url` | text | High | External reference to user conversation content. |
| `task_metadata_blob_url` | text | High | External reference to the user's task metadata. |
| `ui_messages_blob_url` | text | High | External reference to session messages. |
| `git_state_blob_url` | text | High | External reference to the user's repository state. |
| `git_url` | text | High | Repository associated with the user's session. |
| `forked_from` | uuid | High | Links the user's session to its source session. |
| `parent_session_id` | uuid | High | Session ancestry revealing related user activity. |
| `cloud_agent_session_id` | text | High | Cross-system identifier of the user's session. |
| `organization_id` | uuid | Medium | Organization context; individual organizational relationship unverified. |
| `last_mode` | text | High | Last operating mode used in this session. |
| `last_model` | text | High | Last model used by this user's session. |
| `version` | integer | Other | Session version marker; narrow revision plumbing. |
| `created_at` | timestamptz | High | User-session creation time. |
| `updated_at` | timestamptz | High | User-session update activity time. |

## 124. shared_cli_sessions

Source: `packages/db/src/schema.ts:5838`.
Purpose: user-attributed shared session snapshots and their external content references; exported as `sharedCliSessions`.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `share_id` | uuid | High | Share identifier links to a user's content. |
| `session_id` | uuid | High | Join to original user session; nullable does not mean anonymous. |
| `kilo_user_id` | text | High | User associated with this shared session. |
| `shared_state` | text | High | User-associated sharing state; public does not mean nonpersonal. |
| `api_conversation_history_blob_url` | text | High | Reference to shared conversation content. |
| `task_metadata_blob_url` | text | High | Reference to the user's shared task metadata. |
| `ui_messages_blob_url` | text | High | Reference to shared user-session messages. |
| `git_state_blob_url` | text | High | Reference to shared repository/session state. |
| `created_at` | timestamptz | High | Time the user's sharing record was created. |
| `updated_at` | timestamptz | High | Time the user's sharing record changed. |

## 125. cloud_agent_worktrees

Source: `packages/db/src/schema.ts:5871`.
Purpose: user-owned worktree metadata, runtime references, and deletion tracking.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `worktree_id` | text | High | Identifier of a user's worktree. |
| `kilo_user_id` | text | High | Identifies the worktree owner. |
| `organization_id` | uuid | Medium | Organization scope; exact personal relationship unverified. |
| `name` | text | High | Name attached to the user's worktree. |
| `created_at` | timestamptz | High | User-worktree creation time. |
| `updated_at` | timestamptz | High | User-worktree update activity. |
| `deletion_started_at` | timestamptz | High | Start of this user's worktree deletion lifecycle. |
| `deletion_completed_at` | timestamptz | High | Recorded completion time, not proof of external erasure. |
| `runtime_locations` | jsonb; unknown | High | User-worktree runtime references; member shape is explicitly unknown. |
| `deletion_manifest` | jsonb; unknown | High | Deletion record for the user's worktree; members unverified. |
| `deleted_session_ids` | text[] | High | Array of session identifiers retained in deletion tracking. |

## 126. cli_sessions_v2

Source: `packages/db/src/schema.ts:5908`.
Purpose: user-keyed modern session metadata, repository context, lifecycle, and cost; parent linkage also includes the user ID.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `session_id` | text | High | User-associated session identifier. |
| `kilo_user_id` | text | High | Owner and part of the session's composite key. |
| `version` | integer | Other | Session revision marker; narrow synchronization plumbing. |
| `title` | text | High | User-session descriptive content. |
| `public_id` | uuid | High | Public-facing identifier still links to a user's session. |
| `parent_session_id` | text | High | Ancestry reference within the user's sessions. |
| `organization_id` | uuid | Medium | Organization context; membership/ownership details unverified. |
| `cloud_agent_session_id` | text | High | Link to the user's cloud execution. |
| `cloud_agent_session_scope_id` | text | High | Scope identifier of user-associated runtime state. |
| `cloud_agent_worktree_id` | text | High | Links this session to the user's worktree. |
| `created_on_platform` | text | High | Origin platform for the user's activity. |
| `git_url` | text | High | Repository reference associated with user activity. |
| `git_branch` | text | High | Branch used by this user's session. |
| `platform` | text | High | PR hosting service for this user's session, not OS vocabulary. |
| `pr_url` | text | High | Link to a user-associated pull request. |
| `pr_number` | integer | High | Repository-scoped identifier of that pull request. |
| `status` | text | High | User-session activity state. |
| `status_updated_at` | timestamptz | High | Time the user's session state changed. |
| `last_activity_at` | timestamptz | High | Last observed user-session activity. |
| `total_cost_microdollars` | bigint; mode: 'number' | High | Financial consumption attributed to this session. |
| `created_at` | timestamptz | High | User-session creation time. |
| `updated_at` | timestamptz | High | User-session update time. |

## 127. cloud_agent_sessions

Source: `packages/db/src/schema.ts:6024`.
Purpose: cloud session admission/failure records; session/message IDs provide logical linkage to user sessions, without a declared user FK here.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `cloud_agent_session_id` | text | High | Cross-system identifier of a user session. |
| `kilo_session_id` | text | High | Identifier linking to the user's Kilo session. |
| `initial_message_id` | text | High | Identifier of the user's initiating message. |
| `sandbox_id` | text | High | Runtime identifier associated with user-session execution. |
| `created_at` | timestamptz | High | Time of this user's cloud session creation. |
| `failure_at` | timestamptz | High | Time of this session's failure. |
| `failure_stage` | text; CloudAgentSessionFailureStage | High | Stage at which the user's session failed. |
| `failure_code` | text; CloudAgentSessionFailureCode | High | Classified failure outcome of user activity. |
| `failure_responsibility` | text; CloudAgentFailureResponsibility | High | Attribution assessment about the session failure. |
| `failure_reason` | text; CloudAgentFailureReason | High | Failure reason attached to the user's session. |
| `error_message_redacted` | text | Medium | Diagnostic text may retain personal details; redaction unverified. |
| `error_expires_at` | timestamptz | High | Retention deadline attached to a user-session error. |

## 128. cloud_agent_pending_uploads

Source: `packages/db/src/schema.ts:6091`.
Purpose: user/message attachment-upload ledger and expiry state; object storage behavior is described in source comments but not verified.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | text | High | Identifier of a user's attachment upload. |
| `kilo_user_id` | text | High | Explicit user identifier, despite no declared FK. |
| `object_key` | text | High | External storage locator for the user's attachment. |
| `message_uuid` | text | High | Identifier linking upload to a user message. |
| `attachment_id` | text | High | Identifier of the user's attachment. |
| `byte_size` | integer | High | Size of user-uploaded content. |
| `status` | text | High | Upload lifecycle state for this user's content. |
| `created_at` | timestamptz | High | Upload admission time. |
| `expires_at` | timestamptz | High | Expiry deadline for the user's pending upload. |

## 129. cloud_agent_session_runs

Source: `packages/db/src/schema.ts:6159`.
Purpose: message-level execution lifecycle and failures linked to cloud sessions.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `cloud_agent_session_id` | text | High | Join to the user's cloud session. |
| `message_id` | text | High | Identifier of the message driving this run. |
| `wrapper_run_id` | text | High | Runtime correlation identifier for user activity. |
| `status` | text; CloudAgentSessionRunStatus | High | Outcome/state of this user's run. |
| `queued_at` | timestamptz | High | Time user-message execution was queued. |
| `dispatch_accepted_at` | timestamptz | High | Dispatch time of the user's run. |
| `agent_activity_observed_at` | timestamptz | High | Observed activity time for this execution. |
| `terminal_at` | timestamptz | High | End-state time of the user's run. |
| `failure_stage` | text; CloudAgentSessionRunFailureStage | High | Failure stage for user-message execution. |
| `failure_code` | text; CloudAgentSessionRunFailureCode | High | Classified outcome of that execution. |
| `failure_responsibility` | text; CloudAgentFailureResponsibility | High | Responsibility assessment for the user's failed run. |
| `failure_reason` | text; CloudAgentFailureReason | High | Failure reason attached to user activity. |
| `error_message_redacted` | text | Medium | Diagnostic payload contents and redaction require inspection. |
| `error_expires_at` | timestamptz | High | Error-retention deadline for this user's run. |

## 130. github_branch_pull_requests

Source: `packages/db/src/schema.ts:6239`.
Purpose: tenant-scoped repository/branch PR cache, with user or organization ownership and logical session joins by repository/branch.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `git_url` | text | High | Repository reference on the user-owned activity branch. |
| `git_branch` | text | High | Branch associated with user-owned PR/session activity. |
| `owned_by_organization_id` | uuid | Medium | Organization ownership alone does not identify a natural person. |
| `owned_by_user_id` | text | High | Explicit personal owner identifier. |
| `pr_url` | text | High | External identifier linking to PR activity and authors. |
| `pr_number` | integer | High | Repository-scoped external PR identifier. |
| `pr_state` | text | High | State of the user-associated pull request. |
| `pr_title` | text | High | Title/content of user-associated PR activity. |
| `pr_head_sha` | text | High | Commit hash links to authored repository activity. |
| `pr_review_decision` | text | High | Review assessment attached to the pull request. |
| `review_decision_pending` | boolean | High | Pending review-assessment state for this activity. |
| `review_decision_fetching_at` | timestamptz | High | Review-state processing time for the user-owned PR. |
| `pr_last_synced_at` | timestamptz | High | Last synchronization time for this user's branch/PR state. |
| `created_at` | timestamptz | High | Creation time of the user-owned cache record. |
| `updated_at` | timestamptz | High | Update time of the user-owned cache record. |

## 131. device_auth_requests

Source: `packages/db/src/schema.ts:6298`.
Purpose: device authorization attempts, user linkage, codes, client metadata, and lifecycle; unapproved attempts may lack a user FK value.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Linkable identifier of an authentication attempt. |
| `code` | text | High | Authentication code identifying the device flow. |
| `kilo_user_id` | text | High | User associated with the authorization attempt. |
| `status` | text; 'pending' or 'approved' or 'denied' or 'expired' or 'consumed' | High | Authentication decision/state about user access. |
| `expires_at` | timestamptz | High | Expiry of this device authorization attempt. |
| `approved_at` | timestamptz | High | Time device access was approved. |
| `consumed_at` | timestamptz | High | Time authorization was consumed. |
| `user_code` | text | High | User-facing code links to authentication activity. |
| `device_code_hash` | text | High | Hashed authentication identifier remains linkable. |
| `user_agent` | text | High | Client/device attributes captured for this attempt. |
| `ip_address` | text | High | Network identifier associated with authentication. |
| `created_at` | timestamptz | High | Authentication-attempt creation time. |
| `updated_at` | timestamptz | High | Authentication-attempt update time. |

## 132. device_sessions

Source: `packages/db/src/schema.ts:6344`.
Purpose: authenticated user device sessions and revocation/activity history.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of the user's authenticated device session. |
| `kilo_user_id` | text | High | User owning the device session. |
| `device_auth_request_id` | uuid | High | Logical link to the authorization attempt; no FK declared here. |
| `user_agent` | text | High | Client/device description for this user's session. |
| `created_at` | timestamptz | High | Device-session creation time. |
| `last_seen_at` | timestamptz | High | User-device activity time. |
| `revoked_at` | timestamptz | High | Time access for this user session was revoked. |
| `revoked_reason` | text | High | Recorded rationale for revoking the user's device access. |

## 133. device_refresh_tokens

Source: `packages/db/src/schema.ts:6369`.
Purpose: hashed refresh credentials and lifecycle joined to authenticated user device sessions.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `token_hash` | text | High | Hashed credential identifies a user-linked session token. |
| `device_session_id` | uuid | High | Join to the device session and its user. |
| `expires_at` | timestamptz | High | Expiry of the user's refresh credential. |
| `consumed_at` | timestamptz | High | Token-use time associated with user access. |
| `created_at` | timestamptz | High | Creation time of the user's refresh credential. |

## 134. app_builder_projects

Source: `packages/db/src/schema.ts:6389`.
Purpose: App Builder projects with creator attribution, XOR ownership, session/deployment links, and repository migration metadata.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user-owned or creator-attributed project. |
| `created_by_user_id` | text | High | Explicit creator identity, without a declared FK. |
| `owned_by_user_id` | text | High | Personal project-owner identifier. |
| `owned_by_organization_id` | uuid | Medium | Organization owner; not itself a natural-person identity. |
| `session_id` | text | High | Associated cloud session links to user activity. |
| `title` | text | High | Descriptive content of the user-created project. |
| `model_id` | text | High | Model selection for the user-owned project. |
| `template` | text | High | Template choice on the user's project, not a shared catalog row. |
| `deployment_id` | uuid | High | External-resource linkage for the user's project deployment. |
| `last_message_at` | timestamptz | High | Last messaging activity associated with the project. |
| `git_repo_full_name` | text | High | Repository identity associated with the user's project. |
| `git_platform_integration_id` | uuid | High | Integration linkage used for this project's migration. |
| `migrated_at` | timestamptz | High | Repository migration time for the user-owned project. |
| `created_at` | timestamptz | High | Project creation activity time. |
| `updated_at` | timestamptz | High | Project update activity time. |

## 135. app_builder_project_sessions

Source: `packages/db/src/schema.ts:6449`.
Purpose: cloud session history linked to App Builder projects and their user/session context.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a project-associated user session record. |
| `project_id` | uuid | High | Join to the user-owned/creator-attributed project. |
| `cloud_agent_session_id` | text | High | Cross-system identifier of the project's session. |
| `created_at` | timestamptz | High | Time the user-associated session began. |
| `ended_at` | timestamptz | High | Time the user-associated session ended. |
| `reason` | text | High | Why a new project session was initiated. |
| `worker_version` | text | High | Runtime version used for this user's execution, not a global catalog. |

## 136. app_reported_messages

Source: `packages/db/src/schema.ts:6473`.
Purpose: reported application messages and request context, optionally joined through legacy CLI sessions to users.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `report_id` | uuid | High | Linkable identifier of a user-session message report. |
| `report_type` | text | High | Classification of the user's message-report activity. |
| `signature` | jsonb; Record<string, unknown> | Medium | Generic signature object; identity/content semantics are not declared. |
| `message` | jsonb; Record<string, unknown> | High | Reported message content linked to session activity; members unverified. |
| `created_at` | timestamptz | High | Time the message report was recorded. |
| `cli_session_id` | uuid | High | Optional join to the session and its user. |
| `mode` | text | High | Operating mode associated with the reported message. |
| `model` | text | High | Model associated with that user's message activity. |

## 137. byok_api_keys

Source: `packages/db/src/schema.ts:6491`.
Purpose: encrypted provider credentials with user/organization ownership, management state, and creator attribution.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user-owned or creator-attributed credential record. |
| `organization_id` | uuid | Medium | Organization ownership does not establish the external account's person. |
| `kilo_user_id` | text | High | Identifies the personal credential owner. |
| `provider_id` | text | High | Provider selected for this user's credential. |
| `encrypted_api_key` | jsonb; EncryptedData | High | Encrypted user-linked credential; encryption does not remove linkability. |
| `management_source` | text; BYOKManagementSource | High | Management origin of this user-associated credential. |
| `is_enabled` | boolean | High | User-associated credential activation state. |
| `created_at` | timestamptz | High | Time the credential was created/registered. |
| `updated_at` | timestamptz | High | Credential update activity time. |
| `created_by` | text | High | Recorded creator identity/action attribution. |

## 138. security_findings

Source: `packages/db/src/schema.ts:6539`.
Purpose: owner-scoped repository findings, dismissal activity, session analyses, and provider snapshots; user-owned findings describe that user's repository security state.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user-owned security finding. |
| `owned_by_organization_id` | uuid | Medium | Organization owner without a definite natural-person relationship. |
| `owned_by_user_id` | text | High | Identifies the personal finding owner. |
| `platform_integration_id` | uuid | High | Integration linkage on the user-owned finding. |
| `repo_full_name` | text | High | Repository identity attached to the user's security assessment. |
| `source` | text | High | Detection source for this user's finding. |
| `source_id` | text | High | External source identifier of the owner-scoped finding. |
| `severity` | text | High | Security severity assessment applied to the user's repository. |
| `ghsa_id` | text | High | Associates a public advisory with this user's affected repository. |
| `cve_id` | text | High | Associates a public vulnerability with the user's finding. |
| `package_name` | text | High | Dependency recorded as affected in the user's repository. |
| `package_ecosystem` | text | High | Ecosystem of that user's affected dependency. |
| `vulnerable_version_range` | text | High | Vulnerability range applied to this user's dependency finding. |
| `patched_version` | text | High | Remediation version associated with the user's finding. |
| `manifest_path` | text | High | Repository path in the user-owned finding. |
| `title` | text | Medium | May be generic advisory text or contain repository/person details. |
| `description` | text | Medium | Upstream/free-form details; actual personal contents uncertain. |
| `status` | text | High | State of the user's security finding. |
| `ignored_reason` | text | High | Rationale recorded for a dismissal action. |
| `ignored_by` | text | High | Identity of the actor dismissing the finding. |
| `fixed_at` | timestamptz | High | Time remediation was recorded for the user's finding. |
| `sla_due_at` | timestamptz | High | Remediation deadline on the user-owned finding. |
| `dependabot_html_url` | text | High | External URL identifying the repository-specific alert. |
| `cwe_ids` | text[] | High | Weakness categories applied to the user's affected repository. |
| `cvss_score` | decimal(3, 1) | High | Severity score associated with the user's finding. |
| `dependency_scope` | text | High | Development/runtime role of the user's affected dependency. |
| `session_id` | text | High | Cloud analysis session identifier. |
| `cli_session_id` | text | High | CLI analysis session identifier linking to user activity. |
| `analysis_status` | text | High | State of analysis of the user's finding. |
| `analysis_started_at` | timestamptz | High | Start time of the user-associated analysis. |
| `analysis_completed_at` | timestamptz | High | Completion time of that analysis. |
| `analysis_error` | text | Medium | Diagnostic contents may embed personal or repository details. |
| `analysis` | jsonb; SecurityFindingAnalysis | High | Declares optional triggering user ID, content, and analysis activity. |
| `raw_data` | jsonb; DependabotAlertRaw | High | Declares optional dismissing login, comments, URLs, and lifecycle data. |
| `first_detected_at` | timestamptz | High | First detection time of the user's finding. |
| `last_synced_at` | timestamptz | High | Latest synchronization of the user's finding. |
| `created_at` | timestamptz | High | Creation time of the user-owned finding record. |
| `updated_at` | timestamptz | High | Update time of the user-owned finding record. |

## 139. security_finding_notifications

Source: `packages/db/src/schema.ts:6663`.
Purpose: recipient-specific notification delivery records, with table-level FKs to findings and users.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a notification addressed to a user. |
| `finding_id` | uuid | High | Finding associated with this user's notification. |
| `recipient_user_id` | text | High | Identifies the notification recipient. |
| `kind` | text; SecurityFindingNotificationKindType | High | Kind of communication directed to the user. |
| `status` | text; SecurityFindingNotificationStatusType | High | Delivery state of the user's notification. |
| `attempt_count` | integer | Other | Retry counter used as narrow delivery plumbing. |
| `next_attempt_at` | timestamptz | High | Next scheduled delivery for this user. |
| `claimed_at` | timestamptz | High | Processing time of the user-addressed notification. |
| `sent_at` | timestamptz | High | Time communication was sent to the user. |
| `error_message` | text | Medium | Diagnostic contents may include personal delivery details. |
| `created_at` | timestamptz | High | Notification creation time. |
| `updated_at` | timestamptz | High | Notification delivery-state update time. |

## 140. security_analysis_queue

Source: `packages/db/src/schema.ts:6744`.
Purpose: finding-analysis work queue with owner scope, claim correlation, outcomes, and retry state.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of analysis work for a user-owned finding. |
| `finding_id` | uuid | High | Join to finding, owner, and analysis context. |
| `owned_by_organization_id` | uuid | Medium | Organization-only ownership relationship requires confirmation. |
| `owned_by_user_id` | text | High | Personal owner of queued analysis. |
| `queue_status` | text | High | Processing state of the user's analysis work. |
| `severity_rank` | smallint | High | Severity-derived priority applied to the user's finding. |
| `admitted_config_revision` | integer | Other | Configuration revision marker used for queue admission. |
| `queued_at` | timestamptz | High | Time analysis of the user's finding was queued. |
| `claimed_at` | timestamptz | High | Time the user's queued analysis was claimed. |
| `claimed_by_job_id` | text | High | Job identifier correlates execution with this finding. |
| `claim_token` | text | High | Linkable claim identifier for the user-associated analysis. |
| `attempt_count` | integer | Other | Narrow queue retry counter. |
| `reopen_requeue_count` | integer | Other | Queue loop-guard counter rather than a user assessment. |
| `next_retry_at` | timestamptz | High | Retry schedule for the user's analysis. |
| `failure_code` | text | High | Failure outcome, including access/credit eligibility, for this work. |
| `last_error_redacted` | text | Medium | Diagnostic text; personal contents/redaction not verified. |
| `created_at` | timestamptz | High | Creation time of the user's queued work. |
| `updated_at` | timestamptz | High | Update time of the user's queued work. |

## 141. security_analysis_owner_state

Source: `packages/db/src/schema.ts:6868`.
Purpose: per-owner automatic-analysis enablement, blocking state, and actor-resolution failures.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of state associated with a personal owner. |
| `owned_by_organization_id` | uuid | Medium | Organization-only scope does not identify a natural person. |
| `owned_by_user_id` | text | High | Identifies the personal analysis owner. |
| `auto_analysis_enabled_at` | timestamptz | High | Time automated analysis was enabled for the user. |
| `blocked_until` | timestamptz | High | End of an owner-specific processing restriction. |
| `block_reason` | text | High | Owner-specific restriction reason, including credits or operator pause. |
| `consecutive_actor_resolution_failures` | integer | High | Failure history specifically about resolving the owner's actor. |
| `last_actor_resolution_failure_at` | timestamptz | High | Time of the owner's last actor-resolution failure. |
| `created_at` | timestamptz | High | Owner-state creation time. |
| `updated_at` | timestamptz | High | Owner-state update time. |

## 142. security_remediations

Source: `packages/db/src/schema.ts:6934`.
Purpose: owner/finding-linked remediation state, analysis fingerprints, outcomes, and PR metadata.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of remediation for a user-owned finding. |
| `owned_by_organization_id` | uuid | Medium | Organization ownership does not alone establish personal ownership. |
| `owned_by_user_id` | text | High | Identifies the personal remediation owner. |
| `finding_id` | uuid | High | Join to the user's finding and analysis. |
| `repo_full_name` | text | High | Repository identity for the user's remediation. |
| `status` | text; SecurityRemediationStatus | High | Outcome/state of the user's remediation. |
| `latest_attempt_id` | uuid | High | Identifier linking to remediation execution history. |
| `latest_analysis_fingerprint` | text | High | Fingerprint correlates the user's analysis; not anonymous. |
| `latest_analysis_completed_at` | timestamptz | High | Time the relevant user-associated analysis completed. |
| `pr_url` | text | High | External identifier of the remediation PR. |
| `pr_number` | integer | High | Repository-scoped PR identifier. |
| `pr_draft` | boolean | High | Publication state of the user's remediation PR. |
| `pr_head_branch` | text | High | Source branch associated with user-owned remediation. |
| `pr_base_branch` | text | High | Target branch associated with user-owned remediation. |
| `failure_code` | text | High | Failure outcome of this remediation activity. |
| `blocked_reason` | text | High | Rationale for blocking the user's remediation. |
| `outcome_summary` | text | High | Narrative result of user-associated remediation work. |
| `completed_at` | timestamptz | High | Remediation completion time. |
| `created_at` | timestamptz | High | Remediation creation time. |
| `updated_at` | timestamptz | High | Remediation update time. |

## 143. security_remediation_attempts

Source: `packages/db/src/schema.ts:6990`.
Purpose: individual remediation executions with requester/cancellation attribution, session links, generated content, and operational state.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of user-associated remediation execution. |
| `remediation_id` | uuid | High | Join to owner-scoped remediation history. |
| `finding_id` | uuid | High | Join to the affected finding and analysis. |
| `owned_by_organization_id` | uuid | Medium | Organization ownership alone does not establish the person. |
| `owned_by_user_id` | text | High | Personal execution-owner identifier. |
| `repo_full_name` | text | High | Repository identity for this user's remediation attempt. |
| `origin` | text; SecurityRemediationOrigin | High | How this remediation action was initiated. |
| `status` | text; SecurityRemediationAttemptStatus | High | State/outcome of this user's execution. |
| `attempt_number` | integer | High | Position in the user's substantive remediation-attempt history. |
| `retry_of_attempt_id` | uuid | High | Links related user-associated attempts. |
| `requested_by_user_id` | text | High | Identifies the requesting person. |
| `analysis_fingerprint` | text | High | Correlation fingerprint of the finding analysis. |
| `analysis_completed_at` | timestamptz | High | Time the source analysis completed. |
| `remediation_model_slug` | text | High | Model used for the user's remediation. |
| `branch_name` | text | High | Branch created/used for user-associated work. |
| `cloud_agent_session_id` | text | High | Cloud-session execution identifier. |
| `kilo_session_id` | text | High | Kilo session linkage to user activity. |
| `execution_id` | text | High | Cross-system execution identifier for this attempt. |
| `priority` | smallint | High | Scheduling priority applied to this user's remediation. |
| `claim_token` | text | High | Linkable processing token for the attempt. |
| `claimed_at` | timestamptz | High | Time this user's attempt was claimed. |
| `claimed_by_job_id` | text | High | Job correlation identifier for user-associated execution. |
| `launch_attempt_count` | integer | Other | Narrow launch-retry mechanics within the substantive attempt. |
| `next_retry_at` | timestamptz | High | Retry schedule for this user's attempt. |
| `callback_attempt_token_hash` | text | High | Hashed callback credential identifies the execution. |
| `failure_code` | text | High | Failure classification for the attempt. |
| `blocked_reason` | text | High | Rationale for blocking this user's execution. |
| `last_error_redacted` | text | Medium | Diagnostic contents and redaction remain unverified. |
| `structured_result` | jsonb; Record<string, unknown> | High | Result of user-associated remediation; members unspecified. |
| `final_assistant_message` | text | High | Generated message content for the user's remediation. |
| `validation_evidence` | jsonb; Record<string, unknown>[] | High | Evidence attached to this user's work; nested contents unknown. |
| `risk_notes` | text | High | Risk assessment content for the user's remediation. |
| `draft_reason` | text | High | Rationale for the publication state of that work. |
| `pr_url` | text | High | External PR identifier associated with the attempt. |
| `pr_number` | integer | High | Repository-scoped identifier of the remediation PR. |
| `pr_draft` | boolean | High | Draft/publication state of user-associated work. |
| `pr_head_branch` | text | High | Head branch used in the user's remediation PR. |
| `pr_base_branch` | text | High | Target branch used in the user's remediation PR. |
| `cancellation_requested_at` | timestamptz | High | Time someone requested cancellation. |
| `cancellation_requested_by_user_id` | text | High | Identifies the person requesting cancellation. |
| `queued_at` | timestamptz | High | Time the user's remediation attempt entered the queue. |
| `launched_at` | timestamptz | High | Execution launch time. |
| `completed_at` | timestamptz | High | Execution completion time. |
| `created_at` | timestamptz | High | Attempt-record creation time. |
| `updated_at` | timestamptz | High | Attempt-record update time. |

## 144. security_agent_commands

Source: `packages/db/src/schema.ts:7147`.
Purpose: owner-scoped Security Agent commands, client intent identifiers, results, and lifecycle.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user-owned command/action. |
| `command_type` | text; SecurityAgentCommandType | High | Type of action initiated for the user. |
| `origin` | text; SecurityAgentCommandOrigin | High | Origin of this command activity. |
| `owned_by_organization_id` | uuid | Medium | Organization scope; natural-person attribution unverified. |
| `owned_by_user_id` | text | High | Personal command-owner identifier. |
| `finding_id` | uuid | High | Links the user's command to its target finding. |
| `repo_full_name` | text | High | Repository targeted by user-associated activity. |
| `operation_key` | text | High | Stable client-intent identifier; deduplication does not remove linkage. |
| `status` | text; SecurityAgentCommandStatus | High | Command execution outcome/state. |
| `result_code` | text | High | Result classification for this user's action. |
| `result_metadata` | jsonb; Record<string, unknown> | High | User-command result payload; exact members unspecified. |
| `last_error_redacted` | text | Medium | Diagnostic text may retain personal content. |
| `accepted_at` | timestamptz | High | Time the user's command was accepted. |
| `started_at` | timestamptz | High | Time command execution began. |
| `completed_at` | timestamptz | High | Time command execution ended. |
| `created_at` | timestamptz | High | Creation time of this action record. |
| `updated_at` | timestamptz | High | Update time of this action record. |

## 145. security_agent_repository_sync_state

Source: `packages/db/src/schema.ts:7233`.
Purpose: per-owner repository synchronization attempts and outcomes.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of synchronization state for a user's repository. |
| `owned_by_organization_id` | uuid | Medium | Organization-only owner relationship needs confirmation. |
| `owned_by_user_id` | text | High | Identifies the personal repository-sync owner. |
| `repo_full_name` | text | High | Repository identity attached to the user's synchronization. |
| `last_attempted_at` | timestamptz | High | Last synchronization attempt for the user's repository. |
| `last_succeeded_at` | timestamptz | High | Last successful synchronization for that repository. |
| `last_failure_code` | text | High | Last recorded failure outcome for user-owned synchronization. |
| `created_at` | timestamptz | High | Creation time of the owner's synchronization state. |
| `updated_at` | timestamptz | High | Update time of the owner's synchronization state. |

## 146. security_audit_log

Source: `packages/db/src/schema.ts:7276`.
Purpose: Security Agent action history with actor identities, resource links, snapshots, and timing; system events may have no actor.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of an owner/actor-linked audit event. |
| `owned_by_organization_id` | uuid | Medium | Tenant association does not itself identify the actor. |
| `owned_by_user_id` | text | High | Personal owner identifier for the audited activity. |
| `actor_id` | text | High | Identifies the person performing the action when present. |
| `actor_email` | text | High | Actor email address. |
| `actor_name` | text | High | Actor display/name information. |
| `actor_type` | text; SecurityAuditLogActorType | High | Attribution category attached to the audited action. |
| `action` | text; SecurityAuditLogAction | High | Recorded user/staff action or user-resource event. |
| `resource_type` | text | High | Kind of resource targeted by that action. |
| `resource_id` | text | High | Identifier of the action's target resource. |
| `before_state` | jsonb; Record<string, unknown> | High | Prior state captured in an actor/owner-associated audit record. |
| `after_state` | jsonb; Record<string, unknown> | High | Resulting state of the audited action; members unspecified. |
| `metadata` | jsonb; Record<string, unknown> | High | Context of the actor/owner-associated event; members unspecified. |
| `finding_id` | uuid | High | Logical finding identifier tying event to security history. |
| `occurred_at` | timestamptz | High | Time of the audited action/event. |
| `source_occurred_at` | timestamptz | High | Source-system time of the action/event. |
| `event_key` | text | High | Stable identifier correlating owner-scoped audit activity. |
| `schema_version` | smallint | Other | Shared audit-record format revision. |
| `finding_snapshot` | jsonb; Record<string, unknown> | High | Finding state retained with the actor/owner-associated event. |
| `source_context` | text; SecurityFindingAuditSourceContext | High | Origin/context of the audited activity. |
| `created_at` | timestamptz | High | Time the action history was recorded. |

## 147. slack_bot_requests

Source: `packages/db/src/schema.ts:7350`.
Purpose: Slack sender requests, message content, responses, and execution telemetry; the external sender remains identified even for orphaned tenant records.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of an identified sender's request. |
| `owned_by_organization_id` | uuid | Medium | Organization ownership relationship distinct from sender identity. |
| `owned_by_user_id` | text | High | Personal integration-owner identifier. |
| `platform_integration_id` | uuid | High | Integration used for this sender-attributed request. |
| `slack_team_id` | text | High | External workspace identifier contextualizing the sender's activity. |
| `slack_team_name` | text | High | Workspace name associated with this sender's request. |
| `slack_channel_id` | text | High | Channel identifier locating the person's message activity. |
| `slack_user_id` | text | High | External identifier of the message sender. |
| `slack_thread_ts` | text | High | External thread/time identifier for the person's conversation. |
| `event_type` | text; SlackBotEventType | High | Type of sender interaction recorded. |
| `user_message` | text | High | User-supplied message content. |
| `user_message_truncated` | text | High | Message excerpt remains personal content. |
| `status` | text; SlackBotRequestStatus | High | Outcome of the sender's request. |
| `error_message` | text | Medium | Diagnostic content may embed personal details. |
| `response_time_ms` | integer | High | Performance experienced by this identified sender's request. |
| `model_used` | text | High | Model used for the person's request. |
| `tool_calls_made` | text[] | High | Tools invoked during the sender's activity. |
| `cloud_agent_session_id` | text | High | Session spawned from the identified sender's request. |
| `created_at` | timestamptz | High | Time of the sender's request activity. |

## 148. auto_triage_tickets

Source: `packages/db/src/schema.ts:7423`.
Purpose: issue/PR triage with external author identity, source content, generated assessments, duplicate links, and action history.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a ticket tied to an external author. |
| `owned_by_organization_id` | uuid | Medium | Organization owner distinct from the issue author's identity. |
| `owned_by_user_id` | text | High | Personal ticket-owner identifier. |
| `platform_integration_id` | uuid | High | Integration linkage for author-associated ticket processing. |
| `platform` | text | High | Hosting platform for the author's issue/PR activity. |
| `repo_full_name` | text | High | Repository context for the identified author's ticket. |
| `issue_number` | integer | High | Repository-scoped identifier of authored content. |
| `issue_url` | text | High | External URL linking to the authored issue/PR. |
| `issue_title` | text | High | Content supplied with the author's issue/PR. |
| `issue_body` | text | High | Authored issue/PR content, potentially describing others too. |
| `issue_author` | text | High | External author identity. |
| `issue_type` | text; 'issue' or 'pull_request' | High | Kind of contribution made by the author. |
| `issue_labels` | text[] | High | Labels applied to the identified author's contribution. |
| `classification` | text; 'bug' or 'feature' or 'question' or 'duplicate' or 'unclear' | High | Automated assessment of the author's content. |
| `confidence` | decimal(3, 2) | High | Confidence in that author-linked assessment. |
| `intent_summary` | text | High | Inferred intent of the author's contribution. |
| `related_files` | text[] | High | Repository paths associated with that contribution. |
| `is_duplicate` | boolean | High | Duplicate assessment of the author's ticket. |
| `duplicate_of_ticket_id` | uuid | High | Links related tickets and their authors/content. |
| `similarity_score` | decimal(3, 2) | High | Similarity assessment of authored content. |
| `qdrant_point_id` | text | High | External vector-store identifier; source-described MD5 remains linkable. |
| `session_id` | text | High | Triage execution session identifier. |
| `should_auto_fix` | boolean | High | Action eligibility/decision applied to the author's ticket. |
| `status` | text; 'pending' or 'analyzing' or 'actioned' or 'failed' or 'skipped' | High | Processing state of the author's contribution. |
| `action_taken` | text; 'pr_created' or 'comment_posted' or 'closed_duplicate' or 'needs_clarification' | High | Action taken on the author's ticket. |
| `action_metadata` | jsonb | High | Action context associated with authored content; members undeclared. |
| `error_message` | text | Medium | Diagnostic text may embed personal or repository details. |
| `started_at` | timestamptz | High | Start time of author-associated triage activity. |
| `completed_at` | timestamptz | High | Completion time of that triage activity. |
| `created_at` | timestamptz | High | Time the author-associated ticket was recorded. |
| `updated_at` | timestamptz | High | Ticket processing/update time. |

## 149. auto_fix_tickets

Source: `packages/db/src/schema.ts:7557`.
Purpose: automated fixes for authored issues or review comments, with source/code context, assessments, sessions, and resulting PRs.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a fix tied to authored content. |
| `owned_by_organization_id` | uuid | Medium | Organization ownership does not identify the contributing person. |
| `owned_by_user_id` | text | High | Personal fix-owner identifier. |
| `platform_integration_id` | uuid | High | Integration used for author-associated fix activity. |
| `triage_ticket_id` | uuid | High | Join to triage content, assessments, and author identity. |
| `platform` | text | High | Hosting service for the author's contribution. |
| `repo_full_name` | text | High | Repository context for the authored issue/fix. |
| `issue_number` | integer | High | Repository-scoped identifier of the authored issue. |
| `issue_url` | text | High | External URL identifying the source contribution. |
| `issue_title` | text | High | Title of the author's issue. |
| `issue_body` | text | High | Authored issue content. |
| `issue_author` | text | High | External identity of the issue author. |
| `issue_labels` | text[] | High | Labels associated with the author's contribution. |
| `trigger_source` | text; 'label' or 'review_comment' | High | Interaction that triggered this fix activity. |
| `review_comment_id` | bigint; mode: 'number' | High | External identifier linking to a reviewer's comment. |
| `review_comment_body` | text | High | Reviewer's authored comment content. |
| `file_path` | text | High | Code path referenced in this review interaction. |
| `line_number` | integer | High | Location targeted by the reviewer's comment. |
| `diff_hunk` | text | High | Authored code context attached to the review interaction. |
| `pr_head_ref` | text | High | PR branch/reference associated with that contribution. |
| `classification` | text; 'bug' or 'feature' or 'question' or 'unclear' | High | Assessment of the author's request/content. |
| `confidence` | decimal(3, 2) | High | Confidence in that content assessment. |
| `intent_summary` | text | High | Inferred intent of the author's request. |
| `related_files` | text[] | High | Paths associated with author-linked fix work. |
| `session_id` | text | High | Cloud execution identifier of the fix activity. |
| `cli_session_id` | uuid | High | Join to a user-owned CLI session. |
| `pr_number` | integer | High | External repository-scoped identifier of the resulting PR. |
| `pr_url` | text | High | External reference to generated contribution/activity. |
| `pr_branch` | text | High | Branch used for author-associated fix work. |
| `status` | text; 'pending' or 'running' or 'completed' or 'failed' or 'cancelled' | High | Outcome/state of the fix activity. |
| `error_message` | text | Medium | Diagnostic string contents remain uncertain. |
| `started_at` | timestamptz | High | Start of author-associated fix execution. |
| `completed_at` | timestamptz | High | Completion of that fix execution. |
| `created_at` | timestamptz | High | Creation time of the author's fix ticket. |
| `updated_at` | timestamptz | High | Update time of the author's fix ticket. |

## 150. user_period_cache

Source: `packages/db/src/schema.ts:7687`.
Purpose: explicitly user-keyed period summaries and sharing references; cached aggregation is not anonymization.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user's cached summary. |
| `kilo_user_id` | text | High | Identifies the summarized user. |
| `cache_type` | text | High | Kind of summary generated about the user. |
| `period_type` | text; PeriodType | High | Period granularity of the user's summary. |
| `period_key` | text | High | Time interval covered by this user's data. |
| `data` | jsonb | High | User-specific summary payload; actual member shape undeclared. |
| `computed_at` | timestamptz | High | Time the user's summary was computed. |
| `version` | integer | Other | Shared data-schema revision for cache invalidation. |
| `shared_url_token` | text | High | Sharing identifier links directly to the user's summary. |
| `shared_at` | timestamptz | High | Time sharing was enabled for the user's summary. |

## 151. free_model_usage

Source: `packages/db/src/schema.ts:7733`.
Purpose: model-use events keyed by IP and optionally user for rate limiting and usage analysis.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a network/user-associated use event. |
| `ip_address` | text | High | Network identifier of model usage. |
| `model` | text | High | Model used in this identifiable activity. |
| `kilo_user_id` | text | High | Optional explicit user identifier. |
| `created_at` | timestamptz | High | Time of network/user-associated model use. |

## 152. agent_environment_profiles

Source: `packages/db/src/schema.ts:7759`.
Purpose: reusable user/organization-owned environment profiles with creator attribution; children inherit this ownership context through `profile_id`.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Linkable identifier of a user-owned or creator-attributed profile. |
| `owned_by_organization_id` | uuid | Medium | Organization ownership alone does not establish personal ownership. |
| `owned_by_user_id` | text | High | Identifies the personal profile owner. |
| `created_by_user_id` | text | High | Explicit creator identity/action attribution. |
| `name` | text | Medium | Profile label may be personal or generic shared configuration. |
| `description` | text | Medium | Free-form profile description; personal content uncertain. |
| `is_default` | boolean | High | Default-environment preference on the user-owned branch. |
| `created_at` | timestamptz | High | Profile creation activity, including creator attribution. |
| `updated_at` | timestamptz | High | Update time of the user's profile; not necessarily the creator's action. |

## 153. agent_environment_profile_vars

Source: `packages/db/src/schema.ts:7814`.
Purpose: environment variables/secrets linked to owner-scoped profiles; plaintext/encryption behavior is described in a source comment, not verified.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a profile-linked variable record. |
| `profile_id` | uuid | High | Join to the profile's personal owner/creator context. |
| `key` | text | Medium | Variable name could be generic or contain personal identifiers. |
| `value` | text | Medium | Unconstrained plaintext/encrypted content; may hold personal credentials or shared settings. |
| `is_secret` | boolean | High | Secrecy setting selected for the user's profile variable. |
| `created_at` | timestamptz | High | Creation time of the user-owned profile variable. |
| `updated_at` | timestamptz | High | Update time of that profile variable. |

## 154. agent_environment_profile_commands

Source: `packages/db/src/schema.ts:7841`.
Purpose: ordered setup commands linked to user/organization environment profiles.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user-profile-associated setup command. |
| `profile_id` | uuid | High | Join to the profile's owner and creator context. |
| `sequence` | integer | High | User-owned execution-order preference, not merely an output ordinal. |
| `command` | text | Medium | Shell text may contain personal paths/credentials or generic shared setup. |
| `created_at` | timestamptz | High | Time setup configuration was added to the user's profile. |

## 155. agent_environment_profile_repo_bindings

Source: `packages/db/src/schema.ts:7866`.
Purpose: owner-scoped repository-to-profile associations controlling environment selection.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user's repository/profile association. |
| `repo_full_name` | text | High | Repository identity selected on the user's binding. |
| `platform` | text; enum hint: 'github' or 'gitlab' | High | Hosting-service selection for the user's repository. |
| `profile_id` | uuid | High | Selected profile, linked to owner/creator context. |
| `owned_by_organization_id` | uuid | Medium | Organization scope requires personal-relationship confirmation. |
| `owned_by_user_id` | text | High | Personal binding-owner identifier. |
| `created_at` | timestamptz | High | Time the user-owned binding was created. |

## 156. agent_environment_profile_mcp_servers

Source: `packages/db/src/schema.ts:7914`.
Purpose: MCP server selections/configuration linked to environment-profile ownership.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of the user's profile-associated MCP configuration. |
| `profile_id` | uuid | High | Join to owner/creator-attributed environment profile. |
| `name` | text | Medium | Server label may be generic, shared, or personally identifying. |
| `type` | text; enum hint: 'local' or 'remote' | High | Connection-type preference on the user's profile. |
| `enabled` | boolean | High | User-owned MCP enablement preference. |
| `timeout` | integer | High | Timeout preference selected for this user's environment. |
| `config` | jsonb | Medium | Untyped configuration may contain URLs, commands, or encrypted personal/shared credentials. |
| `created_at` | timestamptz | High | Time this user's MCP configuration was created. |
| `updated_at` | timestamptz | High | Time this user's MCP configuration was updated. |

## 157. agent_environment_profile_skills

Source: `packages/db/src/schema.ts:7953`.
Purpose: profile-attached marketplace/custom skills, associated files, and enablement state.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a skill attached to a user's profile. |
| `profile_id` | uuid | High | Join to environment-profile owner/creator context. |
| `name` | text | Medium | Skill slug may be generic/imported or personally identifying. |
| `description` | text | Medium | Shared or custom prose; actual personal contents uncertain. |
| `source_type` | text; enum hint: 'marketplace' or 'custom' | High | Skill-source selection in the user's environment. |
| `source_url` | text | Medium | Import URL may be a shared catalog entry or personal repository/resource. |
| `raw_markdown` | text | Medium | Imported/custom skill content may describe people or be generic instructions. |
| `files` | jsonb; Record<string, string> | Medium | Relative paths and file text may contain personal content; actual files uninspected. |
| `enabled` | boolean | High | Skill enablement preference on the user-owned profile. |
| `created_at` | timestamptz | High | Time the skill was attached to the user's profile. |
| `updated_at` | timestamptz | High | Skill configuration update time. |

## 158. agent_environment_profile_agents

Source: `packages/db/src/schema.ts:7995`.
Purpose: profile-attached agent definitions; local `AgentConfigSchema` supplies source evidence for otherwise untyped JSON.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user-profile-associated agent definition. |
| `profile_id` | uuid | High | Join to the profile's personal owner/creator context. |
| `slug` | text | Medium | Agent slug may be generic or personally identifying. |
| `name` | text | Medium | Display name may be shared configuration or personal text. |
| `config` | jsonb | Medium | Optional prompt/options/permissions may hold personal or shared content; writers unverified. |
| `created_at` | timestamptz | High | Time the agent definition was added to the user's profile. |
| `updated_at` | timestamptz | High | Time the user's agent definition changed. |

## 159. agent_environment_profile_kilo_commands

Source: `packages/db/src/schema.ts:8031`.
Purpose: custom slash-command definitions and preferences attached to owner-scoped profiles.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Identifier of a user-profile-associated slash command. |
| `profile_id` | uuid | High | Join to the profile's owner/creator context. |
| `name` | text | Medium | Command label may be generic or personally identifying. |
| `description` | text | Medium | Free-form/shared description may contain personal details. |
| `template` | text | Medium | Command prompt/template may be generic shared text or personal instructions. |
| `agent` | text | High | Agent selection in the user's command configuration. |
| `model` | text | High | Model preference in the user's command configuration. |
| `subtask` | boolean | High | Execution preference selected for the user's command. |
| `enabled` | boolean | High | Command-enablement preference on the user-owned profile. |
| `sort_order` | integer | High | Display-order preference for the user's configured commands. |
| `created_at` | timestamptz | High | Creation time of the user's command definition. |
| `updated_at` | timestamptz | High | Update time of the user's command definition. |

## 160. app_builder_feedback

Source: `packages/db/src/schema.ts:8066`.
Purpose: user feedback with project/session context and recent messages; nulling the user FK does not anonymize the remaining content and identifiers.

| Column | Schema type | Classification | Reason |
| --- | --- | --- | --- |
| `id` | uuid | High | Linkable identifier of a person's feedback. |
| `kilo_user_id` | text | High | Identifies the feedback author when retained. |
| `project_id` | uuid | High | Join to the user-owned/creator-attributed project. |
| `session_id` | text | High | Session identifier associated with the feedback. |
| `model` | text | High | Model in use during the user's feedback context. |
| `preview_status` | text | High | Preview state experienced by the feedback author. |
| `is_streaming` | boolean | High | Session activity state when feedback was given. |
| `message_count` | integer | High | Conversation activity volume attached to the feedback. |
| `feedback_text` | text | High | User-authored feedback, potentially also about other people. |
| `recent_messages` | jsonb; { role: string; text: string; ts: number }[] | High | Explicit conversation roles, message text, and timestamps. |
| `created_at` | timestamptz | High | Time the person submitted feedback. |

## Material follow-ups and limits

1. **Runtime content and ownership:** inspect authorized writer/validator paths before relying on the preliminary classifications. Prioritize free-form diagnostics/signatures, imported/shared profile text and files, environment values, MCP JSON/envelopes, agent options/permissions, generated remediation content, and audit snapshots. Confirm which organization-owned records describe staff/contributors or individual accounts. Do not downgrade user-owned credentials, content, or preferences merely because an equivalent organization-only value might be shared.
2. **Retention and deletion:** trace actual account-deletion and soft-deletion coverage for all 40 tables, child joins, retained identifiers, cached/shared copies, audit/history needs, and external resources. Schema FK actions are not executable evidence: legacy CLI/shared sessions and worktrees use restrictive user relationships; several session/feedback references are nullable or set null; many owner/child relationships cascade. These differences require workflow review. Verify device/token expiry, error expiry, pending-upload cleanup, and worktree deletion rather than assuming timestamps/statuses prove erasure. Review backups, replicas, exports, logs, analytics, and retention exceptions separately.
3. **Joins and external stores:** validate logical joins without FKs, including cloud/Kilo/CLI session IDs, job/execution/claim tokens, project/deployment links, and finding/attempt references. Trace legacy session blob URLs and shared snapshots, attachment object keys, worktree runtime locations/manifests, and profile materialization into runtimes. Resolve the triage Qdrant identifier and associated vector-store content. Review GitHub/GitLab PRs/issues/comments, Slack teams/channels/threads, provider BYOK accounts, and their retention/deletion contracts. An external URL, hash, or encrypted value is not an anonymization boundary.
4. **Source versus deployment:** reconcile this inventory with migrations and deployed catalogs under a separate authorized review. Source comments about encryption, redaction, cleanup, or materialization are not proof those paths execute or are complete. No application tests, lint/typecheck, writer tracing, runtime checks, or deletion verification were performed for this documentation-only audit.

## Validation

- **PASS — read-only TypeScript AST verification:** parsed `schema.ts` without executing it; selected exactly declarations #121–160. All **40 ordered table names**, **40 declaration-start source citations**, and **565 ordered physical column names/base types** matched the inventory, with zero missing, extra, duplicate, or out-of-order column rows. Every inventory has the required four-column header, a purpose, a reason per column, and exactly one allowed classification per column.
- **PASS — types and physical names:** resolved **14 `idPrimaryKeyColumn` uses** to UUID; verified **7 physical text arrays**, **4 decimal columns** (one `decimal(3, 1)`, three `decimal(3, 2)`), **2 bigint columns in number mode**, **56 `$type` annotations**, and **3 text enum hints**. All **125 timestamps** use timezone-aware string mode. Confirmed the **2 export/table-name aliases** (`cliSessions` → `cli_sessions`, `sharedCliSessions` → `shared_cli_sessions`) and **0 explicit physical column-name overrides** in scope.
- Base-type reconciliation: **275 text + 125 timestamptz + 89 uuid + 27 integer + 20 jsonb + 13 boolean + 7 text[] + 4 decimal + 3 smallint + 2 bigint = 565 columns**. JSON arrays were not counted as SQL arrays.
- **PASS — summary/count reconciliation:** all **40 table summaries** and the grand total match inventory classifications: **503 High**, **50 Medium**, **12 Other**, totaling **565**. These are confidence-category counts; the AST check verifies inventory/count consistency, not the substantive privacy judgments or runtime contents.
- **PASS — boundary:** the next declaration is #161 `cloud_agent_feedback`, `packages/db/src/schema.ts:8101`, and is not inventoried here.
- **PASS — whitespace:** `git diff --no-index --check -- /dev/null personal-data-audit-batch-04.md` reported no whitespace errors. Verification used a temporary script outside the repository and read only schema/document source; no database connection, schema import execution, application tests, lint/typecheck, or formatter was run.
