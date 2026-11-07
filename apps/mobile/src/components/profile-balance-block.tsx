import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';

import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/** The balance slot's three states: the loading skeleton, the failed read, the loaded row. */
export type BalanceBlockState = 'loading' | 'failed' | 'ready';

type BalanceBlockProps = Readonly<{
  readonly state: BalanceBlockState;
  /**
   * A card too narrow for the note to keep its lines beside the amount is a
   * column: one control row — the amount, the visibility toggle and the
   * purchase action — and the note under it at the card's full width.
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
  /** The failed read's copy. */
  readonly retryLabel: string;
  readonly onRetry: () => void;
}>;

/**
 * One shell for the balance block in all three of its states — the loading
 * skeleton, the failed read and the loaded row — so a change of state swaps the
 * content and never the frame around it.
 *
 * A stacked card paints two rows in every state: the control row on top and the
 * note under it, at the card's own padding. The purchase action used to take a
 * band of its own below the note, which left the card half empty and its two
 * ends unevenly padded (design review, Profile compact cell, 2026-11-07); on
 * the control row it fills the card's trailing end beside the amount. The row
 * holds a 44 dp floor in all three states and the note one line, so the block
 * never changes height as the read answers, fails or retries.
 *
 * A wide card keeps its single row: the amount's column holds the note and the
 * toggle and the action stand beside it. Its 48 dp column is the height the
 * loading bar pair and the failed read's pressable carry, so that block holds
 * its frame too: the swap to the balance row used to move every section below
 * it by 1.5 dp (design gate, Profile, 2026-11-05).
 */
export function BalanceBlock({
  state,
  stacked,
  amount,
  toggle,
  note,
  loadingAction,
  action,
  retryLabel,
  onRetry,
}: BalanceBlockProps) {
  const shellClass = cn(
    'min-h-16 rounded-lg bg-secondary px-3 py-2',
    // The stacked card keeps one gap under the control row in every state, so
    // a state change never moves the note or the sections below the card.
    stacked ? 'items-stretch gap-1' : 'flex-row items-center gap-2'
  );
  const controlRowClass = 'min-w-0 min-h-[44px] flex-row items-center gap-1';
  const retry = (
    // Two lines is the most a retry label can take and still fit the control
    // row's 44 dp floor: the longest shipped values run past sixty characters
    // and wrap inside the row's remaining width, and a third line would make
    // the failed block taller than the row it swaps into.
    <Text
      className="text-sm text-destructive"
      numberOfLines={stacked ? 2 : undefined}
      ellipsizeMode="tail"
    >
      {retryLabel}
    </Text>
  );

  if (state === 'loading') {
    return (
      <View className={shellClass}>
        {stacked ? (
          <>
            <View className={controlRowClass}>
              <View className="min-w-0 flex-1">
                <Skeleton className="h-8 w-28 max-w-full rounded-md bg-muted-soft" />
              </View>
              {loadingAction}
            </View>
            <Skeleton className="h-3.5 w-40 max-w-full rounded bg-muted-soft" />
          </>
        ) : (
          <>
            <View className="min-h-[48px] flex-1 justify-center gap-1">
              <Skeleton className="h-8 w-28 rounded-md bg-muted-soft" />
              <Skeleton className="h-3 w-40 rounded bg-muted-soft" />
            </View>
            {loadingAction}
          </>
        )}
      </View>
    );
  }

  if (state === 'failed') {
    return (
      <View className={shellClass}>
        {stacked ? (
          <>
            <View className={controlRowClass}>
              {/* The retry surface fills the control row, so a retry that
                  succeeds swaps this content for the amount and the controls
                  in a row of the same height. */}
              <Pressable
                className="min-w-0 flex-1 justify-center self-stretch active:opacity-70"
                onPress={onRetry}
              >
                {retry}
              </Pressable>
              {action}
            </View>
            {note}
          </>
        ) : (
          <>
            <Pressable
              className="min-h-[48px] flex-1 justify-center active:opacity-70"
              onPress={onRetry}
            >
              {retry}
            </Pressable>
            {action}
          </>
        )}
      </View>
    );
  }

  if (stacked) {
    return (
      <View className={shellClass}>
        <Animated.View className="min-w-0" layout={LinearTransition.duration(200)}>
          {/* The toggle's 48 dp box carries `-my-[10px]`, so it reaches its
              touch target without adding height to the row. */}
          <View className={controlRowClass}>
            <View className="min-w-0 flex-1">{amount}</View>
            <View className="shrink-0 -my-[10px]">{toggle}</View>
            {action}
          </View>
        </Animated.View>
        {note}
      </View>
    );
  }

  return (
    <View className={shellClass}>
      <Animated.View
        className="min-w-0 flex-1 flex-row items-center gap-1"
        layout={LinearTransition.duration(200)}
      >
        {/* `flex-1` is a width share here: this View is the shell row's child.
            A stacked card is a column, where `flex-1` would set a 0 vertical
            basis and the row would measure 0 dp tall on the first layout pass
            (Android compact cell, 2026-11-03). */}
        <View className="min-w-0 flex-1 gap-1">
          {amount}
          {note}
        </View>
        {toggle}
      </Animated.View>
      {action}
    </View>
  );
}
