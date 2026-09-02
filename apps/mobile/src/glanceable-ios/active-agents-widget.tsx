import { HStack, Image, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityElement,
  accessibilityLabel,
  allowsTightening,
  containerBackground,
  cornerRadius,
  environment,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  minimumScaleFactor,
  monospacedDigit,
  resizable,
  widgetURL,
} from '@expo/ui/swift-ui/modifiers';
import { createWidget, type WidgetEnvironment } from 'expo-widgets';
import { PlatformColor } from 'react-native';

import { withGlanceableCopy } from './layout-copy';
import { type GlanceableViewProps } from './view-props';
import { withWidgetLogo } from './widget-logo';

/* eslint-disable new-cap -- PlatformColor is a React Native factory function, not a constructor */

// The layout function below is marked with the `'widget'` directive, so Babel
// stringifies it and the widget extension re-evaluates the source. Everything
// it references must be a widget global (`Text`, `VStack`, the modifiers,
// `PlatformColor`) or a built-in. Do not call `@/` helpers or i18n from here —
// translated copy arrives through `props`, and the gallery placeholder (which
// has no props) falls back to the baked copy below.
//
// Two values are resolved after stringification, both from literals below:
// `withWidgetLogo` swaps `__KILO_WIDGET_LOGO_URI__` for the app-group path of
// the mark, and `withGlanceableCopy` swaps `__KILO_GLANCEABLE_COPY__` for the
// translated copy.

type WidgetProps = Partial<GlanceableViewProps>;

// Babel replaces the annotated arrow with its source string, so `layout` is a
// string at runtime while TypeScript still checks it as a component.
const layout: (props: WidgetProps, widgetEnvironment: WidgetEnvironment) => React.JSX.Element = (
  props,
  widgetEnvironment
) => {
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

  const family = widgetEnvironment.widgetFamily;
  const counts = props.countLines ?? [];
  const primaryLabel = props.primaryLabel ?? null;
  const primaryKind = props.primaryKind ?? null;
  // Only the medium row is wide enough for a wait beside the label; in the
  // small square the pair wraps and truncates both halves.
  const wide = family === 'systemMedium';
  const needsInputSince = props.needsInputSince ?? null;
  // The rows carry zeros too, so their number never says whether work exists —
  // the ranked primary does, because it is null only when every count is zero.
  const hasCounts = primaryKind !== null;
  const primaryCount = props.primaryCount ?? 0;
  const statusLine = props.statusLine ?? (hasCounts ? null : COPY.empty);

  // Circle-based glyphs whose shapes differ as well as their colors, because
  // the Lock Screen families render in an accented mode that flattens tint.
  const GLYPH = {
    needsInput: { icon: 'exclamationmark.circle.fill', color: PlatformColor('systemOrange') },
    running: { icon: 'circle.fill', color: PlatformColor('systemGreen') },
    idle: { icon: 'circle', color: PlatformColor('label') },
  } as const;

  const primaryForeground = foregroundStyle(PlatformColor('label'));
  // `secondaryLabel` in both appearances: `tertiaryLabel` on the light widget
  // background left the ranked-down rows too faint to read.
  const mutedForeground = foregroundStyle(PlatformColor('secondaryLabel'));
  const a11y = [
    // The widget process takes its locale from the device language, so without
    // this the relative wait would be formatted in a different language than
    // the labels the app translated into the props.
    environment({ key: 'locale', value: locale }),
    accessibilityElement('combine'),
    accessibilityLabel(props.accessibilityLabel ?? ''),
  ];

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

  // `compact` is the Lock Screen rectangle, which is four lines tall and narrow
  // enough that a subheadline label truncates once the mark takes its width.
  const countRow = (
    line: { label: string; kind: string; count: number },
    isPrimary: boolean,
    compact: boolean
  ) => {
    const glyph = GLYPH[line.kind as keyof typeof GLYPH];
    // Every row shares one type size and one glyph size so the counts and the
    // labels line up on a grid; only the label colour ranks them, because a
    // second font size in a three-row list reads as a mistake.
    const textStyle = compact ? 'caption' : 'subheadline';
    return (
      <HStack key={line.label} alignment="center" spacing={compact ? 4 : 7}>
        <Image systemName={glyph.icon} color={glyph.color} size={compact ? 11 : 13} />
        <Text
          modifiers={[
            font({ textStyle, weight: 'semibold' }),
            monospacedDigit(),
            // The number is the whole point of the row, so it takes its space
            // first. Without the priority a long label squeezed it to nothing
            // and the row drew a glyph and a word with no count.
            layoutPriority(1),
            primaryForeground,
          ]}
        >
          {String(line.count)}
        </Text>
        <Text
          modifiers={[
            font({ textStyle }),
            // The label carries the meaning, so it shrinks and tightens
            // rather than truncating: a German or Albanian label wrapped to
            // two lines otherwise, which broke the row grid the three counts
            // read on. Do not add `truncationMode` here — it suppresses the
            // scaling and the label truncates again. Tail is the default.
            lineLimit(1),
            minimumScaleFactor(0.6),
            allowsTightening(true),
            isPrimary ? primaryForeground : mutedForeground,
          ]}
        >
          {line.label}
        </Text>
        {wide ? <Spacer /> : null}
        {wide && line.kind === 'needsInput' && needsInputSince !== null ? (
          <Text
            date={new Date(needsInputSince)}
            dateStyle="relative"
            modifiers={[font({ textStyle }), monospacedDigit(), lineLimit(1), mutedForeground]}
          />
        ) : null}
      </HStack>
    );
  };

  // accessoryCircular has room for one number, and accessoryInline for one
  // glyph plus one line of text, so neither carries the mark.
  if (family === 'accessoryCircular') {
    return (
      <VStack alignment="center" spacing={0} modifiers={[widgetURL('kiloapp:///cloud/sessions')]}>
        {primaryKind === null ? null : (
          <Image
            systemName={GLYPH[primaryKind as keyof typeof GLYPH].icon}
            color={GLYPH[primaryKind as keyof typeof GLYPH].color}
            size={17}
          />
        )}
        <Text
          modifiers={[
            font({ textStyle: 'title2', weight: 'bold' }),
            monospacedDigit(),
            primaryForeground,
            ...a11y,
          ]}
        >
          {hasCounts ? String(primaryCount) : '—'}
        </Text>
      </VStack>
    );
  }

  if (family === 'accessoryInline') {
    const label = hasCounts
      ? `${primaryCount}${primaryLabel !== null ? ` ${primaryLabel}` : ''}`
      : (statusLine ?? '');
    return (
      <HStack
        alignment="center"
        spacing={4}
        modifiers={[widgetURL('kiloapp:///cloud/sessions'), ...a11y]}
      >
        {primaryKind === null ? null : (
          <Image systemName={GLYPH[primaryKind as keyof typeof GLYPH].icon} size={12} />
        )}
        <Text>{label}</Text>
      </HStack>
    );
  }

  // accessoryRectangular is the Lock Screen row: the mark plus the two
  // top-ranked lines is all that fits.
  if (family === 'accessoryRectangular') {
    return (
      <HStack
        alignment="center"
        spacing={6}
        modifiers={[widgetURL('kiloapp:///cloud/sessions'), ...a11y]}
      >
        {logo(18)}
        {hasCounts ? (
          <VStack alignment="leading" spacing={1}>
            {counts.map(line => countRow(line, line.kind === primaryKind, true))}
          </VStack>
        ) : (
          <Text modifiers={[font({ textStyle: 'subheadline' })]}>{statusLine}</Text>
        )}
        <Spacer />
      </HStack>
    );
  }

  const systemRows = hasCounts ? (
    <VStack alignment="leading" spacing={wide ? 6 : 4}>
      {counts.map(line => countRow(line, line.kind === primaryKind, false))}
    </VStack>
  ) : (
    <Text modifiers={[font({ textStyle: 'footnote' }), mutedForeground]}>{statusLine}</Text>
  );

  const systemModifiers = [
    widgetURL('kiloapp:///cloud/sessions'),
    containerBackground(PlatformColor('systemBackground'), 'widget'),
    ...a11y,
  ];

  // The medium family is wide, not tall: the mark sits beside the rows and the
  // whole block centres, the same composition as the Live Activity banner. A
  // vertical layout there left the right half of the card empty.
  if (wide) {
    return (
      <HStack alignment="center" spacing={14} modifiers={systemModifiers}>
        {logo(34)}
        {systemRows}
      </HStack>
    );
  }

  return (
    <VStack alignment="leading" spacing={8} modifiers={systemModifiers}>
      <HStack alignment="center" spacing={8}>
        {logo(26)}
        <Spacer />
      </HStack>
      {/* The mark sits at the top and the counts at the bottom, so the card
          reads as one composed block. */}
      <Spacer />
      {systemRows}
    </VStack>
  );
};

const WIDGET_NAME = 'ActiveAgentsWidget';

const registerLayout = () =>
  createWidget<WidgetProps>(WIDGET_NAME, withGlanceableCopy(withWidgetLogo(layout)));

export const ActiveAgentsWidget = registerLayout();

/**
 * Re-bake the stored layout in the active language. Only the gallery
 * placeholder reads this copy — a placed widget gets translated copy through
 * its timeline props — but the placeholder is the first thing the user sees in
 * the widget picker, so it must not stay English after a language change.
 */
export function refreshActiveAgentsWidgetCopy(): void {
  registerLayout();
}
