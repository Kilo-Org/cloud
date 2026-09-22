import { type Href, useRouter } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { PrConversationCommentComposer } from '@/components/pr-review/discussion/pr-conversation-comment-composer';
import {
  providerPrRefLabel,
  providerPrTriple,
  useProviderPrScopeOrNull,
} from '@/lib/pr-review/provider-pr-ref';

// Provider conversation-comment formSheet, pushed by the Discussion tab's
// bottom CTA bar for a GitLab MR / Bitbucket PR. Sibling of the GitHub
// `[owner]/[repo]/[number]/conversation-comment` route: the provider layout
// owns the ref, the connect gate and the scope, so this route only reads the
// scope it publishes and hands the GitHub-shaped triple to the shared
// composer (the same composer the GitHub route mounts — no per-provider fork).
export default function ProviderPrConversationCommentRoute() {
  const router = useRouter();
  const scope = useProviderPrScopeOrNull();

  if (!scope) {
    return <InvalidRouteState backTo={'/(app)/pr-review' as Href} />;
  }

  const triple = providerPrTriple(scope.ref);

  return (
    <PrConversationCommentComposer
      owner={triple.owner}
      repo={triple.repo}
      number={triple.number}
      prRef={scope.ref}
      eyebrow={providerPrRefLabel(scope.ref)}
      onDismiss={() => {
        router.back();
      }}
    />
  );
}
