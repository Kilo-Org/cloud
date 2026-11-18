import { type Href, useLocalSearchParams, useRouter } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { PrCommentEditSheet } from '@/components/pr-review/discussion/pr-comment-edit-sheet';
import { parseParam, parsePositiveIntParam } from '@/lib/route-params';

type Params = {
  owner: string;
  repo: string;
  number: string;
  commentId: string;
  kind: string;
  body: string;
};

// Own-comment edit formSheet, pushed by the Discussion tab's own-comment
// actions. The sheet chrome and the PendingReviewProvider hoist live in the
// `[number]` layout; this route only parses its params (a malformed deep link
// is rejected here before the sheet mounts).
export default function PrCommentEditRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<Params>();
  const owner = parseParam(params.owner);
  const repo = parseParam(params.repo);
  const number = parsePositiveIntParam(params.number);
  const commentId = parsePositiveIntParam(params.commentId);
  const kind = parseParam(params.kind, ['review', 'conversation'] as const);
  const body = parseParam(params.body);

  if (!owner || !repo || number === null || commentId === null || !kind || body === null) {
    return <InvalidRouteState backTo={'/(app)/pr-review' as Href} />;
  }

  return (
    <PrCommentEditSheet
      owner={owner}
      repo={repo}
      number={number}
      commentId={commentId}
      kind={kind}
      initialBody={body}
      onDismiss={() => {
        router.back();
      }}
    />
  );
}
