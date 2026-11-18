import { type ReactNode } from 'react';
import { I18nManager, Pressable, View } from 'react-native';

import { EYEBROW_LATIN_DISPLAY, Text } from '@/components/ui/text';
import {
  SECTION_ACTION_BOX_CLASS,
  SECTION_ACTION_HIT_SLOP,
  SECTION_HEADER_ROW_PADDING_CLASS,
  textActionTargetClass,
} from '@/lib/a11y/tap-target';
import { SCREEN_GUTTER_CLASS } from '@/lib/layout';
import { cn } from '@/lib/utils';

/**
 * The box a section label sits at the bottom of. It is as tall as the compact
 * action box, so every section header has one height and keeps one gap to the
 * block above it.
 */
export const SECTION_LABEL_AIR_CLASS = 'min-h-[28px]';

type SectionHeaderProps = {
  label: string;
  /**
   * Optional glyph before the label, on the label's own line — the Inbox and
   * Recent marks a full-bleed list leads each of its eyebrows with. It carries
   * no label of its own: the `label` names the section.
   */
  icon?: ReactNode;
  /**
   * Optional link at the row's outer edge (physical right in LTR, physical left
   * in RTL), e.g. "SEE ALL".
   */
  actionLabel?: string;
  onActionPress?: () => void;
  /**
   * Test handle for the action control itself, for a native E2E script that
   * taps the section's link.
   */
  actionTestID?: string;
  /**
   * Keeps the action's box but makes it invisible, inert and hidden from
   * screen readers, so hiding it cannot change the header's size. Beside a
   * notice the hidden box is dropped instead: it would hold the notice off the
   * row edge, over empty space.
   */
  actionHidden?: boolean;
  /**
   * Keeps the action visible and its box unchanged, but makes it inert, dims
   * its ink to the muted role and announces it disabled — the look a write in
   * flight leaves on the control it will enable. Unlike `actionHidden` it stays
   * in the accessibility tree, so the reader hears why the action does not
   * respond.
   */
  actionDisabled?: boolean;
  /**
   * Optional status between the label and the action. It takes only the free
   * space on the label's line (zero basis), so it never pushes the action off
   * the row; a long message wraps inside the slot instead of clipping, which
   * grows the header by the wrapped line. A divider separates it from a
   * visible action. Pass null while there is nothing to report.
   */
  notice?: ReactNode;
  /**
   * Puts the label at the bottom of {@link SECTION_LABEL_AIR_CLASS} and renders the
   * action on the compact {@link SECTION_ACTION_BOX_CLASS} box, with
   * {@link SECTION_HEADER_ROW_PADDING_CLASS} on the row to hold the action's hit
   * slop. A row with an action and a row without one then have the same height,
   * so every section keeps the same gap to the block above it.
   */
  reserveLabelAir?: boolean;
  /**
   * Draws the page gutter. A section label inside a padded body keeps none of
   * its own; a full-bleed list (its rows reach the screen edge) passes this so
   * the label lines up with the rows it names.
   */
  inset?: boolean;
};

export function SectionHeader({
  label,
  icon,
  actionLabel,
  onActionPress,
  actionTestID,
  actionHidden = false,
  actionDisabled = false,
  notice,
  reserveLabelAir = false,
  inset = false,
}: Readonly<SectionHeaderProps>) {
  const hasAction = Boolean(actionLabel && onActionPress) && !(actionHidden && notice);
  // With a notice the label keeps its own width, so the notice takes all the
  // free space on the line instead of an equal share of it.
  const labelText = (
    <Text
      variant="eyebrow"
      // A section label is a heading: a reader navigates a long settings screen
      // by jumping between them, and the role is what makes them jump targets.
      // With an icon the wrapper grows, so the label shrinks and truncates.
      accessibilityRole="header"
      className={cn('max-w-full', !reserveLabelAir && !notice && !icon && 'grow', icon && 'shrink')}
    >
      {label}
    </Text>
  );
  const labelNode = icon ? (
    <View
      className={cn('min-w-0 flex-row items-center gap-2', !reserveLabelAir && !notice && 'grow')}
    >
      {icon}
      {labelText}
    </View>
  ) : (
    labelText
  );
  return (
    // The label sits on the row's content bottom edge (`items-end`), not on its
    // vertical centre. An action's touch box is 48 dp tall while the label is
    // one 11 px line, so a centred row holds the label 17 dp above the rows and
    // cards it names — twice the gap a header without an action has — and the
    // same label-to-content relation then reads as two different spacings
    // (section-label gap). The box still sets the row's height, so the air
    // sits above the line instead of between the label and its content, which
    // is the header's own `pb-2` everywhere.
    //
    // The main axis runs from the gutter, so the label keeps the line's start
    // whatever it grows to; the action takes the free space in front of itself
    // (`ms-auto`) instead of the row packing its lines to the end.
    //
    // With `reserveLabelAir` the label and the action share one compact box
    // height, and the row's padding holds the action's hit slop inside the row,
    // so every full-bleed section header has one height.
    <View
      className={cn(
        'flex-row flex-wrap items-end gap-2',
        inset && SCREEN_GUTTER_CLASS,
        reserveLabelAir ? SECTION_HEADER_ROW_PADDING_CLASS : 'py-2'
      )}
    >
      {/* With a notice the label keeps its own width, so the notice takes all
          the free space on the line instead of an equal share of it. */}
      {reserveLabelAir ? (
        <View className={cn('flex-col justify-end', !notice && 'grow', SECTION_LABEL_AIR_CLASS)}>
          {labelNode}
        </View>
      ) : (
        labelNode
      )}
      {notice ? (
        <View className="min-w-0 shrink grow basis-0 flex-row items-center justify-end gap-2">
          {notice}
        </View>
      ) : null}
      {notice && hasAction ? <View className="h-3 w-px self-center bg-border" /> : null}
      {hasAction ? (
        <Pressable
          testID={actionTestID}
          onPress={onActionPress}
          disabled={actionHidden || actionDisabled}
          accessibilityRole={actionHidden ? undefined : 'button'}
          accessibilityLabel={actionHidden ? undefined : actionLabel}
          accessibilityState={actionDisabled ? { disabled: true } : undefined}
          accessibilityElementsHidden={actionHidden}
          importantForAccessibility={actionHidden ? 'no-hide-descendants' : undefined}
          // This box lands on the row's outer edge through `ms-auto`: the
          // physical right in LTR, the physical left in RTL, because the auto
          // margin is direction-relative. A wrapped line keeps that placement
          // too — when a long label pushes this box onto the next line, the auto
          // margin takes that line's free space, so it sits at the row end
          // rather than the margin it wrapped away from. It must NOT grow: when
          // both children grew the row split in half, and the action then sat at
          // the inner edge of its half (the screen centre in Arabic), so it
          // never reached the margin while the tab bar, cards and rows below
          // were fully mirrored (home-arabic-rtl, home). Never a physical
          // `text-left`/`text-right`: React Native swaps those two under RTL
          // (Android maps `textAlign: 'left'` to `Gravity.RIGHT` when the layout
          // is RTL).
          // The frame is the box, not the 11px label line: a control-size audit
          // reads the node's own rect and `hitSlop` never widens it. The row
          // grows to hold the frame — RN stops delivering touches outside the
          // parent, so a shrunk layout box would leave part of the target dead
          // (`textActionTargetClass`, `comment-row.tsx`). With `reserveLabelAir`
          // the box is the compact one, and its hit slop stays inside the row's
          // own padding. The hidden action keeps the same box, so hiding it
          // still cannot resize the header.
          // Its copy sits on the box's bottom edge (`items-end`, the row's own
          // cross-axis rule), so the action and the section label share one
          // baseline instead of the action holding the label half a box away
          // from the content it names.
          hitSlop={reserveLabelAir ? SECTION_ACTION_HIT_SLOP : undefined}
          className={cn(
            reserveLabelAir ? SECTION_ACTION_BOX_CLASS : textActionTargetClass(),
            // The row's main axis starts at the gutter, so the label always
            // begins there; this box takes the free space in front of it instead
            // of the row packing every line to its end (the wide-window
            // "CATEGORIES" / "PERSONAL" labels that sat at the right edge,
            // 2026-11-18). On a wrapped line the auto margin still puts the
            // action on that line's end, never at its start.
            'ms-auto max-w-full shrink-0 flex-row items-end justify-center active:opacity-70',
            actionHidden && 'opacity-0'
          )}
        >
          <Text
            className={cn(
              'shrink font-mono-medium text-[11px]',
              // The muted ink is the disabled read; the enabled action keeps the
              // accent at full strength, so only it reads ready.
              actionDisabled ? 'text-muted-foreground' : 'text-primary',
              // LTR-only: the letterspaced capitals break a cursive script's
              // joins, so an RTL action label drops them (home-ar-loading).
              // The class string is the eyebrow variant's, so the two labels
              // cannot drift apart.
              !I18nManager.isRTL && EYEBROW_LATIN_DISPLAY
            )}
          >
            {actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
