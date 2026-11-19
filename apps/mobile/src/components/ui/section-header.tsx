import { type ReactNode } from 'react';
import { I18nManager, Pressable, View } from 'react-native';

import { EYEBROW_LATIN_DISPLAY, Text } from '@/components/ui/text';
import { SECTION_ACTION_BOX_CLASS, SECTION_ACTION_HIT_SLOP } from '@/lib/a11y/tap-target';
import { SCREEN_GUTTER_CLASS } from '@/lib/layout';
import { cn } from '@/lib/utils';

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
  inset = false,
}: Readonly<SectionHeaderProps>) {
  const hasAction = Boolean(actionLabel && onActionPress) && !(actionHidden && notice);
  // A section label is a heading: a reader navigates a long settings screen by
  // jumping between them, and the role is what makes them jump targets.
  const labelText = (
    <Text
      variant="eyebrow"
      // With an icon the wrapper grows, so the label shrinks and truncates.
      accessibilityRole="header"
      className={cn('max-w-full', !notice && !icon && 'grow', icon && 'shrink')}
    >
      {label}
    </Text>
  );
  // With a notice the label keeps its own width, so the notice takes all the
  // free space on the line instead of an equal share of it.
  const labelNode = icon ? (
    <View className={cn('min-w-0 flex-row items-center gap-2', !notice && 'grow')}>
      {icon}
      {labelText}
    </View>
  ) : (
    labelText
  );
  return (
    // The row is one line tall — `py-2` and the eyebrow's own line — whether or
    // not it carries an action. The action's box cancels its height back to
    // that line (`SECTION_ACTION_BOX_CLASS`), so it never sets the row's height
    // and every section label sits the same distance below the block above it.
    // A box that kept its height held the label half a box further from the
    // content it names, and the same label-to-content relation then read as two
    // different spacings (section-label gap).
    //
    // The label sits on the row's content bottom edge (`items-end`) and the main
    // axis runs from the gutter, so the label keeps the line's start whatever it
    // grows to; the action takes the free space in front of itself (`ms-auto`)
    // instead of the row packing its lines to the end.
    <View className={cn('flex-row flex-wrap items-end gap-2 py-2', inset && SCREEN_GUTTER_CLASS)}>
      {labelNode}
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
          // reads the node's own rect and `hitSlop` never widens it. The box is
          // symmetric about the row's line — its negative margins cancel the
          // 28 dp box down to the label's line — so its copy centres on the
          // section label while the row stays one line tall. The hidden action
          // keeps the same box, so hiding it still cannot resize the header.
          hitSlop={SECTION_ACTION_HIT_SLOP}
          className={cn(
            SECTION_ACTION_BOX_CLASS,
            // The row's main axis starts at the gutter, so the label always
            // begins there; this box takes the free space in front of it instead
            // of the row packing every line to its end (the wide-window
            // "CATEGORIES" / "PERSONAL" labels that sat at the right edge,
            // 2026-11-18). On a wrapped line the auto margin still puts the
            // action on that line's end, never at its start.
            'ms-auto max-w-full shrink-0 flex-row items-center justify-center active:opacity-70',
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
