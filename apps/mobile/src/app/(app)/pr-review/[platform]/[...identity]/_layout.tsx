import { type Href, Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';

import { appUnlockScreenLayout } from '@/components/app-unlock-screen';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { useFormSheetDetents } from '@/lib/form-sheet';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import { useOrganization } from '@/lib/organization-context';
import {
  pendingReviewDraftKey,
  PendingReviewProvider,
} from '@/lib/pr-review/pending-review-provider';
import {
  parseProviderPrRoute,
  providerPrRefKey,
  providerPrRoutePath,
  ProviderPrScopeProvider,
  providerPrTriple,
} from '@/lib/pr-review/provider-pr-ref';
import { parseParam } from '@/lib/route-params';

type Params = {
  platform: string;
  identity: string[];
  instance?: string;
};

/**
 * Param guard + scope hoist for the provider PR-review surface.
 *
 * The route is `[platform]/[...identity]`, where the LAST identity segment is
 * the number (a GitLab MR iid, a Bitbucket PR id) and everything before it is
 * the project path — a GitLab FULL nested path (`group/sub/repo`) or a
 * Bitbucket `workspace/repo`. `parseProviderPrRoute` validates every segment,
 * so a hand-built deep link with a missing, repeated or non-numeric segment
 * never reaches a query.
 *
 * GitHub keeps its original `[owner]/[repo]/[number]` route untouched — this
 * layout only redirects a hand-built `/pr-review/github/...` link there so
 * that surface, its connect gate and its write sheets stay exactly as they
 * were.
 *
 * The scope (ref + organization) is published in context rather than threaded
 * through props: the diff list, the file navigator and the discussion tree
 * take the GitHub-shaped `owner`/`repo`/`number` triple, and reading the real
 * ref from context moves their queries to the right provider without a
 * per-provider copy of that tree.
 */
export default function ProviderPrReviewLayout() {
  const params = useLocalSearchParams<Params>();
  const platform = parseParam(params.platform) ?? '';
  // A catch-all param is a fresh array on every render; the joined form is a
  // stable dependency, and a `/` inside a segment is percent-encoded by
  // `providerPrRoutePath`, so splitting it back is lossless.
  const identity = Array.isArray(params.identity)
    ? params.identity.join('/')
    : (parseParam(params.identity) ?? '');
  const instance = parseParam(params.instance) ?? '';
  const { organizationId } = useOrganization();
  const { fullSheetDetent } = useFormSheetDetents();
  const { userId } = useCurrentUserId();
  useRouteForegroundRefresh([[['providerReview']]]);

  const ref = useMemo(
    () =>
      parseProviderPrRoute({
        platform,
        identity: identity.split('/'),
        instance: instance || undefined,
      }),
    [platform, identity, instance]
  );
  const scope = useMemo(() => (ref ? { ref, organizationId } : null), [ref, organizationId]);

  if (!ref || !scope) {
    return <InvalidRouteState backTo={'/(app)/pr-review' as Href} />;
  }

  if (ref.platform === 'github') {
    return <Redirect href={providerPrRoutePath(ref)} />;
  }

  // One draft queue per PR/MR: the GitHub-shaped key the store already uses,
  // suffixed with the s1 collision-free ref identity so a GitLab MR and a
  // GitHub PR that share `owner/repo#number` — and one project reached on two
  // GitLab instances — never share a queue.
  const triple = providerPrTriple(ref);
  const draftEntityKey = `${pendingReviewDraftKey(triple.owner, triple.repo, triple.number)}@${providerPrRefKey(ref)}`;

  const sheetOptions = {
    presentation: 'formSheet' as const,
    sheetAllowedDetents: [0.5, fullSheetDetent] as [number, number],
    sheetInitialDetentIndex: 'last' as const,
    sheetGrabberVisible: true,
    headerShown: false,
  };

  return (
    <ProviderPrScopeProvider value={scope}>
      <PendingReviewProvider
        key={`${draftEntityKey}:${userId ?? ''}`}
        userId={userId}
        draftEntityKey={draftEntityKey}
      >
        <Stack screenLayout={appUnlockScreenLayout} screenOptions={{ headerShown: false }}>
          <Stack.Screen name="file-navigator" options={sheetOptions} />
        </Stack>
      </PendingReviewProvider>
    </ProviderPrScopeProvider>
  );
}
