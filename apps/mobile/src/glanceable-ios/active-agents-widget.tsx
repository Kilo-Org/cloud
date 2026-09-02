import { HStack, Image, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityElement,
  accessibilityLabel,
  containerBackground,
  cornerRadius,
  font,
  foregroundStyle,
  frame,
  monospacedDigit,
  resizable,
  widgetURL,
} from '@expo/ui/swift-ui/modifiers';
import { createWidget, type WidgetEnvironment } from 'expo-widgets';
import { PlatformColor } from 'react-native';

import { type GlanceableViewProps } from './view-props';
import { withWidgetLogo } from './widget-logo';

/* eslint-disable new-cap -- PlatformColor is a React Native factory function, not a constructor */

// The layout function below is marked with the `'widget'` directive, so Babel
// stringifies it and the widget extension re-evaluates the source. Everything
// it references must be a widget global (`Text`, `VStack`, the modifiers,
// `PlatformColor`) or a built-in. Do not call `@/` helpers or i18n from here —
// translated copy arrives through `props`. The inlined English fallbacks below
// only render while the gallery placeholder has no snapshot props.
//
// The one value resolved after stringification is the `__KILO_WIDGET_LOGO_URI__`
// literal below: `withWidgetLogo` swaps it for the app-group path of the mark.

type WidgetProps = Partial<GlanceableViewProps>;

// Babel replaces the annotated arrow with its source string, so `layout` is a
// string at runtime while TypeScript still checks it as a component.
const layout: (props: WidgetProps, environment: WidgetEnvironment) => React.JSX.Element = (
  props,
  environment
) => {
  'widget';

  const family = environment.widgetFamily;
  const dark = environment.colorScheme === 'dark';
  const counts = props.countLines ?? [];
  const hasCounts = counts.length > 0;
  const primaryLabel = props.primaryLabel ?? null;
  const primaryKind = props.primaryKind ?? null;
  const primaryCount = props.primaryCount ?? 0;
  const statusLine = props.statusLine ?? (hasCounts ? null : 'No work in progress');
  const elapsedAnchor = props.elapsedAnchor ?? null;

  // Circle-based glyphs whose shapes differ as well as their colors, because
  // the Lock Screen families render in an accented mode that flattens tint.
  const GLYPH = {
    needsInput: { icon: 'exclamationmark.circle.fill', color: PlatformColor('systemOrange') },
    running: { icon: 'circle.fill', color: PlatformColor('systemGreen') },
    idle: { icon: 'circle', color: PlatformColor('label') },
  } as const;

  const primaryForeground = foregroundStyle(PlatformColor('label'));
  const mutedForeground = foregroundStyle(
    dark ? PlatformColor('secondaryLabel') : PlatformColor('tertiaryLabel')
  );
  const a11y = [
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
    const emphasis = isPrimary ? 'headline' : 'subheadline';
    const countStyle = compact ? 'caption' : emphasis;
    const labelStyle = compact ? 'caption' : 'subheadline';
    const glyphSize = isPrimary ? 14 : 12;
    return (
      <HStack key={line.label} alignment="center" spacing={compact ? 4 : 6}>
        <Image systemName={glyph.icon} color={glyph.color} size={compact ? 11 : glyphSize} />
        <Text
          modifiers={[
            font({ textStyle: countStyle, weight: 'semibold' }),
            monospacedDigit(),
            primaryForeground,
          ]}
        >
          {String(line.count)}
        </Text>
        <Text
          modifiers={[
            font({ textStyle: labelStyle }),
            isPrimary ? primaryForeground : mutedForeground,
          ]}
        >
          {line.label}
        </Text>
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
            size={12}
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

  const elapsed =
    elapsedAnchor === null ? null : (
      <Text
        date={new Date(elapsedAnchor)}
        dateStyle="relative"
        modifiers={[font({ textStyle: 'caption' }), monospacedDigit(), mutedForeground]}
      />
    );

  // accessoryRectangular is the Lock Screen row: the mark plus the two
  // top-ranked lines is all that fits.
  if (family === 'accessoryRectangular') {
    return (
      <HStack
        alignment="center"
        spacing={6}
        modifiers={[widgetURL('kiloapp:///cloud/sessions'), ...a11y]}
      >
        {logo(14)}
        {hasCounts ? (
          <VStack alignment="leading" spacing={1}>
            {counts.slice(0, 2).map((line, index) => countRow(line, index === 0, true))}
          </VStack>
        ) : (
          <Text modifiers={[font({ textStyle: 'subheadline' })]}>{statusLine}</Text>
        )}
        <Spacer />
      </HStack>
    );
  }

  // systemSmall has room for the mark, then every non-zero line; the wider
  // families add the elapsed timer on the header row.
  const wide = family !== 'systemSmall';
  return (
    <VStack
      alignment="leading"
      spacing={8}
      modifiers={[
        widgetURL('kiloapp:///cloud/sessions'),
        containerBackground(PlatformColor('systemBackground'), 'widget'),
        ...a11y,
      ]}
    >
      <HStack alignment="center" spacing={8}>
        {logo(20)}
        <Spacer />
        {wide ? elapsed : null}
      </HStack>
      {hasCounts ? (
        <VStack alignment="leading" spacing={4}>
          {counts.map((line, index) => countRow(line, index === 0, false))}
        </VStack>
      ) : null}
      {statusLine !== null ? (
        <Text modifiers={[font({ textStyle: 'footnote' }), mutedForeground]}>{statusLine}</Text>
      ) : null}
      {wide ? null : elapsed}
      <Spacer />
    </VStack>
  );
};

export const ActiveAgentsWidget = createWidget<WidgetProps>(
  'ActiveAgentsWidget',
  withWidgetLogo(layout)
);
