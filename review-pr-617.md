# Review: PR #617 — Unify platform integration routers and remove Context/Provider abstraction

Overall: solid structural cleanup, -1501 lines, good DRY improvement. A few things worth checking before merge.

---

## 🔴 High Priority

### 1. Cache invalidation may silently fail (all detail components)

In `DiscordIntegrationDetails`, `GitHubIntegrationDetails`, etc., mutations invalidate the query cache like:

```ts
const input = organizationId ? { organizationId } : undefined;
// ...
void queryClient.invalidateQueries({
  queryKey: trpc.discord.getInstallation.queryKey(input),
});
```

When `organizationId` is absent, `input` is `undefined`. The cache key for `queryOptions(undefined)` may differ from `queryOptions()` (no arg). If they generate different keys, the invalidation after uninstall/disconnect won't trigger a refetch and the UI will show stale state. **Test this in the user (non-org) flow for each platform.**

Same risk in `GitHubIntegrationDetails` for the `listIntegrations` invalidation, which feeds `NewDeploymentDialog`.

### 2. Dead code with misleading comment in `discord-router.ts` `getOAuthUrl`

```ts
if (input?.organizationId) {
  // Access check is not strictly needed for reading an OAuth URL,
  // but we keep it consistent with the org pattern
}
```

This `if` block does nothing. The comment says a check is kept "for consistency" but there is no check. Either add `await ensureOrganizationAccess(ctx, input.organizationId)` or remove the block. As-is, any authenticated user can request an OAuth URL for an arbitrary `organizationId` they don't belong to (low severity since the callback does the real check, but still wrong).

### 3. `resolveOwner` has no authorization — callers must not forget

`resolveOwner` in `resolve-owner.ts` just constructs an `Owner` from the input without checking anything. Every callsite currently calls `ensureIntegrationAccess` first, so no current bug. But there's no structural enforcement — a future addition could call `resolveOwner` and forget the access check. Worth a comment or a combined helper like `resolveAuthorizedOwner(ctx, input)` that always does both.

---

## 🟡 Medium Priority

### 4. `checkUserPendingInstallation` accepts `organizationId` but ignores it

```ts
// github-apps-router.ts
checkUserPendingInstallation: baseProcedure
  .input(optionalOrgInput)
  .query(async ({ ctx, input }) => {
    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
    }
    // organizationId never used — always queries ctx.user.id
    const pendingInstallation = await githubAppsService.checkUserPendingInstallation(ctx.user.id);
```

The org membership is validated but then discarded. The check is harmless but confusing. Clarify with a comment that this is intentionally user-scoped regardless of org context, or drop `organizationId` from the input entirely.

### 5. `optionalOrgInput` is copy-pasted into all 4 routers

```ts
const optionalOrgInput = z.object({ organizationId: z.string().uuid().optional() }).optional();
```

This identical definition appears in `discord-router.ts`, `github-apps-router.ts`, `gitlab-router.ts`, and `slack-router.ts`. Should be exported from `resolve-owner.ts` (or a shared schema file) to avoid drift.

### 6. Inconsistent mutation input pattern in `SlackIntegrationDetails` and `GitLabIntegrationDetails`

Most mutations use the `input` variable pattern:

```ts
const input = organizationId ? { organizationId } : undefined;
uninstallApp.mutate(input, ...);
```

But `updateModel` (Slack) and `refreshRepositories` (GitLab) pass `organizationId` inline:

```ts
updateModel.mutate({ modelSlug, organizationId }, ...);
```

Functionally fine (zod accepts `undefined` values), but inconsistent within the same component.

### 7. `PLATFORM.GITLAB` replaced with string literal `'gitlab'`

In `platform-definitions.ts`, `id: PLATFORM.GITLAB` was replaced with `id: 'gitlab'`. Breaks single source of truth for platform IDs. Low risk in practice but worth keeping consistent.

### 8. `organizationId ?? undefined` is a no-op

In `NewDeploymentDialog.tsx`:

```ts
const orgId = organizationId ?? undefined;
```

`organizationId` is already `string | undefined`, so `?? undefined` does nothing. Minor cleanup.

---

## ✅ Things that look good

- **`ensureIntegrationAccess` defaults to `['owner', 'billing_manager']`** — matches the old `organizationOwnerProcedure` behavior exactly.
- **`resolveOwner` user-scope** — always returns `ctx.user.id`, no IDOR possible from the user path.
- **`getInstallation` in GitLab now checks org membership** — the old `getIntegration` had no access check for the org case. This is a security improvement.
- **`buildPlatforms` data-driven `getStatus`** — clean replacement for the old if-else chain.
- **`IntegrationsHub`** — correctly handles personal vs. org routing via `buildPlatforms(installations, organizationId)`.
- **Deprecated wrappers preserved** — `buildPlatformsForPersonal` / `buildPlatformsForOrg` kept with `@deprecated` JSDoc, avoiding a big-bang break.

---

## Where to pay attention during manual review

1. **User-scope OAuth flows (Slack + Discord connect/disconnect)** — exercise the full flow without an `organizationId`. Verify that after connecting/disconnecting the integration card updates immediately (tests the cache invalidation concern in point 1).
2. **`NewDeploymentDialog` in user context** — after the GitHub Apps context provider was removed, verify the GitHub repo picker still loads and refreshes correctly.
3. **`discord-router.ts` `getOAuthUrl`** — check if any code path relies on the org membership check that was accidentally left as dead code (point 2).
4. **`SecurityAgentPageClient.tsx`** — verify the GitHub permissions refresh button still works in both personal and org contexts after the two-mutation → one-mutation consolidation.
5. **GitLab PAT connect in org context** — this used `disconnectOrg` in the old router; make sure the unified `disconnect` endpoint picks up the org case correctly and that the audit log is still created.
