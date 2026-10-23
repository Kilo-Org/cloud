<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

Record domain blacklist saves (added/removed domains, auto-block count) in the admin action audit log

## Problem

The admin domain blacklist (Redis key BLACKLIST_DOMAINS_REDIS_KEY) is changed only through admin.blacklistDomains.set. That mutation normalizes the list, works out which domains are new, writes the config to Redis, and since #8596 also auto-blocks existing accounts on the new domains. It never calls recordAdminAction, so adding or removing a domain leaves no row in admin_action_audit_logs. The Redis config keeps only the last writer (updated_by and updated_by_email), not a history. AdminActionAuditAction has no blacklist value, and the mutation works out added domains but never removed ones.

## Evidence

- apps/web/src/routers/admin/blacklist-domains-router.ts: `set` computes `addedDomains` from readConfigOrThrow() (it is null when that read fails), writes Redis, runs backfillBlockBlacklistedDomainsBatch, and returns `{...config, backfill}`. There is no audit call.
- packages/db/src/schema-types.ts:865-899: the AdminActionAuditAction enum has no blacklist value. The source comment says the action is stored as plain text with no check constraint, so adding a value needs no migration. AdminActionAuditTargetType is limited to 'user' | 'organization'.
- apps/web/src/lib/admin/admin-action-audit.ts: recordAdminAction(ctx, {action, target, message, metadata}) never throws, should be called only after the action succeeds, and stores metadata verbatim. Its doc says not to put customer email addresses in it.
- apps/web/src/routers/admin/email-testing-router.ts:391: an established precedent for `target: null` platform actions with metadata ('email_test.send').
- AdminActionAuditLogContent.tsx: the action filter is built from AdminActionAuditAction.options. MetadataList renders values with JSON.stringify. TargetLink shows '—' when there is no target. A new action therefore shows up with no UI change.
- The router comment says an imported blocklist can hold tens of thousands of entries, so storing full lists in metadata unbounded is risky.
- blacklist-domains-router.test.ts mocks the Redis get/set calls and uses createCallerForUser against a real test DB. There are no assertions on audit rows today. admin-platform-admins.test.ts:778 shows how to query admin_action_audit_logs in a test.

## Desired outcome

Every successful admin save of the domain blacklist that changes the list writes one admin_action_audit_logs row. The row records who made the change, the added and removed domains, and how many accounts were auto-blocked. Admins can filter for it on the existing audit log page.

## Scope

- Add the AdminActionAuditAction value 'blacklist_domains.set'.
- In admin.blacklistDomains.set, compute removedDomains next to addedDomains from the same previous-config read.
- After a successful Redis write and the auto-backfill attempt, call recordAdminAction with target null, a human-readable message, and bounded metadata.
- Add router tests for the audit row.

## Exclusions

- No database migration and no new AdminActionAuditTargetType ('domain' targets are not needed with the summary-row design).
- No audit rows for the manual backfill procedure, and none for BLACKLIST_DOMAINS env-var fallback changes (env changes are deploy-time, not admin actions).
- No per-user audit rows for accounts the backfill auto-blocks (those carry blocked_by_kilo_user_id already). Only the blocked count goes in metadata.
- No audit-log UI changes beyond what the enum produces automatically.

## Approach

- packages/db/src/schema-types.ts: append 'blacklist_domains.set' to AdminActionAuditAction (append only, no renames).
- blacklist-domains-router.ts: in the existing try block, build a normalized previous set and compute `removedDomains = [...previousDomains].filter(d => !normalizedSet.has(d))`. Keep the existing addedDomains logic. When the previous read fails, both diffs are null.
- After the backfill block, skip recording when the diff is known and both added and removed are empty (a no-op save). Otherwise call `recordAdminAction(ctx, { action: 'blacklist_domains.set', target: null, message, metadata })`. Example message: 'Updated domain blacklist: +N / -M domains', or 'Updated domain blacklist (diff unavailable)'.
- Metadata shape: { addedCount, removedCount, totalDomains, addedDomains (first 100), removedDomains (first 100), truncated: boolean, diffAvailable: boolean, autoBlockedAccounts: backfill.blocked, backfillRemaining, backfillFailed }. Cap each list at a named constant (e.g. AUDIT_DOMAIN_LIST_LIMIT = 100) so bulk imports don't create huge rows. The values are domains, not customer emails, so they are allowed by the audit-helper guidance.
- Record only after a successful Redis write. If redisClient.set fails, the existing TRPCError still throws before any audit call.
- Tests in blacklist-domains-router.test.ts, querying admin_action_audit_logs filtered by action. Cases: (a) adding domains gives one row with actor_id = admin, target_type null, the added list, and the autoBlocked count; (b) removing domains lists the removed ones; (c) a no-op save writes no row; (d) a failed Redis write writes no row; (e) a failed previous-config read writes a row with diffAvailable false; (f) more domains than the cap gives truncated lists with true counts.

## Affected areas

- packages/db/src/schema-types.ts
- apps/web/src/routers/admin/blacklist-domains-router.ts
- apps/web/src/routers/admin/blacklist-domains-router.test.ts

## Acceptance criteria

### ac-1: A successful admin.blacklistDomains.set call that adds and/or removes domains inserts exactly one admin_action_audit_logs row. The row has action 'blacklist_domains.set', the calling admin's actor_id/actor_email, null target_type/target_id, and metadata with the correct addedCount, removedCount, totalDomains, added and removed domain lists (normalized to lowercase), and autoBlockedAccounts equal to the backfill's blocked count. A router test proves this for both an add and a remove scenario.

**Verification:** Code review

### ac-2: No audit row is written when the Redis write fails (the mutation still throws INTERNAL_SERVER_ERROR) or when the save does not change the domain list. Router tests cover both cases.

**Verification:** Code review

### ac-3: When the previous config cannot be read, the save still succeeds and records a row with diffAvailable false. When added or removed domains exceed the metadata cap, the stored lists are truncated to the cap while the counts reflect the true totals and truncated is true. Router tests cover both cases.

**Verification:** Code review

### ac-4: The new action is added only by appending to AdminActionAuditAction. No existing values are renamed, there is no schema migration, and AdminActionAuditTargetType is unchanged. The action therefore appears in the /admin action-audit-log action filter, and its rows render with '—' as the target and their metadata visible.

**Verification:** Source review

## Risks

- Large imports: unbounded domain lists could make audit rows and log lines huge. The fixed cap and counts address this.
- Audit-write failure does not fail the save (recordAdminAction swallows errors and reports to Sentry). This is the intended convention.
- Concurrent saves: the diff is computed against a read taken before the write, so two simultaneous saves may each record diffs relative to a stale base. This is the same race the existing backfill logic already accepts.

## Assumptions

- One summary row per save is acceptable instead of one row per domain. The issue only asks that adds and removes be tracked, and the platform-action precedent (email_test.send, null target plus metadata) supports it.
- The admin set mutation is the only path that needs auditing; it is the sole writer of the Redis key.
- The action name 'blacklist_domains.set' follows the existing '<area>.<verb>' naming.

## Decisions

### d-1: Audit granularity: one summary row per save, or one row per added/removed domain?

**Answer:** One summary row per save with capped added/removed lists and counts in metadata. This avoids thousands of rows for bulk imports and matches the null-target platform-action pattern.

**Blocking:** no

### d-2: Should other paths (manual backfill, env-var fallback) also be audited?

**Answer:** No. Only admin.blacklistDomains.set is in scope. The env fallback is deploy-time configuration, and the manual backfill does not change the list.

**Blocking:** no

### d-3: Should no-op saves (no list change) be recorded?

**Answer:** No. Saves with no change are skipped when the diff is known. When the diff is unavailable, a row is recorded with diffAvailable false so changes are not silently lost.

**Blocking:** no
