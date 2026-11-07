import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';

import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';

/** The balance slot's three states: the loading skeleton, the failed read, the loaded row. */
export type BalanceBlockState = 'loading' | 'failed' | 'ready';

type BalanceBlockProps = Readonly<{
  readonly state: BalanceBlockState;
  /**
   * A card too narrow for the note to keep its lines beside the amount keeps
   * the toggle on the amount's line and gives the note its own line under it.
   * The purchase action sits beside that column either way.
   */
  readonly stacked: boolean;
  /** The amount line, which the loading state replaces with a bar. */
  readonly amount: ReactNode;
  /** The hide/show toggle, in the amount's row. */
  readonly toggle: ReactNode;
  /** The expiry note. It reads the credit blocks, not the balance. */
  readonly note: ReactNode;
  /** The purchase action that holds its slot while the balance read runs. */
  readonly loadingAction: ReactNode;
  /** The purchase action of the failed and the loaded states. */
  readonly action: ReactNode;
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
  loadingAction,
  action,
  retryLabel,
  retryActionLabel,
  onRetry,
}: BalanceBlockProps) {
  const shellClass = 'min-h-16 flex-row items-center gap-2 rounded-lg bg-secondary px-3 py-2';
  const valueColumnClass = 'min-w-0 min-h-[48px] flex-1 justify-center gap-1';
  const amountRowClass = 'min-w-0 flex-row items-center gap-1';

  let value = amount;
  if (state === 'loading') {
    value = <Skeleton className="h-8 w-28 max-w-full rounded-md bg-muted-soft" />;
  } else if (state === 'failed') {
    value = (
      <Pressable
        className="min-h-[44px] -my-[8px] min-w-0 justify-center active:opacity-70"
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel={retryLabel}
      >
        <Text className="text-sm text-destructive">{retryActionLabel}</Text>
      </Pressable>
    );
  }
  let visibilityControl = toggle;
  if (state !== 'ready') {
    visibilityControl =
      stacked && state === 'failed' ? null : <View className="h-[48px] w-[48px]" />;
  }
  const purchaseAction = state === 'loading' ? loadingAction : action;

  if (stacked) {
    return (
      <View className={shellClass}>
        {/* `flex-row` keeps `flex-1` a width share: in a column wrapper it
            would set a 0 vertical basis, and the 48 dp floor would then pin the
            column so a longer note paints outside the card instead of growing
            it (the collapse the wide card's row avoids the same way). */}
        <Animated.View className="min-w-0 flex-1 flex-row" layout={LinearTransition.duration(200)}>
          <View className={valueColumnClass}>
            <View className={amountRowClass}>
              <View className="min-w-0 flex-1">{value}</View>
              {/* The toggle's 48 dp box carries `-my-[10px]`, so it reaches its
                  touch target without adding height to the value line. */}
              {state !== 'failed' && (
                <View className="shrink-0 -my-[10px]">{visibilityControl}</View>
              )}
            </View>
            {note}
          </View>
        </Animated.View>
        {purchaseAction}
      </View>
    );
  }

  return (
    <View className={shellClass}>
      <Animated.View
        className="min-w-0 flex-1 flex-row items-center gap-1"
        layout={LinearTransition.duration(200)}
      >
        {/* `flex-1` is a width share here: this View is the row's child. */}
        <View className="min-w-0 flex-1 gap-1">
          {value}
          {note}
        </View>
        {visibilityControl}
      </Animated.View>
      {purchaseAction}
    </View>
  );
}
