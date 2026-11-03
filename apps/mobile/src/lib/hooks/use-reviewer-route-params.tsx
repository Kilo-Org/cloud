import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { useLocalSearchParams } from 'expo-router';

import {
  parseReviewerPlatform,
  PERSONAL_SCOPE,
  type ReviewerPlatform,
  type ReviewerScopePlatform,
} from '@/lib/code-reviewer-config';
import { parseParam } from '@/lib/route-params';

/** The `scope` string and platform every code-reviewer screen takes. */
export type ReviewerRouteParams = { scope: string; platform: ReviewerPlatform };

/**
 * Reads and validates the `[scope]/[platform]` route params shared by every
 * code-reviewer settings screen. Returns `null` when either segment is
 * missing/malformed or the scope+platform combination isn't supported (see
 * `parseReviewerPlatform`), so callers can render a single invalid-route
 * fallback instead of duplicating this parse+guard preamble per screen.
 *
 * The result describes the route that calls it and nothing else:
 * `useLocalSearchParams` returns the params React Navigation stored for that
 * one screen, and expo-router seeds a nested navigator's initial route without
 * params, so a child screen cannot assume its own params match the layout's.
 * Call this in `[platform]/_layout.tsx` only; the screens below it read the
 * validated pair through `useReviewerRouteParams()`.
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

function toRouteParams(params: ReviewerScopePlatform): ReviewerRouteParams {
  return {
    scope: params.kind === 'personal' ? PERSONAL_SCOPE : params.organizationId,
    platform: params.platform,
  };
}

const ReviewerRouteParamsContext = createContext<ReviewerRouteParams | null>(null);

/**
 * Shares the layout's validated `scope`+`platform` pair with the screens below
 * it, so every one of them renders the pair the guard accepted instead of
 * re-reading a route object that may carry none (or another route's).
 */
export function ReviewerRouteParamsProvider({
  params,
  children,
}: Readonly<{ params: ReviewerScopePlatform; children: ReactNode }>) {
  const value = useMemo(() => toRouteParams(params), [params]);
  return (
    <ReviewerRouteParamsContext.Provider value={value}>
      {children}
    </ReviewerRouteParamsContext.Provider>
  );
}

/**
 * The layout-validated `scope`+`platform` pair, or `null` when the calling
 * screen renders outside `[platform]/_layout.tsx` — which the app never does,
 * because that layout renders `InvalidRouteState` instead of its children when
 * the pair is invalid. Callers render `InvalidRouteState` in the `null` case
 * rather than indexing platform capabilities with an unvalidated value.
 */
export function useReviewerRouteParams(): ReviewerRouteParams | null {
  return useContext(ReviewerRouteParamsContext);
}
