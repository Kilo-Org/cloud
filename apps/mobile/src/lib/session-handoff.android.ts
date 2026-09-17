import { requireOptionalNativeModule } from 'expo';
import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';

import { buildSessionHandoff, type SessionHandoffAdvertiserProps } from './session-handoff-payload';

type KiloSessionHandoffNativeModule = {
  publishSession(url: string, title: string, anchorMessageId: string | null): void;
  clearSession(): void;
};

/**
 * The module is Android-only, so the optional lookup returns null on any other
 * platform and every call below is a no-op.
 */
const nativeModule =
  requireOptionalNativeModule<KiloSessionHandoffNativeModule>('KiloSessionHandoff');

/**
 * Android has no proximity-handoff API, so the app publishes its own entry
 * point: one dynamic launcher shortcut for the session on screen, replaced as
 * the position changes. The native module owns the shortcut id, the intent and
 * the API 25 guard; this file owns when there is anything to publish.
 *
 * The entry is published while the route is focused, not while it is mounted.
 * The shortcut is a single shared slot, so a covered session that stays mounted
 * must not republish over the session the user moved to when its title or
 * anchor arrives, and its cleanup must not clear that session's shortcut. iOS
 * re-registers its `NSUserActivity` when focus returns; publishing on focus and
 * clearing on blur keeps the launcher entry naming the same session.
 */
export function SessionHandoffAdvertiser({
  sessionId,
  anchorMessageId,
  title,
}: SessionHandoffAdvertiserProps): null {
  useFocusEffect(
    useCallback(() => {
      if (nativeModule === null) {
        return undefined;
      }

      const { url } = buildSessionHandoff({ sessionId, anchorMessageId, title });

      if (url === null) {
        nativeModule.clearSession();
        return undefined;
      }

      nativeModule.publishSession(url, title, anchorMessageId ?? null);

      return () => {
        nativeModule.clearSession();
      };
    }, [sessionId, anchorMessageId, title])
  );

  return null;
}
