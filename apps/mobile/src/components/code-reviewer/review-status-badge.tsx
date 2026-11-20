import { View } from 'react-native';

import { statusMeta } from '@/components/code-reviewer/review-list-rows';
import { Text } from '@/components/ui/text';
import { type CodeReviewStatus } from '@kilocode/app-shared/code-review';
import { cn } from '@/lib/utils';

/**
 * The tint a status pill paints under its ink. `statusMeta` owns the solution
 * word and the ink for every status, and this map picks the matching 10%-alpha
 * tile token, so the pill and the review's row in the list state the same
 * status in the same hue instead of two hand-picked colours drifting apart.
 */
const STATUS_FILL = {
  pending: 'bg-secondary',
  queued: 'bg-secondary',
  running: 'bg-info-tile-bg',
  completed: 'bg-good-tile-bg',
  failed: 'bg-danger-tile-bg',
  cancelled: 'bg-secondary',
  interrupted: 'bg-warn-tile-bg',
} satisfies Record<CodeReviewStatus, string>;

function statusFill(status: string): string {
  return Object.hasOwn(STATUS_FILL, status)
    ? STATUS_FILL[status as CodeReviewStatus]
    : 'bg-secondary';
}

/**
 * A review's status as the badge the screen header carries: the outcome word in
 * the fixed status mapping's ink over the matching tint, at full radius.
 *
 * The word itself is the non-colour cue, so the outcome survives a colour-vision
 * difference. This is the one place the detail screen states the status — the
 * findings, council and gate sections below never repeat it.
 */
export function ReviewStatusBadge({ status }: Readonly<{ status: string }>) {
  const meta = statusMeta(status);
  return (
    <View className={cn('shrink-0 rounded-full px-2 py-0.5', statusFill(status))}>
      <Text variant="caption" className={meta.className}>
        {meta.label}
      </Text>
    </View>
  );
}
