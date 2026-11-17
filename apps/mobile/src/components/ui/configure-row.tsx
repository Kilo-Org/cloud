import { type ComponentType, type ReactNode } from 'react';
import { useWindowDimensions } from 'react-native';

import { type LucideProps } from '@/components/ui/icons';
import { RowFrame } from '@/components/ui/row-frame';
import { type RowTrailingSpec } from '@/components/ui/row-trailing';
import {
  NEUTRAL_TINT,
  type RowHue,
  rowTint,
  type Tint,
  toneColor,
  type ToneKey,
} from '@/lib/agent-color';
import { useLiveFontScale } from '@/lib/font-scale/system-font-scale-context';
import { isNarrowLayout } from '@/lib/narrow-layout';

/**
 * At/above this Dynamic Type scale, ConfigureRow stacks the icon above the
 * title block so long labels never clip against the chevron in a side row.
 * Matches the tab-label wrap threshold used elsewhere in the shell. A window
 * narrower than `NARROW_LAYOUT_WIDTH` squeezes the same text block and takes
 * the same presentation.
 */
const CONFIGURE_ROW_STACK_FONT_SCALE = 1.8;

type ConfigureRowProps = {
  icon: ComponentType<LucideProps>;
  title: string;
  subtitle?: string;
  /**
   * Line cap for the subtitle. A subtitle that is one unbreakable token (an
   * email address, a host name) cannot wrap on Android and is hard-clipped at
   * the row edge with no ellipsis; `1` makes it ellipsize cleanly instead.
   */
  subtitleNumberOfLines?: number;
  /**
   * Node rendered in the subtitle's place while the value that fills it loads.
   * The row's subtitle is one line of `text-xs`, so a placeholder of that
   * height keeps the row's settled size: the rows below never move, and the
   * group does not print loading copy. The caller builds it, because the width
   * that stands in for the settled text is the caller's.
   */
  subtitlePlaceholder?: ReactNode;
  /**
   * Semantic tone override (good / warn / danger). When omitted the row uses
   * the shared neutral tile, so every row in a settings list carries the same
   * accent instead of a hue hashed from its title.
   */
  tone?: ToneKey;
  /**
   * Curated destination hue (see `RowHue`). A row identifies a destination, so
   * its colour is chosen once in the table and passed explicitly here; it is
   * never derived from the title. A semantic tone outranks it.
   */
  hue?: RowHue;
  /**
   * `navigation` is a destination row and ends in a chevron; `action` runs a
   * command in place, so it keeps the foreground title and no chevron.
   */
  variant?: 'navigation' | 'action';
  /** The action destroys something: a danger tile and a destructive title. */
  destructive?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  /**
   * Full accessible name of the pressable row. Set it when the row's state or
   * its action is not readable from the text a reader can already hear:
   * `accessibilityHint` cannot carry that on Android, where React Native maps
   * it to the node's tooltip and never to its content description, so the name
   * is the only place TalkBack reads. Omit it and the name stays the row's
   * visible text.
   */
  accessibilityLabel?: string;
  trailing?: ReactNode;
  className?: string;
  /** Test handle for the row's own control, for native E2E scripts. */
  testID?: string;
};

/** Tile + title + subtitle + trailing mark row. */
export function ConfigureRow({
  icon,
  title,
  subtitle,
  subtitleNumberOfLines,
  subtitlePlaceholder,
  tone,
  hue,
  variant = 'navigation',
  destructive = false,
  onPress,
  disabled,
  accessibilityLabel,
  trailing,
  className,
  testID,
}: Readonly<ConfigureRowProps>) {
  const { width } = useWindowDimensions();
  const fontScale = useLiveFontScale();
  // A narrow window squeezes the flexible text block between the fixed icon
  // tile and the chevron exactly as a large font scale does, until a whole word
  // no longer fits and Android breaks it mid-word ("Gene ral", 160 dp, e1,
  // 2026-09-21). Both cases get the stacked presentation, which hands the
  // title the row's full width.
  const stack = fontScale >= CONFIGURE_ROW_STACK_FONT_SCALE || isNarrowLayout(width);
  // A semantic tone outranks the curated destination hue, and a row carrying
  // neither keeps the shared neutral tile. A settings list is not a list of
  // agents: hashing each title into the agent hue ramp gave one list (Language
  // / Trusted hosts / Device sessions) three different accents, and a title
  // never picks a hue here.
  let tint: Tint = NEUTRAL_TINT;
  if (destructive) {
    tint = toneColor('danger');
  } else if (tone) {
    tint = toneColor(tone);
  } else if (hue) {
    tint = rowTint(hue);
  }
  // Inert rows (no onPress) and disabled rows are not tappable — hide the
  // chevron so they don't look tappable, and never render pressed feedback.
  const showChevron = variant === 'navigation' && Boolean(onPress) && !disabled;
  let rowTrailing: RowTrailingSpec | undefined;
  if (trailing !== undefined) {
    rowTrailing = { kind: 'node', node: trailing };
  } else if (showChevron) {
    rowTrailing = { kind: 'chevron' };
  }

  // A disabled row dims by token, once, and never by row opacity: halving the
  // row lands the already-muted subtitle at 2.15:1 on the dark `bg-secondary`
  // group and 1.95:1 on the light one, so the last line of an unavailable row
  // out of reach of a user who cannot act on it. The muted ink keeps 4.53:1
  // dark and 4.62:1 light, and the icon leaves the tint's hue for the same
  // ink (4.05:1 on the tile). The tile's own low-alpha fill and border stay,
  // and the chevron, the pressed feedback and the row Pressable's
  // `accessibilityState` are what still say "unavailable".
  const iconTint: Tint = disabled ? { ...tint, hueThemeKey: 'mutedForeground' } : tint;

  let titleClassName = 'text-foreground';
  if (disabled) {
    titleClassName = 'text-muted-foreground';
  } else if (destructive) {
    titleClassName = 'text-destructive';
  }

  return (
    <RowFrame
      icon={icon}
      iconTint={iconTint}
      title={title}
      titleClassName={titleClassName}
      subtitle={
        subtitle === undefined
          ? undefined
          : { text: subtitle, numberOfLines: subtitleNumberOfLines }
      }
      subtitlePlaceholder={subtitlePlaceholder}
      trailing={rowTrailing}
      stack={stack}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      testID={testID}
      className={className}
    />
  );
}
