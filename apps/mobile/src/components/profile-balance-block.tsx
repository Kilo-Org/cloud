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
  /** The failed read's copy. */
  readonly retryLabel: string;
  readonly onRetry: () => void;
}>;

/**
 * One shell for the balance block in all three of its states — the loading
 * skeleton, the failed read and the loaded row — so a change of state swaps the
 * content and never the frame around it.
 *
 * A stacked card paints the value's column with the purchase action beside it:
 * the amount and its toggle on the line, the note directly under them at the
 * column's own gap, and the action centered against the pair. The note used to
 * hang off a 44 dp control row, which put the caption a further 7 dp below the
 * value than the wide card does and let the action's height push it down
 * (design review, Profile compact cell, 2026-11-07). The column holds a 48 dp
 * floor in all three states, so the block never changes height as the read
 * answers, fails or retries.
 *
 * A wide card keeps its single row: the amount's column holds the note, with
 * the toggle and the action beside it. Its column carries the loading bar pair
 * and the failed read's pressable at the same 48 dp, so that block holds its
 * frame too: the swap to the balance row used to move every section below it
 * by 1.5 dp (design gate, Profile, 2026-11-05).
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
  // One shell in both layouts and in every state: a row whose value column
  // holds the amount and the note, with the purchase action centered beside it.
  const shellClass = 'min-h-16 flex-row items-center gap-2 rounded-lg bg-secondary px-3 py-2';
  // The frame all three states share: the loading bar, the failed read's retry
  // surface and the loaded amount all fit inside this column, so the note and
  // the sections below the card stay where they are.
  const valueColumnClass = 'min-w-0 min-h-[48px] flex-1 justify-center gap-1';
  const amountRowClass = 'min-w-0 flex-row items-center gap-1';
  const retry = (
    // Two lines is the most a retry label can take and still fit the value
    // line: the longest shipped values run past sixty characters and wrap
    // inside the column's remaining width, and a third line would make the
    // failed block taller than the row it swaps into.
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
        <View className={valueColumnClass}>
          {/* The stacked card's bar is the height of the amount line it
              replaces, so the note under it holds its place as the read
              answers. */}
          <Skeleton
            className={
              stacked
                ? 'h-7 w-28 max-w-full rounded-md bg-muted-soft'
                : 'h-8 w-28 rounded-md bg-muted-soft'
            }
          />
          <Skeleton
            className={
              stacked
                ? 'h-3.5 w-40 max-w-full rounded bg-muted-soft'
                : 'h-3 w-40 rounded bg-muted-soft'
            }
          />
        </View>
        {loadingAction}
      </View>
    );
  }

  if (state === 'failed') {
    return (
      <View className={shellClass}>
        {stacked ? (
          <View className={valueColumnClass}>
            {/* The retry surface carries its own 44 dp target and keeps the
                value line's height, so a retry that succeeds swaps this
                content for the amount and the controls in the same frame. */}
            <Pressable
              className="min-h-11 -my-[8px] min-w-0 justify-center active:opacity-70"
              onPress={onRetry}
            >
              {retry}
            </Pressable>
            {note}
          </View>
        ) : (
          <Pressable
            className="min-h-[48px] flex-1 justify-center active:opacity-70"
            onPress={onRetry}
          >
            {retry}
          </Pressable>
        )}
        {action}
      </View>
    );
  }

  if (stacked) {
    return (
      <View className={shellClass}>
        <Animated.View className="min-w-0 flex-1" layout={LinearTransition.duration(200)}>
          <View className={valueColumnClass}>
            <View className={amountRowClass}>
              <View className="min-w-0 flex-1">{amount}</View>
              {/* The toggle's 48 dp box carries `-my-[10px]`, so it reaches its
                  touch target without adding height to the value line. */}
              <View className="shrink-0 -my-[10px]">{toggle}</View>
            </View>
            {note}
          </View>
        </Animated.View>
        {action}
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
          {amount}
          {note}
        </View>
        {toggle}
      </Animated.View>
      {action}
    </View>
  );
}
