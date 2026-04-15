# Session List V2 Migration

Switch the web cloud-agent session list from the unified session endpoint to the CLI session v2 endpoint, and ensure sessions are grouped by updated time.

## Background

All session list consumers currently call `unifiedSessions.list` — a tRPC procedure in `apps/web/src/routers/unified-sessions-router.ts` that runs a `UNION ALL` across both `cli_sessions` (v1) and `cli_sessions_v2` tables.

A dedicated `cliSessionsV2.list` procedure already exists in `apps/web/src/routers/cli-sessions-v2-router.ts:229` that queries only `cli_sessions_v2`.

For grouping, the sidebar in `ChatSidebar.tsx:49` already uses `session.updatedAt`, and all consumers pass `orderBy: 'updated_at'`. The schema default in `ListSessionsInputSchema` is still `'created_at'` though, which should be cleaned up.

---

## Task 1: Switch session list to `cliSessionsV2.list`

### Consumers to update

| File                                                                   | Line | Usage                               |
| ---------------------------------------------------------------------- | ---- | ----------------------------------- |
| `apps/web/src/components/cloud-agent-next/hooks/useSidebarSessions.ts` | 89   | `unifiedSessions.list` query        |
| `apps/web/src/app/(app)/cloud/sessions/SessionsPageContent.tsx`        | 78   | `unifiedSessions.list` query        |
| `apps/web/src/components/cloud-agent/CloudSessionsPage.tsx`            | 471  | `unifiedSessions.list` query        |
| `apps/web/src/components/cloud-agent-next/CloudChatPage.tsx`           | 151  | `unifiedSessions.list` invalidation |
| `apps/web/src/components/cloud-agent-next/CloudSidebarLayout.tsx`      | 138  | `unifiedSessions.list` invalidation |
| `apps/web/src/components/cloud-agent-next/NewSessionPanel.tsx`         | 653  | `unifiedSessions.list` invalidation |

### Steps

1. **Compare input/output schemas** between `unifiedSessions.list` and `cliSessionsV2.list` — identify field name or shape differences that consumers depend on (e.g., `source` field, column mapping, cursor format).
2. **Update each query consumer** to call `cliSessionsV2.list` instead of `unifiedSessions.list`.
3. **Update each invalidation consumer** to invalidate `cliSessionsV2.list` instead of `unifiedSessions.list`.
4. **Update search** — `unifiedSessions.search` is also a `UNION ALL`. Switch search callers to a v2-only equivalent. May need to add a `search` procedure to the v2 router if one doesn't exist.
5. **Update `recentRepositories`** — currently on the unified router, also a `UNION ALL`. Either add to v2 router or migrate.
6. **Typecheck** — run `pnpm typecheck` to catch schema mismatches from the migration.
7. **Consider deprecation** — decide whether to remove or keep the unified router for backward compatibility.

---

## Task 2: Group sessions by updated time

### Current state

- `ChatSidebar.tsx:49` — `groupSessionsByDate` already groups by `session.updatedAt`. This is correct.
- All consumers already pass `orderBy: 'updated_at'` to the list query.
- The `ListSessionsInputSchema` default for `orderBy` is `'created_at'` (unified-sessions-router.ts:40).

### Steps

1. **Audit all `createdAt`/`created_at` usage** in session-related ordering or display code.
2. **Change the default `orderBy`** in `ListSessionsInputSchema` from `'created_at'` to `'updated_at'` — and similarly in the v2 router input schema if applicable.
3. **Verify** `SessionsPageContent` and other full-page session views aren't sorting by `createdAt`.
4. **Verify** the v2 router's `list` procedure supports `orderBy: 'updated_at'` and uses it correctly.
