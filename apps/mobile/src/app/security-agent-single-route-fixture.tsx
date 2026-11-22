import { type Href, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';

import { useStackSafeReplace } from '@/lib/navigation/stack-safe-replace';
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
  // The hand-off swaps the focused screen, so it goes through the
  // push-then-retire hook: a literal `router.replace` swaps both screens in one
  // native-stack commit and crashes Android Fabric. `replace` is
  // taken alone so the effect depends on the stable callback, not on the hook's
  // fresh-per-render result object.
  const { replace } = useStackSafeReplace();
  const params = useLocalSearchParams<{ scope?: string; suffix?: string }>();
  const scope = parseParam(params.scope);
  const suffix = parseParam(params.suffix) ?? '';

  useEffect(() => {
    // This screen renders nothing, so every branch must navigate. A release
    // build registers the route but must never run the fixture, and a dev link
    // that lost its scope has no destination either: both send the reader to
    // the app instead of stranding them on a blank screen.
    if (!__DEV__ || scope === null) {
      replace('/(app)' as Href);
      return;
    }
    // `replace`, not `push`: a link that builds its destination swaps the
    // screen it lands on for the target, and the target then has nothing
    // beneath it in this Stack.
    replace(getSecurityAgentPath(scope, suffix) as Href);
  }, [replace, scope, suffix]);

  return null;
}
