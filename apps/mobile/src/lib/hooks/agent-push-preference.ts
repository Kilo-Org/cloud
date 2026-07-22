import { type QueryClient } from '@tanstack/react-query';

/**
 * Pure logic for the per-user notification-preference settings (S3 — the
 * dedicated Notifications screen with 5 category toggles + master gate).
 *
 * The preferences are per-user, cross-device, and server-resolved: a successful
 * query with no row means every category is enabled (default ON). The same row
 * also exposes a `agentUpdates` value that mirrors the legacy `agentPushEnabled`
 * column, so this module accepts any one of the six keys when applying a
 * per-category optimistic flip.
 */
export const DEFAULT_NOTIFICATION_PREFERENCE = true as const;

/** tRPC keys for the per-category toggles on the dedicated Notifications screen. */
export const NOTIFICATION_CATEGORY_KEYS = [
  'chatMessages',
  'agentAttention',
  'agentUpdates',
  'sessionStatus',
  'kiloclawActivity',
] as const;

export type NotificationCategoryKey = (typeof NOTIFICATION_CATEGORY_KEYS)[number];

/** Full shape of a single row in the tRPC cache for `getNotificationPreferences`. */
export type NotificationPreferences = Readonly<{
  chatMessages: boolean;
  agentAttention: boolean;
  agentUpdates: boolean;
  sessionStatus: boolean;
  kiloclawActivity: boolean;
  agentPushEnabled: boolean;
}>;

/** What the cache may hold — either the typed full row or the legacy `agentPushEnabled` snapshot. */
type NotificationPreferencesSnapshot =
  | NotificationPreferences
  | Readonly<{ agentPushEnabled: boolean }>
  | undefined;

type EditableArgs = Readonly<{ hasData: boolean; isPending: boolean }>;

/** A snapshot is the legacy 1-key shape only when it carries `agentPushEnabled`
 *  without any of the new per-category keys. */
function isLegacySnapshot(
  snapshot: NotificationPreferencesSnapshot
): snapshot is Readonly<{ agentPushEnabled: boolean }> {
  return (
    snapshot != null &&
    'agentPushEnabled' in snapshot &&
    !NOTIFICATION_CATEGORY_KEYS.some(key => key in snapshot)
  );
}

/** Can the user flip the switch from the rendered row right now? */
export function deriveAgentPushEditable(args: EditableArgs): boolean {
  return args.hasData && !args.isPending;
}

/** Can the dedicated screen show the master "Enable notifications" CTA? */
export function deriveShowEnableCta(notificationsEnabled: boolean): boolean {
  return !notificationsEnabled;
}

/** Map the legacy single-key cache shape to the new per-category shape. */
function readFromSnapshot(snapshot: NotificationPreferencesSnapshot): NotificationPreferences {
  if (!snapshot) {
    return {
      chatMessages: DEFAULT_NOTIFICATION_PREFERENCE,
      agentAttention: DEFAULT_NOTIFICATION_PREFERENCE,
      agentUpdates: DEFAULT_NOTIFICATION_PREFERENCE,
      sessionStatus: DEFAULT_NOTIFICATION_PREFERENCE,
      kiloclawActivity: DEFAULT_NOTIFICATION_PREFERENCE,
      agentPushEnabled: DEFAULT_NOTIFICATION_PREFERENCE,
    };
  }
  if (isLegacySnapshot(snapshot)) {
    return {
      chatMessages: DEFAULT_NOTIFICATION_PREFERENCE,
      agentAttention: DEFAULT_NOTIFICATION_PREFERENCE,
      agentUpdates: snapshot.agentPushEnabled,
      sessionStatus: DEFAULT_NOTIFICATION_PREFERENCE,
      kiloclawActivity: DEFAULT_NOTIFICATION_PREFERENCE,
      agentPushEnabled: snapshot.agentPushEnabled,
    };
  }
  return snapshot;
}

/**
 * Read a single category's optimistic value from cache. Falls back to the
 * default-ON semantics (no row ⇒ enabled) when the cache is empty or only
 * holds the legacy `agentPushEnabled` snapshot.
 */
export function readAgentPushPreference(
  queryClient: Pick<QueryClient, 'getQueryData'>,
  queryKey: readonly unknown[],
  category: NotificationCategoryKey = 'agentUpdates'
): boolean {
  const snapshot = queryClient.getQueryData(queryKey) as NotificationPreferencesSnapshot;
  return readFromSnapshot(snapshot)[category];
}

type OptimisticArgs = Readonly<{
  queryClient: Pick<QueryClient, 'cancelQueries' | 'getQueryData' | 'setQueryData'>;
  queryKey: readonly unknown[];
  next: boolean;
  category: NotificationCategoryKey;
}>;

type OptimisticContext = Readonly<{
  previous: NotificationPreferencesSnapshot;
  // When the legacy single-key snapshot was the cache value, also remember
  // whether we materialized it into the full per-category shape so the
  // rollback can restore the original shape.
  previousWasLegacy: boolean;
}>;

/**
 * Apply the optimistic flip for a single category. Returns the previous
 * snapshot for rollback and a flag indicating whether the cache held the
 * legacy `agentPushEnabled`-only shape (so the rollback can restore it
 * verbatim instead of leaving the new per-category shape behind).
 */
export async function applyAgentPushOptimistic(args: OptimisticArgs): Promise<OptimisticContext> {
  await args.queryClient.cancelQueries({ queryKey: args.queryKey });
  const rawPrevious = args.queryClient.getQueryData(
    args.queryKey
  ) as NotificationPreferencesSnapshot;
  if (rawPrevious === undefined) {
    // Empty cache: seed the full row with the flipped value so the optimistic
    // read is consistent across categories. The next refetch will replace it.
    const seeded: NotificationPreferences = {
      chatMessages: DEFAULT_NOTIFICATION_PREFERENCE,
      agentAttention: DEFAULT_NOTIFICATION_PREFERENCE,
      agentUpdates: DEFAULT_NOTIFICATION_PREFERENCE,
      sessionStatus: DEFAULT_NOTIFICATION_PREFERENCE,
      kiloclawActivity: DEFAULT_NOTIFICATION_PREFERENCE,
      agentPushEnabled: DEFAULT_NOTIFICATION_PREFERENCE,
    };
    args.queryClient.setQueryData(args.queryKey, {
      ...seeded,
      [args.category]: args.next,
    });
    return { previous: undefined, previousWasLegacy: false };
  }
  if (isLegacySnapshot(rawPrevious)) {
    // Promote the legacy snapshot into the new per-category shape (sharing the
    // `agentPushEnabled` value) before flipping the requested category.
    const promoted = readFromSnapshot(rawPrevious);
    args.queryClient.setQueryData(args.queryKey, {
      ...promoted,
      [args.category]: args.next,
    });
    return { previous: rawPrevious, previousWasLegacy: true };
  }
  const previous = rawPrevious as NotificationPreferences;
  args.queryClient.setQueryData(args.queryKey, {
    ...previous,
    [args.category]: args.next,
  });
  return { previous: rawPrevious, previousWasLegacy: false };
}

type RollbackArgs = Readonly<{
  queryClient: Pick<QueryClient, 'setQueryData' | 'removeQueries'>;
  queryKey: readonly unknown[];
  context: OptimisticContext | undefined;
}>;

/**
 * Restore the previous snapshot. When there was no previous cache entry,
 * remove the optimistic entry so the next read falls back to the default-ON
 * semantics (no row ⇒ enabled) instead of leaving the optimistic value in
 * place. When the previous cache held the legacy `agentPushEnabled`-only
 * shape, restore that exact shape (drop the promoted per-category fields).
 *
 * If `context` itself is undefined (e.g. the caller never set a pending
 * category, so onMutate short-circuited), this is a defensive no-op rather
 * than an unconditional `removeQueries` — we must not destroy an existing
 * valid cache entry just because rollback was invoked without a context.
 */
export function rollbackAgentPushOptimistic(args: RollbackArgs): void {
  if (!args.context) {
    return;
  }
  if (args.context.previous) {
    if (args.context.previousWasLegacy) {
      // Restore the exact legacy shape by overwriting the cache with only the
      // original legacy fields. The next refetch will repopulate the new
      // per-category shape.
      args.queryClient.setQueryData(args.queryKey, args.context.previous);
      return;
    }
    args.queryClient.setQueryData(args.queryKey, args.context.previous);
    return;
  }
  args.queryClient.removeQueries({ queryKey: args.queryKey });
}
