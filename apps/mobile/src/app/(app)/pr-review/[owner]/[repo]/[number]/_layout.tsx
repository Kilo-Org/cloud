import { type Href, Stack, useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { PrReviewConnectGate } from '@/components/pr-review/pr-review-connect-gate';
import { PendingReviewProvider } from '@/lib/pr-review/pending-review-provider';
import { useFormSheetDetents } from '@/lib/form-sheet';
import { parseParam } from '@/lib/route-params';

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
 */
export default function PrReviewNumberLayout() {
  const params = useLocalSearchParams<Params>();
  const owner = parseParam(params.owner);
  const repo = parseParam(params.repo);
  const rawNumber = parseParam(params.number);
  const number = rawNumber ? Number.parseInt(rawNumber, 10) : Number.NaN;
  const { fullSheetDetent } = useFormSheetDetents();

  if (!owner || !repo || !Number.isInteger(number) || number <= 0) {
    return <InvalidRouteState backTo={'/(app)/pr-review' as Href} />;
  }

  const sheetOptions = {
    presentation: 'formSheet' as const,
    sheetAllowedDetents: [0.5, fullSheetDetent] as [number, number],
    sheetGrabberVisible: true,
    headerShown: false,
  };

  // The connect gate wraps every PR-review surface, including this nested
  // route reached directly by deep link / chat tap, so a disconnected or
  // revoked user can never reach the authenticated queries and mutations.
  return (
    <PrReviewConnectGate>
      <PendingReviewProvider>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="comment-composer" options={sheetOptions} />
          <Stack.Screen name="review-submit" options={sheetOptions} />
          <Stack.Screen name="merge" options={sheetOptions} />
          <Stack.Screen name="file-navigator" options={sheetOptions} />
        </Stack>
      </PendingReviewProvider>
    </PrReviewConnectGate>
  );
}
