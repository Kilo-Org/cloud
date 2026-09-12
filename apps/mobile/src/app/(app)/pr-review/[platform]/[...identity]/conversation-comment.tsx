import { type Href, useLocalSearchParams, useRouter } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { PrConversationCommentComposer } from '@/components/pr-review/discussion/pr-conversation-comment-composer';
import { parseProviderPrRoute, providerPrTriple } from '@/lib/pr-review/provider-pr-ref';
import { parseParam } from '@/lib/route-params';

type Params = {
  platform: string;
  identity: string[];
  instance?: string;
};

// Conversation (issue) comment formSheet for a provider PR/MR, pushed by the
// Discussion tab's bottom CTA bar. The sheet chrome, the provider scope, and
// the PendingReviewProvider hoist live in the `[...identity]` layout; this
// route only parses the provider ref exactly like the `[...identity]/index`
// route does, so a GitLab self-managed host + full nested project path (the
// `instance` param included) rides the layout's scope into the composer.
export default function ProviderPrConversationCommentRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<Params>();
  const ref = parseProviderPrRoute({
    platform: parseParam(params.platform) ?? '',
    identity: params.identity,
    instance: params.instance,
  });

  if (!ref) {
    return <InvalidRouteState backTo={'/(app)/pr-review' as Href} />;
  }

  const { owner, repo, number } = providerPrTriple(ref);

  return (
    <PrConversationCommentComposer
      owner={owner}
      repo={repo}
      number={number}
      onDismiss={() => {
        router.back();
      }}
    />
  );
}
