import { type Href, Stack, useLocalSearchParams } from 'expo-router';
import { appUnlockScreenLayout } from '@/components/app-unlock-screen';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { PrReviewConnectGate } from '@/components/pr-review/pr-review-connect-gate';
import { FeedbackPromptProvider } from '@/components/use-feedback-prompt';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import {
  pendingReviewDraftKey,
  PendingReviewProvider,
} from '@/lib/pr-review/pending-review-provider';
import { useFormSheetScreenOptions } from '@/lib/form-sheet';
import { parseParam, parsePositiveIntParam } from '@/lib/route-params';

type Params = {
  owner: string;
  repo: string;
  number: string;
};

/**
 * Param guard + provider hoist for the PR review surface. Every route
 * under `[number]/` is a descendant of this layout, so rejecting an
 * invalid owner/repo/number here blocks all of them before any
 * query/mutation runs. The four sheet routes are registered as siblings
 * INSIDE this layout so they all see the same `PendingReviewProvider`
 * context (the provider lifetime is the mounted navigation entry, so
 * pending comments survive opening/closing the sheets and the back
 * stack, but clear when the user leaves the PR entirely).
 *
 * The provider is keyed by `entity:user`, so an account change (or a
 * different PR, via the route) remounts it: in-memory items and
 * hydration state die with the old instance, and pending comments are
 * persisted per user and per PR under `draft:<userId>`.
 */
export default function PrReviewNumberLayout() {
  const params = useLocalSearchParams<Params>();
  const owner = parseParam(params.owner);
  const repo = parseParam(params.repo);
  const number = parsePositiveIntParam(params.number);
  const sheetOptions = { ...useFormSheetScreenOptions(), sheetInitialDetentIndex: 'last' as const };
  const { userId } = useCurrentUserId();
  useRouteForegroundRefresh([[['githubPrReview']]]);

  if (!owner || !repo || number === null) {
    return <InvalidRouteState backTo={'/(app)/pr-review' as Href} />;
  }

  // Lowercased inside the helper, like the recent-PR and viewed-file stores,
  // so the same PR reached with different owner/repo casing keeps one queue.
  const draftEntityKey = pendingReviewDraftKey(owner, repo, number);

  // The connect gate wraps every PR-review surface, including this nested
  // route reached directly by deep link / chat tap, so a disconnected or
  // revoked user can never reach the authenticated queries and mutations.
  // The prompt provider sits outside the gate: the review-submit sheet
  // requests the one-time post-submit prompt through it, and the host must
  // stay mounted across that sheet's dismissal (see `FeedbackPromptProvider`).
  return (
    <FeedbackPromptProvider>
      <PrReviewConnectGate>
        <PendingReviewProvider
          key={`${draftEntityKey}:${userId ?? ''}`}
          userId={userId}
          draftEntityKey={draftEntityKey}
        >
          <Stack screenLayout={appUnlockScreenLayout} screenOptions={{ headerShown: false }}>
            {/* Register the overview first: unregistered routes sort after
                registered siblings, so without this the initial screen is the
                comment-composer formSheet instead of the PR overview. */}
            <Stack.Screen name="index" />
            <Stack.Screen name="comment-composer" options={sheetOptions} />
            <Stack.Screen name="conversation-comment" options={sheetOptions} />
            <Stack.Screen name="comment-edit" options={sheetOptions} />
            <Stack.Screen name="review-submit" options={sheetOptions} />
            <Stack.Screen name="merge" options={sheetOptions} />
            <Stack.Screen name="file-navigator" options={sheetOptions} />
          </Stack>
        </PendingReviewProvider>
      </PrReviewConnectGate>
    </FeedbackPromptProvider>
  );
}
