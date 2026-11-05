import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';

import { setNativeVisibleSession } from '@/lib/app-actions/native-bridge';
import { captureTelemetry } from '@/lib/telemetry/error-sink';

/**
 * Publishes the session this screen shows as the app's on-screen entity, so
 * Siri and Apple Intelligence can resolve "this session" to it.
 *
 * It renders nothing. The cue is cleared on blur and on unmount, because a
 * session that is no longer visible must not stay the entity the system offers:
 * the person may be on the Agents list, and a run asked for "this session" then
 * has no right answer.
 *
 * A failed publish is reported and never surfaces: it costs the on-screen cue
 * only, the screen keeps working, and the next focus retries.
 */
export function VisibleSessionPublisher({
  sessionId,
}: Readonly<{ sessionId: KiloSessionId }>): null {
  useFocusEffect(
    useCallback(() => {
      const publish = async () => {
        try {
          await setNativeVisibleSession(sessionId);
        } catch (error: unknown) {
          captureTelemetry({
            error,
            level: 'warning',
            tags: { 'error.subsystem': 'app-intent-catalog', 'error.operation': 'visible-session' },
          });
        }
      };
      void publish();
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
    }, [sessionId])
  );
  return null;
}
