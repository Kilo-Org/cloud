import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo } from 'react';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { PrConversationCommentComposer } from '@/components/pr-review/discussion/pr-conversation-comment-composer';
import {
  parseProviderPrRoute,
  providerPrRefKey,
  providerPrTriple,
} from '@/lib/pr-review/provider-pr-ref';

type Params = {
  platform: string;
  identity: string[] | string;
  instance?: string;
};

// Conversation (issue) comment formSheet on a provider route, pushed by the
// Discussion tab's bottom CTA bar. The GitHub sibling
// (`[owner]/[repo]/[number]/conversation-comment`) keeps its own literal path;
// this one stays inside the provider layout, so the write carries the provider
// ref and the scope the layout published — a GitLab MR or a Bitbucket PR,
// never the GitHub-shaped triple.
export default function ProviderPrConversationCommentRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<Params>();
  const ref = useMemo(
    () =>
      parseProviderPrRoute({
        platform: params.platform,
        identity: params.identity,
        instance: params.instance,
      }),
    [params.platform, params.identity, params.instance]
  );

  // A hand-built `/pr-review/github/...` link belongs to the GitHub route; the
  // provider layout redirects it before it can mount here.
  if (!ref || ref.platform === 'github') {
    return <InvalidRouteState backTo={'/(app)/pr-review' as Href} />;
  }

  const triple = providerPrTriple(ref);

  return (
    <PrConversationCommentComposer
      owner={triple.owner}
      repo={triple.repo}
      number={triple.number}
      prRef={ref}
      providerRefKey={providerPrRefKey(ref)}
      onDismiss={() => {
        router.back();
      }}
    />
  );
}
