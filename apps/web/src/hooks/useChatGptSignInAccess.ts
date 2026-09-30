'use client';

import { useEffect, useState } from 'react';
import { usePostHog } from 'posthog-js/react';
import { CHATGPT_ACCESS_FLAG } from '@/lib/auth/openai/access';

/**
 * Feature-flag access for the "Sign in with ChatGPT" sign-in option.
 *
 * The flag's release condition matches the approved email domains against the
 * `email` person property. A signed-out visitor has no person, so this sets the
 * submitted email as a flag-evaluation person property — it does not touch the
 * visitor's PostHog profile — reloads the flags, and reads the flag.
 *
 * The address arrives when the visitor submits it, not as it is typed, so one
 * submission costs one flags request. `null` means nothing was submitted yet and
 * the option stays hidden.
 *
 * `PostHogProvider` initializes PostHog in its own effect, and child effects run
 * before parent effects, so on a full page load `__loaded` is still false here.
 * A readiness state flipped by `onFeatureFlags` covers that, and the same
 * callback refreshes the result, because a reload that only changes person
 * properties does not re-render the React tree by itself.
 */
export function useChatGptSignInAccess(submittedEmail: string | null): boolean {
  const posthog = usePostHog();
  const [isReady, setIsReady] = useState(() => posthog?.__loaded === true);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    if (!posthog) {
      return;
    }
    if (posthog.__loaded) {
      setIsReady(true);
      return;
    }
    const unsubscribe = posthog.onFeatureFlags(() => setIsReady(true));
    return () => unsubscribe?.();
  }, [posthog]);

  useEffect(() => {
    if (!posthog?.__loaded || !isReady) {
      return;
    }

    const normalized = submittedEmail?.trim().toLowerCase() ?? '';
    if (!normalized) {
      setAllowed(false);
      return;
    }

    const sync = () => setAllowed(posthog.getFeatureFlag(CHATGPT_ACCESS_FLAG) === true);
    sync();
    const unsubscribe = posthog.onFeatureFlags(sync);
    posthog.setPersonPropertiesForFlags({ email: normalized }, false);
    posthog.reloadFeatureFlags();

    return () => {
      unsubscribe?.();
    };
  }, [posthog, submittedEmail, isReady]);

  useEffect(() => {
    return () => {
      posthog?.resetPersonPropertiesForFlags();
    };
  }, [posthog]);

  return allowed;
}
