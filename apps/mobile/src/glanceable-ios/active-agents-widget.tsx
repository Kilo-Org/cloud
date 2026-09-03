import { Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityElement,
  accessibilityLabel,
  containerBackground,
  font,
  foregroundStyle,
  frame,
  widgetURL,
} from '@expo/ui/swift-ui/modifiers';
import { createWidget } from 'expo-widgets';
import { PlatformColor } from 'react-native';

import { type GlanceableViewProps } from './view-props';

/* eslint-disable new-cap -- PlatformColor is a React Native factory function, not a constructor */

// The layout function below is marked with the `'widget'` directive, so Babel
// stringifies it and the widget extension re-evaluates the source. Everything
// it references must be a widget global (`Text`, `VStack`, the modifiers,
// `PlatformColor`) or a built-in. Do not call `@/` helpers or i18n from here —
// translated copy arrives through `props`. The inlined English fallbacks below
// only render while the gallery placeholder has no snapshot props.

export const ActiveAgentsWidget = createWidget<Partial<GlanceableViewProps>>(
  'ActiveAgentsWidget',
  (props, environment) => {
    'widget';

    const family = environment.widgetFamily;
    const dark = environment.colorScheme === 'dark';
    const counts = props.countLines ?? [];
    const hasCounts = counts.length > 0;
    const primaryLabel = props.primaryLabel ?? null;
    const primaryCount = props.primaryCount ?? 0;
    const statusLine = props.statusLine ?? (hasCounts ? null : 'No work in progress');
    const openAgentsLabel = props.openAgentsLabel ?? '';
    const showOpenAgents = props.showOpenAgents === true;
    const compact = ['systemSmall', 'accessoryCircular', 'accessoryInline'].includes(family);

    const primaryForeground = foregroundStyle(PlatformColor('label'));
    const mutedForeground = foregroundStyle(
      dark ? PlatformColor('secondaryLabel') : PlatformColor('tertiaryLabel')
    );
    const a11y = [
      accessibilityElement('combine'),
      accessibilityLabel(props.accessibilityLabel ?? ''),
    ];

    const countRows = counts.map(line => (
      <Text key={line.label} modifiers={[font({ textStyle: 'body' }), primaryForeground]}>
        {`${line.count} ${line.label}`}
      </Text>
    ));

    if (compact) {
      const label = hasCounts
        ? `${primaryCount}${primaryLabel !== null ? ` ${primaryLabel}` : ''}`
        : (statusLine ?? '');

      return (
        <Text
          modifiers={[
            widgetURL('kiloapp:///cloud/sessions'),
            font({ textStyle: 'headline', weight: 'bold' }),
            primaryForeground,
            ...a11y,
          ]}
        >
          {label}
        </Text>
      );
    }

    return (
      <VStack
        alignment="leading"
        spacing={4}
        modifiers={[
          widgetURL('kiloapp:///cloud/sessions'),
          containerBackground(PlatformColor('systemBackground'), 'widget'),
          ...a11y,
        ]}
      >
        {hasCounts ? (
          <VStack alignment="leading" spacing={2}>
            {countRows}
          </VStack>
        ) : null}
        {statusLine !== null ? <Text modifiers={[mutedForeground]}>{statusLine}</Text> : null}
        {showOpenAgents ? (
          <Text
            modifiers={[
              font({ textStyle: 'body', weight: 'semibold' }),
              primaryForeground,
              frame({ minHeight: 44, alignment: 'leading' }),
            ]}
          >
            {openAgentsLabel}
          </Text>
        ) : null}
      </VStack>
    );
  }
);
