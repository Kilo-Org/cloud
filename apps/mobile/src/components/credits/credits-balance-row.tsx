import Animated, { LinearTransition } from 'react-native-reanimated';
import { View } from 'react-native';

import { type ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The credits card's balance surface — card shell, amount, visibility toggle,
 * expiry note and purchase action — for both measured layouts:
 *
 * - Wide: the balance section holds two columns. The amount's column carries
 *   the amount and the expiry note; the trailing column carries the toggle and
 *   the purchase action.
 * - Stacked (below 370 scaled card dp): one amount row holds the amount, the
 *   toggle and the purchase action, and only the expiry note takes a line of
 *   its own under the balance. On the previous arrangement the note sat between
 *   the amount and an action row of its own, which left the card tall, empty
 *   space on the start side and the toggle stranded at the top end (Android
 *   compact cell, e2 design review 2026-11-05).
 *
 * `amountLine`, `toggle` and `action` are laid out here but built by the card,
 * which owns their state and handlers.
 */
export function BalanceRow(
  props: Readonly<{
    stackBalance: boolean;
    amountLine: ReactNode;
    visibilityToggle: ReactNode;
    expirySlot: ReactNode;
    /* The in-app purchase action, or null when the context owns one. */
    addCreditsAction: ReactNode;
  }>
) {
  const { stackBalance, amountLine, visibilityToggle, expirySlot, addCreditsAction } = props;
  return (
    <View
      className={cn(
        'min-h-16 gap-2 rounded-lg bg-secondary px-3 py-2',
        stackBalance ? 'items-stretch' : 'flex-row items-center'
      )}
    >
      <Animated.View
        className={cn('min-w-0', stackBalance ? 'gap-1' : 'flex-1 flex-row items-center gap-1')}
        layout={LinearTransition.duration(200)}
      >
        {/* On a stacked card this View is the amount row inside the column.
            `flex-row` without `flex-1`: `flex-1` sets a 0 vertical basis and
            the row measured 0 dp tall on the first layout pass (Android compact
            cell, 2026-11-03); the card's `items-stretch` already gives it the
            full width. `flex-wrap` keeps the trailing controls inside the card
            when a large scaled amount leaves them no room on the row. */}
        <View
          className={cn(
            'min-w-0',
            stackBalance ? 'flex-row flex-wrap items-center gap-1' : 'flex-1 gap-1'
          )}
        >
          <View className={cn('min-w-0', stackBalance && 'flex-1')}>{amountLine}</View>
          {stackBalance ? (
            <View className="shrink-0 -my-[10px]">{visibilityToggle}</View>
          ) : (
            expirySlot
          )}
          {stackBalance && addCreditsAction !== null && (
            <View className="max-w-full flex-row items-center justify-end gap-2">
              {addCreditsAction}
            </View>
          )}
        </View>
        {stackBalance ? expirySlot : visibilityToggle}
      </Animated.View>
      {/* The wide card's trailing column. */}
      {!stackBalance && addCreditsAction !== null && (
        <View className="max-w-full flex-row flex-wrap items-center justify-end gap-2">
          {addCreditsAction}
        </View>
      )}
    </View>
  );
}
