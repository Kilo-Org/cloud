import { requireOptionalNativeModule } from 'expo';
import { useFocusEffect } from 'expo-router';
import Head from 'expo-router/head';
import { type ReactNode, useCallback } from 'react';

import { buildSessionHandoff, type SessionHandoffAdvertiserProps } from './session-handoff-payload';

export type { SessionHandoffAdvertiserProps } from './session-handoff-payload';

/**
 * Android's launcher entry point, from `modules/kilo-session-handoff`. The
 * module declares `platforms: ["android"]`, so the probe returns null on iOS
 * and every call below is skipped there. That absent capability is the whole
 * platform split: one branch-free implementation serves both platforms.
 */
type KiloSessionHandoffNativeModule = {
  publishSession(url: string, title: string, anchorMessageId: string | null): void;
  clearSession(): void;
};

/**
 * Probed when a route focuses, not at import: nothing can be published before
 * then, and on iOS the lookup can never succeed, so module load does not pay
 * for it.
 */
function launcherEntryPoint(): KiloSessionHandoffNativeModule | null {
  return requireOptionalNativeModule<KiloSessionHandoffNativeModule>('KiloSessionHandoff');
}

/**
 * Advertises the session and the message on screen so another device can
 * continue it at the same position. One implementation for both platforms; the
 * mechanisms differ only where the OS does.
 *
 * iOS receives the link through `Head`, which registers the session's
 * `NSUserActivity` (what feeds Handoff and the app icon in another device's app
 * switcher) from its `<title>`/`<meta>` children and `extra.router.headOrigin`.
 * Handoff is an iOS capability: expo-router resolves an Android `Head` that
 * renders nothing and reads no origin, so the same element is inert there and
 * needs no branch here.
 *
 * Android has no proximity-handoff API, so the app publishes its own entry
 * point: one dynamic launcher shortcut for the session on screen, replaced as
 * the position changes. The native module owns the shortcut id, the intent and
 * the API 25 guard; this file owns when there is anything to publish.
 *
 * The entry point is published while the route is focused, not while it is
 * mounted. The shortcut is a single shared slot, so a covered session that
 * stays mounted must not republish over the session the user moved to when its
 * title or anchor arrives, and its cleanup must not clear that session's
 * shortcut. `Head` tracks focus itself.
 */
export function SessionHandoffAdvertiser({
  sessionId,
  anchorMessageId,
  title,
}: SessionHandoffAdvertiserProps): ReactNode {
  const { url } = buildSessionHandoff({ sessionId, anchorMessageId, title });

  useFocusEffect(
    useCallback(() => {
      const entryPoint = launcherEntryPoint();
      if (entryPoint === null) {
        return undefined;
      }

      if (url === null) {
        entryPoint.clearSession();
        return undefined;
      }

      entryPoint.publishSession(url, title, anchorMessageId ?? null);

      return () => {
        entryPoint.clearSession();
      };
    }, [url, title, anchorMessageId])
  );

  if (url === null) {
    return null;
  }

  return (
    <Head>
      <title>{title}</title>
      <meta property="og:url" content={url} />
      <meta property="og:description" content={title} />
      <meta property="expo:handoff" content="true" />
    </Head>
  );
}
