import { type Href, useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { SharedSessionScreen } from '@/components/shared-session/shared-session-screen';
import { parseParam } from '@/lib/route-params';

/**
 * `/s/<token>` deep link: a publicly shared session, read-only.
 *
 * The token is the share capability, so the route keeps it opaque — it is only
 * ever passed to the read — and a missing or repeated segment renders the
 * invalid-route state instead of a request for a token that cannot exist.
 */
export default function SharedSessionRoute() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const shareToken = parseParam(token);
  if (shareToken === null) {
    return <InvalidRouteState backTo={'/(app)' as Href} />;
  }
  // Keyed by the token so opening a second share from the same route builds a
  // fresh screen: no scroll position or cached read carries across links.
  return <SharedSessionScreen key={shareToken} shareToken={shareToken} />;
}
