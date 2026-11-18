import { type Href, useLocalSearchParams, useRouter } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { PrConversationCommentComposer } from '@/components/pr-review/discussion/pr-conversation-comment-composer';
import { parseParam, parsePositiveIntParam } from '@/lib/route-params';

type Params = {
  owner: string;
  repo: string;
  number: string;
};

// Conversation (issue) comment formSheet, pushed by the Discussion tab's
// bottom CTA bar. The sheet chrome and the PendingReviewProvider hoist live
// in the `[number]` layout; this route only parses its params.
export default function PrConversationCommentRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<Params>();
  const owner = parseParam(params.owner);
  const repo = parseParam(params.repo);
  const number = parsePositiveIntParam(params.number);

  if (!owner || !repo || number === null) {
    return <InvalidRouteState backTo={'/(app)/pr-review' as Href} />;
  }

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
