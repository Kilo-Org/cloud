<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

Record domain blacklist additions and removals in the admin action audit log

## Problem

The admin domain blacklist (Redis key BLACKLIST_DOMAINS_REDIS_KEY) is changed only through admin.blacklistDomains.set. That mutation normalizes the list, works out which domains are new, writes the config to Redis, and since #8596 also auto-blocks existing accounts on the new domains. It never calls recordAdminAction, so adding or removing a domain leaves no row in admin_action_audit_logs. The Redis config keeps only the last writer (updated_by and updated_by_email), not a history. AdminActionAuditAction has no blacklist value, and the mutation works out added domains but never removed ones.

## Evidence

- apps/web/src/routers/admin/blacklist-domains-router.ts: `set` computes `addedDomains` from readConfigOrThrow() (it is null when that read fails), writes Redis, runs backfillBlockBlacklistedDomainsBatch, and returns `{...config, backfill}`. There is no audit call.
- packages/db/src/schema-types.ts:865-899: the AdminActionAuditAction enum has no blacklist value. The source comment says the action is stored as plain text with no check constraint, so adding a value needs no migration. AdminActionAuditTargetType is limited to 'user' | 'organization'.
- apps/web/src/lib/admin/admin-action-audit.ts: recordAdminAction(ctx, {action, target, message, metadata}) never throws, should be called only after the action succeeds, and stores metadata verbatim. Its doc says not to put customer email addresses in it.
- apps/web/src/routers/admin/email-testing-router.ts:391: an established precedent for `target: null` platform actions with metadata ('email_test.send').
- AdminActionAuditLogContent.tsx: the action filter is built from AdminActionAuditAction.options. MetadataList renders values with JSON.stringify. TargetLink shows '—' when there is no target. A new action therefore shows up with no UI change.
- The router comment says an imported blocklist can hold tens of thousands of entries, so the audit row must not try to list every domain in a bulk change.
- blacklist-domains-router.test.ts mocks the Redis get/set calls and uses createCallerForUser against a real test DB. There are no assertions on audit rows today. admin-platform-admins.test.ts:778 shows how to query admin_action_audit_logs in a test.
- Operator feedback on revision 1: do not record how many accounts were blocked, and when more than 2 domains were added, just say "x domains added" instead of listing them.

## Desired outcome

Every successful admin save of the domain blacklist that changes the list writes one admin_action_audit_logs row recording who made the change and what changed. Up to 2 added or removed domains are named. More than 2 are summarized as a count ("x domains added" / "x domains removed"). Admins can filter for the row on the existing audit log page.

## Scope

- Add the AdminActionAuditAction value 'blacklist_domains.set'.
- In admin.blacklistDomains.set, compute removedDomains next to addedDomains from the same previous-config read.
- After a successful Redis write, call recordAdminAction with target null, a concise message, and small metadata. Domains are named only when there are at most 2 per direction; otherwise only a count is given.
- Add router tests for the audit row.

## Exclusions

- No database migration and no new AdminActionAuditTargetType ('domain' targets are not needed with the summary-row design).
- No audit rows for the manual backfill procedure, and none for BLACKLIST_DOMAINS env-var fallback changes (env changes are deploy-time, not admin actions).
- No count of auto-blocked accounts and no backfill details in the audit row (operator request). No per-user audit rows for accounts the backfill auto-blocks.
- No audit-log UI changes beyond what the enum produces automatically.

## Approach

- packages/db/src/schema-types.ts: append 'blacklist_domains.set' to AdminActionAuditAction (append only, no renames).
- blacklist-domains-router.ts: in the existing try block, build a normalized previous set and compute `removedDomains = [...previousDomains].filter(d => !normalizedSet.has(d))`. Keep the existing addedDomains logic. When the previous read fails, both diffs are null.
- Add a small helper, e.g. `describeDomainChange(domains, verb)` with a constant `AUDIT_DOMAIN_NAME_LIMIT = 2`. It returns the domain names when `domains.length <= 2` (e.g. 'Added a.com, b.com') and a count otherwise (e.g. '5 domains added'). Join the added and removed parts into the message, e.g. 'Domain blacklist: added a.com; 7 domains removed'. When the diff is unavailable, use 'Domain blacklist updated (change details unavailable)'.
- Metadata: { addedCount, removedCount, totalDomains, diffAvailable }. Include `addedDomains` only when addedCount <= 2 and `removedDomains` only when removedCount <= 2. No backfill or blocked-account fields.
- Record after the successful Redis write, skipping when the diff is known and both added and removed are empty (a no-op save). A failed redisClient.set still throws its TRPCError before any audit call. The audit call does not depend on the backfill outcome.
- Tests in blacklist-domains-router.test.ts, querying admin_action_audit_logs filtered by action. Cases: (a) adding 1-2 domains gives one row naming them, with actor_id = admin and target_type null; (b) adding more than 2 gives a message with 'N domains added' and no addedDomains list in metadata; (c) removals follow the same rule; (d) the row contains no blocked-account or backfill fields; (e) a no-op save writes no row; (f) a failed Redis write writes no row; (g) a failed previous-config read writes a row with diffAvailable false.

## Affected areas

- packages/db/src/schema-types.ts
- apps/web/src/routers/admin/blacklist-domains-router.ts
- apps/web/src/routers/admin/blacklist-domains-router.test.ts

## Acceptance criteria

### ac-5: A successful admin.blacklistDomains.set call that adds and/or removes domains inserts exactly one admin_action_audit_logs row. The row has action 'blacklist_domains.set', the calling admin's actor_id/actor_email, null target_type/target_id, and metadata with correct addedCount, removedCount, totalDomains and diffAvailable. Its message and metadata contain no count of blocked accounts and no backfill details. A router test proves this for both an add and a remove scenario.

**Verification:** Code review

### ac-2: No audit row is written when the Redis write fails (the mutation still throws INTERNAL_SERVER_ERROR) or when the save does not change the domain list. Router tests cover both cases.

**Verification:** Code review

### ac-6: When 1 or 2 domains are added (or removed), the message and metadata name them, normalized to lowercase. When more than 2 are added (or removed), the message says '<N> domains added' (or '<N> domains removed'), and metadata has the count but no domain list for that direction. When the previous config cannot be read, the save still succeeds and records a row with diffAvailable false. Router tests cover each case.

**Verification:** Code review

### ac-4: The new action is added only by appending to AdminActionAuditAction. No existing values are renamed, there is no schema migration, and AdminActionAuditTargetType is unchanged. The action therefore appears in the /admin action-audit-log action filter, and its rows render with '—' as the target and their metadata visible.

**Verification:** Source review

## Risks

- For changes of more than 2 domains, the audit log does not say which domains changed; forensics for bulk edits rely on the current list in Redis. The operator accepted this to keep entries concise.
- Audit-write failure does not fail the save (recordAdminAction swallows errors and reports to Sentry). This is the intended convention.
- Concurrent saves: the diff is computed against a read taken before the write, so two simultaneous saves may each record diffs relative to a stale base. This is the same race the existing backfill logic already accepts.

## Assumptions

- One summary row per save is acceptable instead of one row per domain. The issue only asks that adds and removes be tracked, and the platform-action precedent (email_test.send, null target plus metadata) supports it.
- The admin set mutation is the only path that needs auditing; it is the sole writer of the Redis key.
- The action name 'blacklist_domains.set' follows the existing '<area>.<verb>' naming.
- The operator's "more than 2 domains" rule for additions also applies to removals, for consistency.

## Decisions

### d-1: Audit granularity: one summary row per save, or one row per added/removed domain?

**Answer:** One summary row per save. It names up to 2 added or removed domains and gives only a count ('x domains added/removed') above that, per operator feedback.

**Blocking:** no

### d-2: Should other paths (manual backfill, env-var fallback) also be audited?

**Answer:** No. Only admin.blacklistDomains.set is in scope. The env fallback is deploy-time configuration, and the manual backfill does not change the list.

**Blocking:** no

### d-3: Should no-op saves (no list change) be recorded?

**Answer:** No. Saves with no change are skipped when the diff is known. When the diff is unavailable, a row is recorded with diffAvailable false so changes are not silently lost.

**Blocking:** no

### d-4: Should the audit row record how many existing accounts the save auto-blocked?

**Answer:** No. Per operator feedback, the row has no blocked-account count or backfill details.

**Blocking:** no
