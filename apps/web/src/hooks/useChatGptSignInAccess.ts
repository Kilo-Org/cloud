'use client';

import { useEffect, useState } from 'react';
import { usePostHog } from 'posthog-js/react';
import { CHATGPT_ACCESS_FLAG } from '@/lib/auth/openai/access';

/**
 * Feature-flag access for the "Sign in with ChatGPT" sign-in option.
 *
 * The flag's release condition matches the approved email domains against the
 * `email` person property. A signed-out visitor has no person, so this sets the
 * typed email as a flag-evaluation person property — it does not touch the
 * visitor's PostHog profile — reloads the flags, and reads the flag. The result
 * is kept in state and refreshed by `onFeatureFlags`, because a reload that
 * only changes person properties does not re-render the React tree by itself.
 */
export function useChatGptSignInAccess(email: string): boolean {
  const posthog = usePostHog();
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    if (!posthog?.__loaded) {
      return;
    }
    const normalized = email.trim().toLowerCase();
    if (normalized) {
      posthog.setPersonPropertiesForFlags({ email: normalized }, false);
    } else {
      posthog.resetPersonPropertiesForFlags();
    }

    const sync = () => setAllowed(posthog.getFeatureFlag(CHATGPT_ACCESS_FLAG) === true);
    sync();
    const unsubscribe = posthog.onFeatureFlags(sync);
    posthog.reloadFeatureFlags();

    return () => {
      unsubscribe?.();
    };
  }, [posthog, email]);

  useEffect(() => {
    return () => {
      posthog?.resetPersonPropertiesForFlags();
    };
  }, [posthog]);

  return allowed;
}
