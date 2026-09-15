import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo } from 'react';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { PrConversationCommentComposer } from '@/components/pr-review/discussion/pr-conversation-comment-composer';
import { parseProviderPrRoute, providerPrTriple } from '@/lib/pr-review/provider-pr-ref';
import { parseParam } from '@/lib/route-params';

type Params = {
  platform: string;
  identity: string[] | string;
  instance?: string;
};

/**
 * Provider conversation-comment formSheet, pushed by the Discussion tab's
 * bottom CTA bar. It is the provider twin of the GitHub
 * `[owner]/[repo]/[number]/conversation-comment` route: the same composer
 * behind the same sheet detents, but reached through the ref's own route so
 * the provider scope (and its organization queue) is the one the write runs
 * under. The layout registers this route as a formSheet sibling of
 * `index`, like the GitHub layout registers its own.
 */
export default function ProviderPrConversationCommentRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<Params>();

  // The identity segments are validated by the layout above; re-parsing here
  // keeps the route self-contained for a direct deep link.
  const ref = useMemo(
    () =>
      parseProviderPrRoute({
        platform: params.platform,
        identity: params.identity,
        instance: parseParam(params.instance) ?? undefined,
      }),
    [params.platform, params.identity, params.instance]
  );

  if (!ref || ref.platform === 'github') {
    return <InvalidRouteState backTo={'/(app)/pr-review' as Href} />;
  }

  const { owner, repo, number } = providerPrTriple(ref);

  return (
    <PrConversationCommentComposer
      owner={owner}
      repo={repo}
      number={number}
      prRef={ref}
      onDismiss={() => {
        router.back();
      }}
    />
  );
}
