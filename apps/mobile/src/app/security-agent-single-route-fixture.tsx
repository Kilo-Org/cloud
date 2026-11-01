import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';

import { parseParam } from '@/lib/route-params';
import { getSecurityAgentPath } from '@/lib/security-agent';

/**
 * Dev-only fixture: open a Security Agent screen the way a link that builds a
 * fresh destination does, so that screen is the group's only route.
 *
 * Reached only through `+native-intent.tsx`, behind `__DEV__`:
 * `kiloapp:///dev/security-agent-single-route-fixture/personal/settings/notifications`
 */
export default function SecurityAgentSingleRouteFixtureRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ scope?: string; suffix?: string }>();
  const scope = parseParam(params.scope);
  const suffix = parseParam(params.suffix) ?? '';

  useEffect(() => {
    // A release build keeps the route but must never act on it.
    if (!__DEV__ || scope === null) {
      return;
    }
    // `replace`, not `push`: a link that builds its destination swaps the
    // screen it lands on for the target, and the target then has nothing
    // beneath it in this Stack.
    router.replace(getSecurityAgentPath(scope, suffix) as Href);
  }, [router, scope, suffix]);

  return null;
}
