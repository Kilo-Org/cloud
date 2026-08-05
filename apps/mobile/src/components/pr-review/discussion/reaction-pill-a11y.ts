type ReactionPillA11yInputs = {
  /** Reaction emoji glyph rendered inside the pill. */
  emoji: string;
  /** Reaction count shown beside the emoji. */
  count: number;
  /** True when the viewer already reacted; drives the `selected` state. */
  viewerHasReacted: boolean;
  /** True when presses are locked during a pending mutation or read-only. */
  disabled: boolean;
};

export type ReactionPillA11yProps = {
  accessibilityRole: 'button';
  accessibilityLabel: string;
  accessibilityState: {
    selected: boolean;
    disabled: boolean;
  };
};

/**
 * Compose the accessibility props for a reaction pill, mirroring the visible
 * emoji + count (`"<emoji> reaction, <count> reaction(s)"`) and exposing the
 * toggle state: `selected` when the viewer has reacted (matches the accent-soft
 * fill), `disabled` when presses are locked. Purely a button — the pill is a
 * toggle in behavior only, so it must not use a checkbox/switch role.
 *
 * The caller spreads the returned props on the pill `Pressable` and wires
 * `onPress` / `disabled` / `hitSlop` separately.
 */
export function reactionPillA11y({
  emoji,
  count,
  viewerHasReacted,
  disabled,
}: ReactionPillA11yInputs): ReactionPillA11yProps {
  return {
    accessibilityRole: 'button',
    accessibilityLabel: `${emoji} reaction, ${count} ${count === 1 ? 'reaction' : 'reactions'}`,
    accessibilityState: {
      selected: viewerHasReacted,
      disabled,
    },
  };
}
