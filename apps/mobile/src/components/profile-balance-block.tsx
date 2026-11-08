import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';

import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { LINE_ACTION_HIT_SLOP } from '@/lib/a11y/tap-target';

/** The balance slot's three states: the loading skeleton, the failed read, the loaded row. */
export type BalanceBlockState = 'loading' | 'failed' | 'ready';

type BalanceBlockProps = Readonly<{
  readonly state: BalanceBlockState;
  /**
   * A card too narrow for the note to keep its lines beside the amount gives
   * the value column a 48 dp floor. The toggle and the purchase action sit
   * beside that column either way.
   */
  readonly stacked: boolean;
  /** The amount line, which the loading state replaces with a bar. */
  readonly amount: ReactNode;
  /** The hide/show toggle, in the amount's row. */
  readonly toggle: ReactNode;
  /** The expiry note. It reads the credit blocks, not the balance. */
  readonly note: ReactNode;
  /** The purchase action, the same in every state so its slot never changes. */
  readonly action: ReactNode;
  /** The visible failure line beside the retry action. */
  readonly failureLabel: string;
  readonly retryLabel: string;
  readonly retryActionLabel: string;
  readonly onRetry: () => void;
}>;

/** Balance-state changes preserve the independently loaded note and control slots. */
export function BalanceBlock({
  state,
  stacked,
  amount,
  toggle,
  note,
  failureLabel,
  action,
  retryLabel,
  retryActionLabel,
  onRetry,
}: BalanceBlockProps) {
  // Keep the expanded line-action target inside the card even when the note wraps.
  const shellClass = 'min-h-16 flex-row items-center gap-2 rounded-lg bg-secondary px-3 py-3';
  const valueColumnClass = stacked
    ? 'min-w-0 min-h-[48px] flex-1 justify-center gap-1'
    : 'min-w-0 flex-1 gap-1';
  const contentClass = 'min-w-0 flex-1 flex-row items-center gap-1';
  const amountRowClass = 'min-w-0 flex-row items-center gap-1';
  // Match the hit slop's parent padding without changing the value line's layout share.
  const valueWrapperClass =
    state === 'failed' ? 'min-w-0 flex-1 -my-[9px] py-[9px]' : 'min-w-0 flex-1';

  let value = amount;
  if (state === 'loading') {
    value = <Skeleton className="h-8 w-28 max-w-full rounded-md bg-muted-soft" />;
  } else if (state === 'failed') {
    value = (
      <Pressable
        className="min-h-[28px] min-w-0 flex-row items-center gap-2 active:opacity-70"
        hitSlop={LINE_ACTION_HIT_SLOP}
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel={retryLabel}
      >
        <Text
          className="min-w-0 shrink text-sm text-destructive"
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {failureLabel}
        </Text>
        <Text className="shrink-0 text-sm text-primary" numberOfLines={1}>
          {retryActionLabel}
        </Text>
      </Pressable>
    );
  }
  // Every state reserves the toggle's box, so the note's width never changes with the balance.
  const visibilityControl = state === 'ready' ? toggle : <View className="h-[48px] w-[48px]" />;
  // The noninteractive caption must not intercept the retry target's hit slop.
  const expiryNote = state === 'failed' ? <View pointerEvents="none">{note}</View> : note;
  const valueRow = (
    <View className={amountRowClass}>
      <View className={valueWrapperClass}>{value}</View>
    </View>
  );

  return (
    <View className={shellClass}>
      <Animated.View className={contentClass} layout={LinearTransition.duration(200)}>
        {/* `flex-row` keeps the column's `flex-1` on the horizontal axis. */}
        <View className={valueColumnClass}>
          {valueRow}
          {expiryNote}
        </View>
        {visibilityControl}
      </Animated.View>
      {action}
    </View>
  );
}
