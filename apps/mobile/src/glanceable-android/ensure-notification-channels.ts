import type * as NotificationsModule from '@/lib/notifications';

/**
 * Create the Android channels before the first post, lazily. `@/lib/notifications`
 * pulls the native notifications graph (expo-notifications → expo-constants),
 * and the widget / Live-Update headless entry must not load it at import time.
 * The reverse direction already lazy-requires the platform sink registrations
 * (see `ensureGlanceableSinksLoaded`), so this keeps one rule.
 *
 * The dynamic import is memoized so concurrent starts share one load, matching
 * the drafts / encrypted-kv pattern.
 */
let notificationsModule: Promise<typeof NotificationsModule> | null = null;

export async function ensureAndroidNotificationChannels(): Promise<void> {
  notificationsModule ??= import('@/lib/notifications');
  const { ensureAndroidNotificationChannels: ensureChannels } = await notificationsModule;
  await ensureChannels();
}
