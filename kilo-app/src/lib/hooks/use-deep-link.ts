import { useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { toast } from 'sonner-native';

import { useAppContext } from '@/lib/context/context-context';
import { consumePendingDeepLink, onPendingDeepLink, type PendingDeepLink } from '@/lib/deep-link';
import { trpcClient } from '@/lib/trpc';

/**
 * Consumes pending org-scoped deep links (set by +native-intent),
 * validates org membership, switches context, and navigates to the
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
        try {
          const orgs = await trpcClient.organizations.list.query();
          const hasAccess = orgs.some(org => org.organizationId === link.organizationId);
          if (!hasAccess) {
            toast.error('You don\u2019t have access to this organization');
            return;
          }
          await setContext({ type: 'organization', organizationId: link.organizationId });
          router.replace(link.targetRoute);
        } catch {
          toast.error('Failed to open link');
        }
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
