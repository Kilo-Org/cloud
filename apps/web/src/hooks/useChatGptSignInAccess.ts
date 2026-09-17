'use client';

import { useEffect, useState } from 'react';
import { usePostHog } from 'posthog-js/react';
import { CHATGPT_ACCESS_FLAG } from '@/lib/auth/openai/access';

/**
 * How long the typed email must stay unchanged before the flag is evaluated.
 * The email changes on every keystroke, and each evaluation is a flags request.
 */
const EMAIL_SETTLE_MS = 300;

/**
 * Feature-flag access for the "Sign in with ChatGPT" sign-in option.
 *
 * The flag's release condition matches the approved email domains against the
 * `email` person property. A signed-out visitor has no person, so this sets the
 * typed email as a flag-evaluation person property — it does not touch the
 * visitor's PostHog profile — reloads the flags, and reads the flag.
 *
 * `PostHogProvider` initializes PostHog in its own effect, and child effects run
 * before parent effects. On a full page load `__loaded` is still false here, so
 * a readiness state is flipped by `onFeatureFlags` instead of returning for
 * good. The result is refreshed by the same callback, because a reload that
 * only changes person properties does not re-render the React tree by itself.
 */
export function useChatGptSignInAccess(email: string): boolean {
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
    // Flags load during `posthog.init`; the first callback means PostHog is ready.
    const unsubscribe = posthog.onFeatureFlags(() => setIsReady(true));
    return () => unsubscribe?.();
  }, [posthog]);

  useEffect(() => {
    if (!posthog?.__loaded || !isReady) {
      return;
    }

    const sync = () => setAllowed(posthog.getFeatureFlag(CHATGPT_ACCESS_FLAG) === true);
    sync();
    const unsubscribe = posthog.onFeatureFlags(sync);

    const normalized = email.trim().toLowerCase();
    const timer = setTimeout(() => {
      if (normalized) {
        // The reload is explicit so the empty-email branch, where the reset API
        // reloads on its own, does not issue a second request.
        posthog.setPersonPropertiesForFlags({ email: normalized }, false);
        posthog.reloadFeatureFlags();
      } else {
        posthog.resetPersonPropertiesForFlags();
      }
    }, EMAIL_SETTLE_MS);

    return () => {
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, [posthog, email, isReady]);

  useEffect(() => {
    return () => {
      posthog?.resetPersonPropertiesForFlags();
    };
  }, [posthog]);

  return allowed;
}
