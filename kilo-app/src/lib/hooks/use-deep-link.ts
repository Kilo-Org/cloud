import { useRouter } from 'expo-router';
import { useEffect } from 'react';

import { useAppContext } from '@/lib/context/context-context';
import { consumePendingDeepLink } from '@/lib/deep-link';

/**
 * Consumes a pending org-scoped deep link (set by +native-intent),
 * switches context to the target organization, and navigates to the
 * destination screen.
 *
 * Must be called inside the (app) layout (inside providers, after auth).
 */
export function useDeepLink() {
  const { setContext } = useAppContext();
  const router = useRouter();

  useEffect(() => {
    const link = consumePendingDeepLink();
    if (!link) {
      return;
    }

    const navigate = async () => {
      await setContext({ type: 'organization', organizationId: link.organizationId });
      router.replace(link.targetRoute);
    };
    void navigate();
  }, [setContext, router]);
}
