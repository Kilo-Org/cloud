import { type Href, useRouter, useSegments } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import {
  clearPickerRestoreRecord,
  readPickerRestoreRecord,
} from '@/lib/agent-attachments/picker-launch-context';
import {
  isAppLandingSegments,
  resolvePickerLaunchRestorePath,
} from '@/lib/agent-attachments/picker-launch-restore';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';

/**
 * Invisible mount: when the app starts on its opening route with a camera or
 * library launch that never came back to its composer, reopen that composer -
 * the new-session form with its durable draft, or the session it belongs to.
 * The composer's own Android picker recovery then attaches a picked image the
 * same way it does after a normal launch.
 *
 * Runs once per app start, after the account is known, and only from the
 * opening route: any other start route is a deep link or a deliberate
 * navigation, where the person already is where they asked to be.
 */
export function PickerLaunchRestoreMount(): null {
  const router = useRouter();
  const segments = useSegments();
  const { userId } = useCurrentUserId();
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  // One decision per app start. A record written after this point belongs to a
  // launch this process made itself, whose own composer owns it.
  const decidedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let subscription: { remove: () => void } | null = null;

    const deliver = (path: Href) => {
      subscription?.remove();
      subscription = null;
      if (cancelled || decidedRef.current) {
        return;
      }
      decidedRef.current = true;
      if (!isAppLandingSegments(segmentsRef.current)) {
        return;
      }
      // The start may already hold the transient copy of the composer the
      // Activity rebuilt before the router settled on its opening route, so
      // navigate rather than stacking a second one.
      router.navigate(path);
    };

    const decide = async () => {
      const record = await readPickerRestoreRecord();
      try {
        // One decision per start, whatever it is: a clear that fails leaves a
        // record the TTL retires, and it must not fail the start.
        await clearPickerRestoreRecord();
      } catch {
        // Best effort.
      }
      const path = resolvePickerLaunchRestorePath({
        context: record,
        userId,
        now: Date.now(),
        atLandingRoute: isAppLandingSegments(segmentsRef.current),
      });
      if (path === null) {
        decidedRef.current = true;
        return;
      }
      // Right after an Activity rebuild the picker is still in front and the
      // app is backgrounded; a selection only exists once it returns. Reopen on
      // the way back to `active` so the composer's recovery reads that result
      // exactly as it does after a normal launch.
      if (AppState.currentState === 'active') {
        deliver(path);
        return;
      }
      subscription = AppState.addEventListener('change', nextState => {
        if (nextState === 'active') {
          deliver(path);
        }
      });
    };

    if (!decidedRef.current && userId !== undefined) {
      void decide();
    }

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [router, userId]);

  return null;
}
