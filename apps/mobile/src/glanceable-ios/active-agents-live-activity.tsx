import { HStack, Image, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityElement,
  accessibilityLabel,
  cornerRadius,
  font,
  foregroundStyle,
  frame,
  monospacedDigit,
  multilineTextAlignment,
  padding,
  resizable,
} from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity, type LiveActivityComponent } from 'expo-widgets';
import { PlatformColor } from 'react-native';

import { type GlanceableLiveActivityContentState } from '@kilocode/notifications';

import { withWidgetLogo } from './widget-logo';

/* eslint-disable new-cap -- PlatformColor is a React Native factory function, not a constructor */

// The layout function below is marked with the `'widget'` directive, so Babel
// stringifies it and the watcher extension re-evaluates the source. Everything
// it references must be a watcher global (`Text`, `VStack`, the modifiers,
// `PlatformColor`) or a built-in. Do not call `@/` helpers or i18n from here.
// The server pushes raw counts + status (it cannot translate), and the
// foreground app passes the same raw shape, so the inlined English copy below
// is the single producer of the displayed Live Activity copy.
//
// The one value resolved after stringification is the `__KILO_WIDGET_LOGO_URI__`
// literal below: `withWidgetLogo` swaps it for the app-group path of the mark.

type ContentState = Partial<GlanceableLiveActivityContentState>;

// Babel replaces the annotated arrow with its source string, so `layout` is a
// string at runtime while TypeScript still checks it as a component — the same
// shape `expo-widgets` casts internally.
const layout: LiveActivityComponent<ContentState> = (props, environment) => {
  'widget';

  const dark = environment.colorScheme === 'dark';

  const status = props.status ?? 'empty';
  const STATUS_LINE = {
    waiting: 'Updating agents',
    empty: 'No work in progress',
    stale: "Can't update now",
    expired: 'Status expired',
    signed_out: 'Sign in to see agents',
    privacy: 'Agents hidden',
  } as const;
  const statusLine = status === 'happy' ? null : STATUS_LINE[status];

  // Rank order: what the user must act on, then what is making progress, then
  // what is only connected. The Dynamic Island shows one number, so this
  // ranking decides what a glance says. The glyphs differ in shape as well as
  // color (exclamation / filled / hollow) so the state reads without color.
  const countLines = (
    [
      {
        label: 'Needs input',
        count: props.needsInput ?? 0,
        icon: 'exclamationmark.circle.fill',
        color: PlatformColor('systemOrange'),
      },
      {
        label: 'Working',
        count: props.running ?? 0,
        icon: 'circle.fill',
        color: PlatformColor('systemGreen'),
      },
      {
        label: 'Idle',
        count: props.idle ?? 0,
        icon: 'circle',
        color: PlatformColor('label'),
      },
    ] as const
  ).filter(line => line.count > 0);
  const hasCounts = countLines.length > 0;
  const primary = countLines[0] ?? null;
  const primaryCount = String(primary === null ? 0 : primary.count);
  // Elapsed time shows while any count exists, including the stale status, so
  // the work keeps its elapsed timer when updates stop.
  const elapsedAnchor = hasCounts ? (props.eligibleStartedAt ?? null) : null;

  // Spoken label: status word, numeric counts, then Open agents. The whole
  // surface deep-links to the agents list, so "Open agents" stays in the
  // spoken label even though no line draws it.
  const spokenParts = [
    ...(statusLine !== null ? [statusLine] : []),
    ...countLines.map(line => `${line.count} ${line.label}`),
    'Open agents',
  ];
  const accessibility = spokenParts.join(', ');

  const primaryForeground = foregroundStyle(PlatformColor('label'));
  const mutedForeground = foregroundStyle(
    dark ? PlatformColor('secondaryLabel') : PlatformColor('tertiaryLabel')
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
  // without color), a fixed-width count, then the label. The first row is
  // emphasised so a glance lands on it.
  const countRow = (line: (typeof countLines)[number], isPrimary: boolean) => (
    <HStack key={line.label} alignment="center" spacing={6}>
      <Image systemName={line.icon} color={line.color} size={isPrimary ? 14 : 12} />
      <Text
        modifiers={[
          font({ textStyle: isPrimary ? 'headline' : 'subheadline', weight: 'semibold' }),
          monospacedDigit(),
          primaryForeground,
        ]}
      >
        {String(line.count)}
      </Text>
      <Text
        modifiers={[
          font({ textStyle: 'subheadline' }),
          isPrimary ? primaryForeground : mutedForeground,
        ]}
      >
        {line.label}
      </Text>
    </HStack>
  );

  const countRows = countLines.map((line, index) => countRow(line, index === 0));

  const elapsed =
    elapsedAnchor === null ? null : (
      <Text
        date={new Date(elapsedAnchor)}
        dateStyle="relative"
        modifiers={[
          font({ textStyle: 'caption' }),
          monospacedDigit(),
          mutedForeground,
          // A relative-date Text reserves width for the longest string it could
          // ever show, so without this the timer sits far left of its own frame.
          multilineTextAlignment('trailing'),
        ]}
      />
    );

  return {
    banner: (
      <HStack
        alignment="center"
        spacing={10}
        modifiers={[
          // The banner draws to its own rounded edge, so without an inset the
          // top-left corner clips the leading content.
          padding({ all: 'default' }),
          accessibilityElement('combine'),
          accessibilityLabel(accessibility),
        ]}
      >
        {logo(22)}
        {hasCounts ? (
          <VStack alignment="leading" spacing={3}>
            {countRows}
          </VStack>
        ) : (
          <Text modifiers={[font({ textStyle: 'subheadline' }), mutedForeground]}>
            {statusLine}
          </Text>
        )}
        <Spacer />
        {elapsed}
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
    expandedLeading: (
      <VStack alignment="leading" spacing={3} modifiers={[accessibilityLabel(accessibility)]}>
        {countRows}
      </VStack>
    ),
    expandedTrailing: (
      <VStack alignment="trailing" spacing={3} modifiers={[accessibilityLabel(accessibility)]}>
        {statusLine !== null && hasCounts ? (
          <Text modifiers={[font({ textStyle: 'caption' }), mutedForeground]}>{statusLine}</Text>
        ) : null}
        {elapsed}
      </VStack>
    ),
    expandedBottom: (
      <HStack alignment="center" spacing={8} modifiers={[accessibilityLabel(accessibility)]}>
        {logo(16)}
        {statusLine !== null && !hasCounts ? (
          <Text modifiers={[font({ textStyle: 'subheadline' }), mutedForeground]}>
            {statusLine}
          </Text>
        ) : null}
        <Spacer />
      </HStack>
    ),
  };
};

export const ActiveAgentsLiveActivity = createLiveActivity<ContentState>(
  'ActiveAgentsLiveActivity',
  withWidgetLogo(layout)
);
