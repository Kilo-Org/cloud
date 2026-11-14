// Inline error area for the composer family. The failure arrives as the one
// object the surface published, so its kind, its copy and its announcer can
// never disagree. A locally raised validation ("here") announces through
// AccessibleStatus on both platforms; a mutation-derived failure was already
// toasted by the mutation hook and stays visual-only.

import { PrReviewReconnectNotice } from '@/components/pr-review/pr-review-reconnect-notice';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Text } from '@/components/ui/text';
import { View } from 'react-native';

import { type PrInlineFailure } from '@/lib/pr-review/inline-failure';
import { assertSurfaceFailureHandled, type SurfaceFeedback } from '@/lib/surface-feedback';

type ComposerInlineErrorProps = {
  readonly feedback: SurfaceFeedback<PrInlineFailure>;
};

export function ComposerInlineError({ feedback }: Readonly<ComposerInlineErrorProps>) {
  if (feedback.status !== 'failed') {
    return null;
  }
  switch (feedback.failure.kind) {
    case 'reconnect':
      return <PrReviewReconnectNotice />;
    case 'body-empty':
    case 'not-recorded':
    case 'retryable':
    case 'bad-request':
    case 'forbidden':
    case 'not-found':
    case 'ambiguous':
      return (
        <View className="rounded-md border border-destructive bg-red-50 dark:bg-red-950 px-2.5 py-1.5">
          {feedback.failure.announce === 'here' ? (
            <AccessibleStatus message={feedback.failure.message} tone="error" className="text-xs" />
          ) : (
            <Text className="text-xs text-destructive">{feedback.failure.message}</Text>
          )}
        </View>
      );
    default:
      return assertSurfaceFailureHandled(feedback.failure);
  }
}
