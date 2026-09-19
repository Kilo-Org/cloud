import { Button, HStack, Image, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityElement,
  accessibilityLabel,
  allowsTightening,
  cornerRadius,
  environment,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  minimumScaleFactor,
  monospacedDigit,
  padding,
  resizable,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity, type LiveActivityComponent } from 'expo-widgets';
import { PlatformColor } from 'react-native';

import { type GlanceableLiveActivityContentState } from '@kilocode/notifications';

import { withGlanceableCopy } from './layout-copy';
import { withWidgetLogo } from './widget-logo';

/* eslint-disable new-cap -- PlatformColor is a React Native factory function, not a constructor */

// The layout function below is marked with the `'widget'` directive, so Babel
// stringifies it and the watcher extension re-evaluates the source. Everything
// it references must be a watcher global (`Text`, `VStack`, `Button`, the
// modifiers, `PlatformColor`) or a built-in. Do not call `@/` helpers or i18n
// from here.
//
// Two values are resolved after stringification, both from literals below:
// `withWidgetLogo` swaps `__KILO_WIDGET_LOGO_URI__` for the app-group path of
// the mark, and `withGlanceableCopy` swaps `__KILO_GLANCEABLE_COPY__` for the
// translated copy. The copy is baked in rather than passed through the content
// state because the notifications Worker pushes the same raw shape and knows
// no locale.

// The pushed content state plus the two facts the widget extension cannot
// derive: whether the recorded ask is one Approve can answer, and the failure
// line a retryable Approve left on the card. They stay local fields rather than
// imports from `./view-props`, because Babel stringifies this function's source
// and every imported binding would be an undefined global in the widget
// process.
type ContentState = Partial<GlanceableLiveActivityContentState> & {
  canApprove?: boolean;
  notice?: string;
};

// Babel replaces the annotated arrow with its source string, so `layout` is a
// string at runtime while TypeScript still checks it as a component — the same
// shape `expo-widgets` casts internally.
const layout: LiveActivityComponent<ContentState> = props => {
  'widget';

  // The literal, not the imported constant: the widget transform stringifies
  // this function's source, so an imported binding would be an undefined
  // global in the widget process. `withGlanceableCopy` replaces the token,
  // quotes included, with the translated copy as a JSON source literal.
  // eslint-disable-next-line typescript-eslint/no-inferrable-types -- see above
  const copySource: string = '__KILO_GLANCEABLE_COPY__';
  const COPY = JSON.parse(copySource) as Record<string, string>;
  // The tag SwiftUI formats the relative wait with; English when the bake is
  // somehow missing it, which is what the widget process would have used anyway.
  const locale = COPY.locale ?? 'en';

  // The counts are stringified here, not formatted: a pushed content state
  // carries raw numbers and this process has no formatter. `COPY.digits` is the
  // language's own ten, empty when it writes them the way `String` already
  // does, so an Arabic count reads "١" beside the "٢٦ د" SwiftUI formats.
  const digits = COPY.digits ?? '';
  const count = (value: number) =>
    digits.length === 10
      ? // eslint-disable-next-line unicorn/prefer-spread -- `replaceAll` and a spread both failed in the widget process; this form is the one verified on device
        String(value)
          .split('')
          .map(character => digits[Number(character)] ?? character)
          .join('')
      : String(value);

  const status = props.status ?? 'empty';
  const statusLine = status === 'happy' ? null : COPY[status];

  // Rank order: what the user must act on, then what is making progress, then
  // what is only connected. The Dynamic Island shows one number, so this
  // ranking decides what a glance says. The glyphs differ in shape as well as
  // color (exclamation / filled / hollow) so the state reads without color.
  const countLines = [
    {
      kind: 'needsInput',
      label: COPY.needsInput,
      count: props.needsInput ?? 0,
      icon: 'exclamationmark.circle.fill',
      color: PlatformColor('systemOrange'),
    },
    {
      kind: 'running',
      label: COPY.running,
      count: props.running ?? 0,
      icon: 'circle.fill',
      color: PlatformColor('systemGreen'),
    },
    {
      kind: 'idle',
      label: COPY.idle,
      count: props.idle ?? 0,
      icon: 'circle',
      color: PlatformColor('label'),
    },
    // `as const` keeps each `icon` an SF Symbol literal, which the Image prop
    // type requires.
  ] as const;
  // A zero row still draws, so the rows never reflow as work changes state.
  // `primary` skips the zeros: one number on the Dynamic Island must be a
  // number worth showing.
  const primary = countLines.find(line => line.count > 0) ?? null;
  const hasCounts = primary !== null;
  const primaryCount = count(primary === null ? 0 : primary.count);
  // Only the needs-input row carries a duration, and only the oldest wait: a
  // blocked agent is the one interval the user can act on. Working and idle
  // durations tell the user nothing they can use.
  const needsInputSince = (props.needsInput ?? 0) > 0 ? (props.needsInputSince ?? null) : null;
  // Approval is offered only while an ask actually waits and the app recorded
  // one Approve can answer: an Approve that cannot answer anything is a dead
  // control, and a card whose ask was just answered elsewhere would keep
  // offering the tap that answered it. `needsInput` counts questions and
  // retried asks too, so the wait count alone must not offer a control that
  // cannot act; the pushed `needsApproval` — the `permission` rows, the one
  // wait the user can clear without choosing an option — narrows it. That
  // narrower count is also what stands in when the app wrote no flag, which is
  // every state that arrived over APNs: a question-only server state then
  // offers Open alone instead of a tap the press answers with `none`, while a
  // `permission` server state still offers the tap the app-closed press
  // answers. `withStatus` zeroes the wait count on expiry but leaves
  // `needsApproval` standing, so the wait term is what keeps the retained
  // expired frame gateless. The phone `actions` and the watch `bannerSmall`
  // control share this one gate, so each offers exactly the tap its own press
  // can answer.
  const canApprove =
    (props.needsInput ?? 0) > 0 && (props.needsApproval ?? 0) > 0 && props.canApprove !== false;

  // The failure line a retryable Approve left on the card. The app sets it in
  // the content state, because this process cannot translate; a server-written
  // state and a card whose ask changed carry none, and the line then draws
  // nothing at all.
  const notice = props.notice ?? null;

  // Spoken label: status word, numeric counts, then Open agents. The whole
  // surface deep-links to the agents list, so "Open agents" stays in the
  // spoken label even though no line draws it.
  const spokenParts = [
    ...(statusLine !== null ? [statusLine] : []),
    ...countLines.map(line => `${line.count} ${line.label}`),
    COPY.openAgents,
  ];
  const accessibility = spokenParts.join(', ');

  const primaryForeground = foregroundStyle(PlatformColor('label'));
  // `secondaryLabel` in both appearances: `tertiaryLabel` on the light widget
  // background left the ranked-down rows too faint to read.
  const mutedForeground = foregroundStyle(PlatformColor('secondaryLabel'));

  // The failure line, drawn on its own full-width row under the counts so the
  // whole banner width carries it: inside the count block it would have to fit
  // between the mark and the buttons, which shrinks a reviewed sentence past
  // reading. Orange, the color of the Approve button the notice asks the user
  // to tap again. Nothing to draw when no press failed.
  const noticeLine =
    notice === null ? null : (
      <Text
        modifiers={[
          font({ textStyle: 'footnote', weight: 'semibold' }),
          // The line stays one row: the banner grows once for the notice and
          // never reflows again as the copy changes language.
          lineLimit(1),
          minimumScaleFactor(0.6),
          allowsTightening(true),
          foregroundStyle(PlatformColor('systemOrange')),
        ]}
      >
        {notice}
      </Text>
    );

  // The literal, not the imported constant: the widget transform stringifies
  // this function's source, so an imported binding would be an undefined global
  // in the widget process. It must stay equal to `WIDGET_LOGO_PLACEHOLDER`, which
  // `withWidgetLogo` replaces with the app-group path.
  // The annotation widens the literal: the token is replaced after this file is
  // stringified, so the empty-path branch below is reachable at runtime.
  // eslint-disable-next-line typescript-eslint/no-inferrable-types -- see above
  const logoUri: string = '__KILO_WIDGET_LOGO_URI__';
  const logo = (size: number) =>
    logoUri.length === 0 ? null : (
      <Image
        uiImage={logoUri}
        modifiers={[resizable(), frame({ width: size, height: size }), cornerRadius(size * 0.24)]}
      />
    );

  // One row per non-zero state: a colored glyph carries the state (readable
  // without color), a fixed-width count, then the label. Every row shares one
  // type size so the counts line up on a grid; only the label dims to rank
  // them, because a second font size in a two-line banner reads as a mistake.
  // `showWait` is false for the small family, which draws one line and keeps
  // the relative wait off it; the phone banner and the expanded island keep it.
  const countRow = (line: (typeof countLines)[number], isPrimary: boolean, showWait = true) => (
    <HStack key={line.label} alignment="center" spacing={7}>
      <Image systemName={line.icon} color={line.color} size={13} />
      <Text
        modifiers={[
          font({ textStyle: 'subheadline', weight: 'semibold' }),
          monospacedDigit(),
          // The number is the whole point of the row, so it takes its space
          // first. Without the priority a long label squeezed it to nothing
          // and the row drew a glyph and a word with no count.
          layoutPriority(1),
          primaryForeground,
        ]}
      >
        {count(line.count)}
      </Text>
      <Text
        modifiers={[
          font({ textStyle: 'subheadline' }),
          // The label carries the meaning, so it shrinks and tightens rather
          // than truncating: a German or Albanian label wrapped to two lines
          // otherwise, which broke the row grid the three counts read on. Do
          // not add `truncationMode` here — it suppresses the scaling and the
          // label truncates again. Tail is the default.
          lineLimit(1),
          minimumScaleFactor(0.6),
          allowsTightening(true),
          isPrimary ? primaryForeground : mutedForeground,
        ]}
      >
        {line.label}
      </Text>
      {showWait && line.kind === 'needsInput' && needsInputSince !== null ? (
        <Text
          date={new Date(needsInputSince)}
          dateStyle="relative"
          modifiers={[
            font({ textStyle: 'subheadline' }),
            monospacedDigit(),
            // The relative style picks its own unit count per surface: one
            // unit in the banner, two in the expanded island. A fixed width
            // cannot force the short form — it only truncates it — so the
            // text keeps its natural width.
            lineLimit(1),
            mutedForeground,
          ]}
        />
      ) : null}
    </HStack>
  );

  // The emphasised row is the ranked primary, not the first row: with zeros
  // drawn the first row is often a 0, and emphasising that would point the
  // user at the state with nothing in it.
  const countRows = countLines.map(line => countRow(line, line === primary));

  // The mark, then the rows. The Lock Screen banner and the expanded Dynamic
  // Island draw the same block, so one glance teaches both surfaces. The spoken
  // label is combined onto this block rather than the whole surface, because
  // the action buttons after it are their own elements: a combined container
  // would swallow the two taps into the count label. The Apple Watch and CarPlay
  // draw the `bannerSmall` section instead: their activity family is `.small`,
  // so they get one compact row plus the watch control rather than this block.
  const markAndRows = (markSize: number) => (
    <HStack
      alignment="center"
      spacing={12}
      modifiers={[accessibilityElement('combine'), accessibilityLabel(accessibility)]}
    >
      {logo(markSize)}
      {/* The combined label sits on the counts/status block alone, the way the
          watch `bannerSmall` scopes it to its count row, so the action buttons
          after this block stay separate, focusable elements. `combine` on the
          whole row merged the control into one element whose spoken label named
          only the counts and "Open agents", which is how the Lock Screen banner
          lost the action for VoiceOver. */}
      <HStack
        alignment="center"
        spacing={7}
        modifiers={[accessibilityElement('combine'), accessibilityLabel(accessibility)]}
      >
        {hasCounts ? (
          <VStack alignment="leading" spacing={5}>
            {countRows}
          </VStack>
        ) : (
          <Text modifiers={[font({ textStyle: 'subheadline' }), mutedForeground]}>
            {statusLine}
          </Text>
        )}
      </HStack>
      <Spacer />
    </HStack>
  );

  // The two action buttons, on the surfaces with room: the Lock Screen banner
  // and the expanded Dynamic Island. The compact presentations keep the count
  // alone — two tappable controls in the leading/trailing slots would crowd
  // the one number a glance reads — so the buttons sit exactly where the counts
  // are drawn in full.
  //
  // `target` is the stable id the press reports back; the app's listener routes
  // it. The literals must stay equal to the targets in `interaction.ts`, which
  // `active-agents-live-activity.test.ts` holds them to.
  //
  // A `Button` with `label` + `systemImage`, not an icon child: this process
  // has no React context and no SVG renderer, so the theme tokens reach it as
  // `PlatformColor` — the same values the count rows use — and the glyphs are
  // SF Symbols, the set the count rows already draw. Approve carries the
  // needs-input orange of the row it answers; Open takes the label color.
  //
  // The Open tap has to show the user the session, and a Live Activity button's
  // intent performs in the app's process without foregrounding it: unattended,
  // the tap records a destination on a surface nobody is looking at.
  // `openAppWhenRun` selects the foregrounding intent in the patched
  // expo-widgets button view, so the app is up to consume that destination. It
  // is a prop of that view, not of `@expo/ui`'s `Button`, so it travels as the
  // plain extra prop the widget process serialises with the rest.
  const openButtonProps = { openAppWhenRun: true };
  const actions = (
    <HStack alignment="center" spacing={10}>
      {canApprove ? (
        <Button
          target="approve"
          label={COPY.approve}
          systemImage="checkmark.circle"
          modifiers={[tint(PlatformColor('systemOrange'))]}
        />
      ) : null}
      <Button
        {...openButtonProps}
        target="open"
        label={COPY.open}
        systemImage="arrow.up.forward.app"
        modifiers={[tint(PlatformColor('label'))]}
      />
    </HStack>
  );

  return {
    banner: (
      <VStack
        spacing={6}
        modifiers={[
          // The banner draws to its own rounded edge, so without an inset the
          // top-left corner clips the leading content.
          padding({ all: 'default' }),
          // The widget process takes its locale from the device language, so
          // without this the relative wait would be formatted in a different
          // language than the baked labels.
          environment({ key: 'locale', value: locale }),
        ]}
      >
        <HStack>
          {markAndRows(26)}
          {actions}
        </HStack>
        {noticeLine}
      </VStack>
    ),
    // The Apple Watch and CarPlay small family draws this section, not the
    // phone `banner`: expo-widgets' banner view prefers the `bannerSmall` node
    // whenever the activity family is `.small`, falling back to `banner`
    // otherwise, so the phone Lock Screen and Dynamic Island never read it. One
    // compact row plus the Approve control, so the wait count and the wrist
    // control fit the small region instead of the phone's stacked block. The
    // ranked primary row only — the small family draws one line — and no
    // relative wait: the medium banner and the accessory rectangle carry it. The
    // trailing Spacer pins the row to the leading edge, so the count keeps its
    // place when the control appears and disappears, the way the phone block is
    // spaced; the row draws unconditionally, and only the control is gated, by
    // the same `canApprove` the phone block uses. The notice has a reserved row
    // below, so a failed press cannot move the count or its retry control.
    bannerSmall: (
      <VStack alignment="leading" spacing={6}>
        <HStack alignment="center" spacing={10}>
          <HStack
            alignment="center"
            spacing={7}
            modifiers={[
              // The combined label sits on the count row alone, so VoiceOver on
              // the watch can still focus and activate the Approve button
              // separately.
              accessibilityElement('combine'),
              accessibilityLabel(accessibility),
            ]}
          >
            {hasCounts ? (
              countRow(primary, true, false)
            ) : (
              <Text modifiers={[font({ textStyle: 'subheadline' }), mutedForeground]}>
                {statusLine}
              </Text>
            )}
          </HStack>
          {canApprove ? (
            // The target is the literal, not the imported `APPROVE_TARGET`: this
            // function's source is stringified and re-evaluated in the widget
            // process, where an imported binding is an undefined global.
            // `layout-copy.test.ts` keeps it equal to the constant the interaction
            // handler matches.
            <Button label={COPY.approve} target="approve" />
          ) : null}
          <Spacer />
        </HStack>
        <VStack modifiers={[frame({ height: 18 })]}>{noticeLine}</VStack>
      </VStack>
    ),
    // The Dynamic Island's leading slot is the app-identity slot, so it holds
    // the Kilo mark; the trailing slot carries the ranked count.
    compactLeading: <HStack modifiers={[accessibilityLabel(accessibility)]}>{logo(18)}</HStack>,
    // One number, colored by the state it counts: orange needs input, green
    // working, white idle.
    compactTrailing: (
      <Text
        modifiers={[
          font({ textStyle: 'title3', weight: 'bold' }),
          monospacedDigit(),
          primary === null ? mutedForeground : foregroundStyle(primary.color),
          accessibilityLabel(accessibility),
        ]}
      >
        {hasCounts ? primaryCount : ''}
      </Text>
    ),
    minimal: (
      <Text
        modifiers={[
          font({ textStyle: 'headline', weight: 'bold' }),
          monospacedDigit(),
          primary === null ? mutedForeground : foregroundStyle(primary.color),
          accessibilityLabel(accessibility),
        ]}
      >
        {hasCounts ? primaryCount : ''}
      </Text>
    ),
    // The whole expanded island is the bottom region: it is the only one wide
    // enough for a labelled row, and it clears the rounded corners that clip
    // the flanking regions. The leading and trailing regions stay empty and
    // take no height. The row carries its own combined label on the count block
    // and none sits here, so the Approve control inside it stays focusable
    // instead of being merged into the island's spoken label.
    expandedBottom: (
      <VStack
        spacing={6}
        modifiers={[
          // The island's rounded corner cuts into the leading edge, so the
          // mark needs an inset the banner gets from its own padding. The
          // trailing edge needs the same inset now that the buttons end there.
          padding({ vertical: 2, leading: 14, trailing: 14 }),
          environment({ key: 'locale', value: locale }),
        ]}
      >
        <HStack>
          {markAndRows(24)}
          {actions}
        </HStack>
        {noticeLine}
      </VStack>
    ),
  };
};

/**
 * The Live Activity's registered name: the native activity type, the key the
 * layout is stored under, and the name a widget-style press would report as its
 * source. Exported because the app's interaction listener has to recognise a
 * press from this surface without repeating the literal.
 */
export const LIVE_ACTIVITY_NAME = 'ActiveAgentsLiveActivity';

/**
 * The whole surface deep-links here, and registration persists it. A
 * push-to-start creates the activity with no JavaScript running, so a URL
 * supplied only at `start` would leave a remotely started card untappable.
 */
export const OPEN_AGENTS_URL = 'kiloapp:///cloud/sessions';

const registerLayout = () =>
  createLiveActivity<ContentState>(
    LIVE_ACTIVITY_NAME,
    withGlanceableCopy(withWidgetLogo(layout)),
    OPEN_AGENTS_URL
  );

export const ActiveAgentsLiveActivity = registerLayout();

/**
 * Re-bake the stored layout in the active language.
 *
 * Constructing the factory only writes the layout into the shared app group,
 * and the name identifies the native Live Activity type, so the fresh factory
 * is discarded and `ActiveAgentsLiveActivity` stays the handle. The app boots
 * in English and applies the stored language afterwards, so this runs once the
 * language settles as well as on every later change.
 */
export function refreshActiveAgentsLiveActivityCopy(): void {
  registerLayout();
}
