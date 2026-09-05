import { HStack, Image, Spacer, Text, VStack } from '@expo/ui/swift-ui';
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
} from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity, type LiveActivityComponent } from 'expo-widgets';
import { PlatformColor } from 'react-native';

import { type GlanceableLiveActivityContentState } from '@kilocode/notifications';

import { withGlanceableCopy } from './layout-copy';
import { withWidgetLogo } from './widget-logo';

/* eslint-disable new-cap -- PlatformColor is a React Native factory function, not a constructor */

// The layout function below is marked with the `'widget'` directive, so Babel
// stringifies it and the watcher extension re-evaluates the source. Everything
// it references must be a watcher global (`Text`, `VStack`, the modifiers,
// `PlatformColor`) or a built-in. Do not call `@/` helpers or i18n from here.
//
// Two values are resolved after stringification, both from literals below:
// `withWidgetLogo` swaps `__KILO_WIDGET_LOGO_URI__` for the app-group path of
// the mark, and `withGlanceableCopy` swaps `__KILO_GLANCEABLE_COPY__` for the
// translated copy. The copy is baked in rather than passed through the content
// state because the notifications Worker pushes the same raw shape and knows
// no locale.

type ContentState = Partial<GlanceableLiveActivityContentState>;

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
  // Counts draw only while the snapshot carries work. Idle is not work: a
  // session resolved elsewhere lands in `idle` and the snapshot carries the
  // `empty` status, and the surface must clear with the badge and the Agents
  // list instead of drawing the number the user just resolved. This mirrors
  // `showCounts` in the app-side builders; the pushed content state cannot
  // carry derived fields, so the layout derives them here.
  const showCounts = status === 'happy' || status === 'stale';

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
  // A zero row still draws, so the rows never reflow as work changes state —
  // but only while counts draw at all. `primary` skips the zeros: one number
  // on the Dynamic Island must be a number worth showing, and an idle-only
  // `empty` snapshot has none.
  const primary = showCounts ? (countLines.find(line => line.count > 0) ?? null) : null;
  const hasCounts = primary !== null;
  const primaryCount = count(primary === null ? 0 : primary.count);
  // Only the needs-input row carries a duration, and only the oldest wait: a
  // blocked agent is the one interval the user can act on. Working and idle
  // durations tell the user nothing they can use.
  const needsInputSince = (props.needsInput ?? 0) > 0 ? (props.needsInputSince ?? null) : null;

  // Spoken label: status word, numeric counts, then Open agents. The whole
  // surface deep-links to the agents list, so "Open agents" stays in the
  // spoken label even though no line draws it. Zeros and a resolved idle row
  // are layout anchors, not news: the spoken label keeps only the counts that
  // draw as work, the way `glanceableSpokenLabel` does in the app.
  const spokenParts = [
    ...(statusLine !== null ? [statusLine] : []),
    ...(showCounts
      ? countLines.filter(line => line.count > 0).map(line => `${line.count} ${line.label}`)
      : []),
    COPY.openAgents,
  ];
  const accessibility = spokenParts.join(', ');

  const primaryForeground = foregroundStyle(PlatformColor('label'));
  // `secondaryLabel` in both appearances: `tertiaryLabel` on the light widget
  // background left the ranked-down rows too faint to read.
  const mutedForeground = foregroundStyle(PlatformColor('secondaryLabel'));

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
  const countRow = (line: (typeof countLines)[number], isPrimary: boolean) => (
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
      {line.kind === 'needsInput' && needsInputSince !== null ? (
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
  // Island draw the same block, so one glance teaches both surfaces.
  const markAndRows = (markSize: number) => (
    <HStack alignment="center" spacing={12}>
      {logo(markSize)}
      {hasCounts ? (
        <VStack alignment="leading" spacing={5}>
          {countRows}
        </VStack>
      ) : (
        <Text modifiers={[font({ textStyle: 'subheadline' }), mutedForeground]}>{statusLine}</Text>
      )}
      <Spacer />
    </HStack>
  );

  return {
    banner: (
      <HStack
        modifiers={[
          // The banner draws to its own rounded edge, so without an inset the
          // top-left corner clips the leading content.
          padding({ all: 'default' }),
          // The widget process takes its locale from the device language, so
          // without this the relative wait would be formatted in a different
          // language than the baked labels.
          environment({ key: 'locale', value: locale }),
          accessibilityElement('combine'),
          accessibilityLabel(accessibility),
        ]}
      >
        {markAndRows(26)}
      </HStack>
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
    // take no height.
    expandedBottom: (
      <HStack
        modifiers={[
          // The island's rounded corner cuts into the leading edge, so the
          // mark needs an inset the banner gets from its own padding.
          padding({ vertical: 2, leading: 14 }),
          environment({ key: 'locale', value: locale }),
          accessibilityLabel(accessibility),
        ]}
      >
        {markAndRows(24)}
      </HStack>
    ),
  };
};

const LIVE_ACTIVITY_NAME = 'ActiveAgentsLiveActivity';

const registerLayout = () =>
  createLiveActivity<ContentState>(LIVE_ACTIVITY_NAME, withGlanceableCopy(withWidgetLogo(layout)));

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
