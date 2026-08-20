import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { EXTENSION_SIGNED_IN_EVENT, captureEvent, initAnalytics } from '@/src/shared/analytics';
import type { AnalyticsStorageArea } from '@/src/shared/analytics';

export interface ObservedAuthState {
  readonly email: string | undefined;
  readonly status: string | undefined;
}

export type SignInSource = 'device_auth' | 'stored_session';

/**
 * Returns `'identify'` when `next` is a newly observed signed-in session with a
 * non-empty email that differs from a still-signed-in previous observation.
 */
export const resolveSignedInTransition = (
  previous: ObservedAuthState | undefined,
  next: ObservedAuthState
): 'identify' | null => {
  if (next.status !== 'signedIn') {
    return null;
  }

  if (next.email === undefined || next.email.length === 0) {
    return null;
  }

  if (previous?.status === 'signedIn' && previous.email === next.email) {
    return null;
  }

  return 'identify';
};

interface AnalyticsIdentityTrackerOptions {
  readonly emitSignedIn: (source: SignInSource) => void;
  readonly storageArea: AnalyticsStorageArea;
}

interface AnalyticsIdentityTracker {
  observe(next: ObservedAuthState, signInSource: SignInSource): Promise<void>;
}

export const createAnalyticsIdentityTracker = ({
  emitSignedIn,
  storageArea,
}: AnalyticsIdentityTrackerOptions): AnalyticsIdentityTracker => {
  // eslint-disable-next-line unicorn/no-useless-undefined -- explicit unset sentinel
  let previous: ObservedAuthState | undefined = undefined;

  return {
    observe: async (next, signInSource): Promise<void> => {
      const decision = resolveSignedInTransition(previous, next);
      /*
       * Advance synchronously on EVERY observation (including signed-out and
       * undefined status) before any await so overlapping runs dedupe and
       * re-sign-in after sign-out re-identifies.
       */
      previous = next;

      if (decision !== 'identify' || next.email === undefined || next.email.length === 0) {
        return;
      }

      const activated = await initAnalytics(storageArea, next.email);

      if (activated) {
        emitSignedIn(signInSource);
      }
    },
  };
};

interface UseAnalyticsIdentityOptions {
  readonly email: string | undefined;
  readonly signInSource: RefObject<SignInSource>;
  readonly status: string | undefined;
  readonly storageArea: AnalyticsStorageArea;
}

/**
 * Observes auth status/email transitions and identifies the analytics user on
 * each transition into a signed-in-with-email session. Never drives rendering.
 */
export const useAnalyticsIdentity = ({
  email,
  signInSource,
  status,
  storageArea,
}: UseAnalyticsIdentityOptions): void => {
  const trackerRef = useRef<AnalyticsIdentityTracker | null>(null);

  trackerRef.current ??= createAnalyticsIdentityTracker({
    emitSignedIn: source => {
      captureEvent(EXTENSION_SIGNED_IN_EVENT, { source });
    },
    storageArea,
  });

  useEffect(() => {
    void trackerRef.current?.observe({ email, status }, signInSource.current);
  }, [email, signInSource, status]);
};
