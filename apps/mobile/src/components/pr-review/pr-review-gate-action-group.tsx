import { type ReactNode } from 'react';
import { View } from 'react-native';

import { PrReviewContextLine } from '@/components/pr-review/pr-review-context-line';

/**
 * The connect gate's action block: the account caption and the CTA as one
 * group, `gap-2` apart, inside the state's own wider gap to the body copy.
 *
 * The caption names the scope the CTA connects, so it belongs to the action.
 * Left as the last line of the description it floats between the body copy and
 * the button — about as far from each — and reads as a stray line instead of
 * the label of the control below it. It therefore renders at its own height
 * (`hugContent`), so the visible gap above the button is this group's own gap
 * and not the row frame's slack on top of it.
 *
 * The caption renders here even when the arm has no CTA (an organization member
 * whose role cannot complete the action): the account line is still the gate's
 * last row, and moving it between the two arms would read as a different
 * surface.
 */
export function PrReviewGateActionGroup({
  instanceHint,
  children,
}: Readonly<{
  instanceHint?: string;
  children?: ReactNode;
}>) {
  return (
    <View className="w-full items-center gap-2">
      <PrReviewContextLine instanceHint={instanceHint} hugContent />
      {children}
    </View>
  );
}
