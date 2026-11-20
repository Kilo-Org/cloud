import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';

import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { LINE_ACTION_HIT_SLOP } from '@/lib/a11y/tap-target';

/**
 * The balance slot's states: the loading skeleton, a failed read, and the
 * loaded row. A failed read carries the KIND of its failure, because the four
 * kinds do not share one sentence or one action: only a retryable or offline
 * failure can succeed on a second attempt.
 */
export type BalanceBlockState =
  | 'loading'
  | 'ready'
  | { readonly kind: 'failed'; readonly failure: BalanceFailure };

/** The one-line failure the slot paints, and whether it can be retried. */
export type BalanceFailure = Readonly<{
  readonly label: string;
  /** Absent when the failure cannot be fixed by asking again. */
  readonly retry?: { readonly handleRetry: () => void; readonly actionLabel: string };
  /** The spoken label of the line, when it is a button. */
  readonly accessibilityLabel?: string;
}>;

type BalanceBlockProps = Readonly<{
  readonly state: BalanceBlockState;
  /**
   * A card too narrow for the note to keep its lines beside the amount keeps
   * the toggle on the amount's line and gives the note its own line under it.
   * The purchase action sits beside that column on a wide card and on its own
   * end-aligned row under the note on a stacked one, so no control sits beside
   * the toggle at a different height.
   */
  readonly stacked: boolean;
  /** The amount line, which the loading state replaces with a bar. */
  readonly amount: ReactNode;
  /** The hide/show toggle, in the amount's row. */
  readonly toggle: ReactNode;
  /** The expiry note. It reads the credit blocks, not the balance. */
  readonly note: ReactNode;
}>;

/** Balance-state changes preserve the independently loaded note and control slots. */
export function BalanceBlock({ state, stacked, amount, toggle, note }: BalanceBlockProps) {
  const failed = state !== 'loading' && state !== 'ready';
  // Keep the expanded line-action target inside the card even when the note wraps.
  const shellClass = stacked ? 'min-h-16 gap-2' : 'min-h-16 flex-row items-center gap-2';
  const valueColumnClass = stacked
    ? 'min-w-0 min-h-[48px] flex-1 justify-center gap-1'
    : 'min-w-0 flex-1 gap-1';
  const contentClass = stacked ? 'min-w-0 flex-row' : 'min-w-0 flex-1 flex-row items-center gap-1';
  const amountRowClass = 'min-w-0 flex-row items-center gap-1';
  // Match the hit slop's parent padding without changing the value line's layout share.
  const valueWrapperClass = failed ? 'min-w-0 flex-1 -my-[9px] py-[9px]' : 'min-w-0 flex-1';

  let value = amount;
  if (state === 'loading') {
    value = <Skeleton className="h-8 w-28 max-w-full rounded-md bg-muted-soft" />;
  } else if (failed) {
    const { failure } = state;
    const label = (
      <Text
        className="min-w-0 shrink text-sm text-destructive"
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {failure.label}
      </Text>
    );
    // A failure a retry cannot fix is a statement, not a control: no press
    // target, no Retry beside it. The kind decides, so a permission refusal
    // and a terminal one never offer an action that can only fail again.
    value = failure.retry ? (
      <Pressable
        className="min-h-7 min-w-0 flex-row items-center gap-2 active:opacity-70"
        hitSlop={LINE_ACTION_HIT_SLOP}
        onPress={failure.retry.handleRetry}
        accessibilityRole="button"
        accessibilityLabel={failure.accessibilityLabel ?? failure.label}
      >
        {label}
        <Text className="shrink-0 text-sm text-primary" numberOfLines={1}>
          {failure.retry.actionLabel}
        </Text>
      </Pressable>
    ) : (
      <View className="min-h-7 min-w-0 flex-row items-center">
        <Text
          className="min-w-0 shrink text-sm text-destructive"
          numberOfLines={2}
          accessibilityLabel={failure.accessibilityLabel}
        >
          {failure.label}
        </Text>
      </View>
    );
  }
  let visibilityControl = toggle;
  if (state !== 'ready') {
    visibilityControl = stacked && failed ? null : <View className="h-12 w-12" />;
  }
  // The noninteractive caption must not intercept the retry target's hit slop.
  const expiryNote = failed ? <View pointerEvents="none">{note}</View> : note;
  const valueRow = (
    <View className={amountRowClass}>
      <View className={valueWrapperClass}>{value}</View>
      {stacked && !failed && <View className="shrink-0 -my-2.5">{visibilityControl}</View>}
    </View>
  );

  return (
    // The card takes no touch itself, so the account picker's hit slop above it
    // (the Credits header row) still reaches into the card's top padding; its
    // own controls keep their touches.
    <Card className={shellClass} pointerEvents="box-none">
      <Animated.View className={contentClass} layout={LinearTransition.duration(200)}>
        {/* `flex-row` keeps the column's `flex-1` on the horizontal axis. */}
        <View className={valueColumnClass}>
          {valueRow}
          {expiryNote}
        </View>
        {!stacked && visibilityControl}
      </Animated.View>
    </Card>
  );
}
