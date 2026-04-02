import { useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';

import { useAppContext } from '@/lib/context/context-context';
import { consumePendingDeepLink, onPendingDeepLink, type PendingDeepLink } from '@/lib/deep-link';

/**
 * Consumes pending org-scoped deep links (set by +native-intent),
 * switches context to the target organization, and navigates to the
 * destination screen.
 *
 * Handles both cold-start (pending link already set before mount) and
 * warm-start (new link arriving while the app is open).
 *
 * Must be called inside the (app) layout (inside providers, after auth).
 */
export function useDeepLink() {
  const { setContext } = useAppContext();
  const router = useRouter();

  const handleLink = useCallback(
    (link: PendingDeepLink) => {
      const navigate = async () => {
        await setContext({ type: 'organization', organizationId: link.organizationId });
        router.replace(link.targetRoute);
      };
      void navigate();
    },
    [setContext, router]
  );

  useEffect(() => {
    // Cold start: consume any link set before this component mounted
    const link = consumePendingDeepLink();
    if (link) {
      handleLink(link);
    }

    // Warm start: listen for links arriving while the app is already open
    return onPendingDeepLink(handleLink);
  }, [handleLink]);
}
