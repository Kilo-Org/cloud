import { useLocalSearchParams } from 'expo-router';

import { parseReviewerPlatform, type ReviewerScopePlatform } from '@/lib/code-reviewer-config';
import { parseParam } from '@/lib/route-params';

/**
 * Reads and validates the `[scope]/[platform]` route params shared by every
 * code-reviewer settings screen. Returns `null` when either segment is
 * missing/malformed or the scope+platform combination isn't supported (see
 * `parseReviewerPlatform`), so callers can render a single invalid-route
 * fallback instead of duplicating this parse+guard preamble per screen.
 */
export function useValidatedReviewerRouteParams(): ReviewerScopePlatform | null {
  const { scope: rawScope, platform: rawPlatform } = useLocalSearchParams<{
    scope: string;
    platform: string;
  }>();
  const scope = parseParam(rawScope);
  if (!scope) {
    return null;
  }
  return parseReviewerPlatform(scope, rawPlatform);
}
