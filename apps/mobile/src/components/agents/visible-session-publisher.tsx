import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';

import { setNativeVisibleSession } from '@/lib/app-actions/native-bridge';
import { useAppUnlock } from '@/lib/app-unlock-context';
import { captureTelemetry } from '@/lib/telemetry/error-sink';

/**
 * Publishes the session this screen shows as the app's on-screen entity, so
 * Siri and Apple Intelligence can resolve "this session" to it.
 *
 * It renders nothing. The cue exists only while the app is known to be
 * unlocked and the screen is focused: the lock surface keeps this tree mounted
 * behind it, so a lock must clear the cue rather than leave the system offering
 * a session the person cannot see. It is cleared on blur and on unmount for the
 * same reason — the person may be on the Agents list, and a run asked for "this
 * session" then has no right answer.
 *
 * A failed publish is reported and never surfaces: it costs the on-screen cue
 * only, the screen keeps working, and the next focus retries.
 */
export function VisibleSessionPublisher({
  sessionId,
}: Readonly<{ sessionId: KiloSessionId }>): null {
  const unlocked = useAppUnlock().status === 'unlocked';

  useFocusEffect(
    useCallback(() => {
      if (unlocked) {
        const publish = async () => {
          try {
            await setNativeVisibleSession(sessionId);
          } catch (error: unknown) {
            captureTelemetry({
              error,
              level: 'warning',
              tags: {
                'error.subsystem': 'app-intent-catalog',
                'error.operation': 'visible-session',
              },
            });
          }
        };
        void publish();
      }
      return () => {
        const clear = async () => {
          try {
            await setNativeVisibleSession(null);
          } catch {
            // A failed clear leaves the previous cue in place, which the next
            // focus or the catalog clear replaces; nothing to report twice.
          }
        };
        void clear();
      };
    }, [sessionId, unlocked])
  );
  return null;
}
