import { Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityElement,
  accessibilityLabel,
  font,
  foregroundStyle,
} from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity } from 'expo-widgets';
import { PlatformColor } from 'react-native';

import { type GlanceableViewProps } from './view-props';

/* eslint-disable new-cap -- PlatformColor is a React Native factory function, not a constructor */

// The layout function below is marked with the `'widget'` directive, so Babel
// stringifies it and the watcher extension re-evaluates the source. Everything
// it references must be a watcher global (`Text`, `VStack`, the modifiers,
// `PlatformColor`) or a built-in. Do not call `@/` helpers or i18n from here —
// translated copy arrives through `props`. The inlined English fallbacks below
// only render while the gallery placeholder has no snapshot props.

export const ActiveAgentsLiveActivity = createLiveActivity<Partial<GlanceableViewProps>>(
  'ActiveAgentsLiveActivity',
  (props, environment) => {
    'widget';

    const dark = environment.colorScheme === 'dark';
    const counts = props.countLines ?? [];
    const hasCounts = counts.length > 0;
    const primaryLabel = props.primaryLabel ?? null;
    const primaryCount = String(props.primaryCount ?? 0);
    const statusLine = props.statusLine ?? (hasCounts ? null : 'No work in progress');
    const elapsedAnchor = props.elapsedAnchor ?? null;

    const primaryForeground = foregroundStyle(PlatformColor('label'));
    const mutedForeground = foregroundStyle(
      dark ? PlatformColor('secondaryLabel') : PlatformColor('tertiaryLabel')
    );

    const countRows = counts.map(line => (
      <Text key={line.label} modifiers={[font({ textStyle: 'body' }), primaryForeground]}>
        {`${line.count} ${line.label}`}
      </Text>
    ));

    return {
      banner: (
        <VStack
          alignment="leading"
          spacing={4}
          modifiers={[
            accessibilityElement('combine'),
            accessibilityLabel(props.accessibilityLabel ?? ''),
          ]}
        >
          {hasCounts ? (
            <VStack alignment="leading" spacing={2}>
              {countRows}
            </VStack>
          ) : null}
          {statusLine !== null ? <Text modifiers={[mutedForeground]}>{statusLine}</Text> : null}
          {elapsedAnchor !== null ? (
            <Text
              date={new Date(elapsedAnchor)}
              dateStyle="relative"
              modifiers={[mutedForeground]}
            />
          ) : null}
        </VStack>
      ),
      compactLeading: (
        <Text modifiers={[font({ textStyle: 'headline', weight: 'bold' }), primaryForeground]}>
          {hasCounts ? primaryCount : statusLine}
        </Text>
      ),
      compactTrailing: (
        <Text modifiers={[font({ textStyle: 'footnote' }), primaryForeground]}>
          {hasCounts ? (primaryLabel ?? primaryCount) : ''}
        </Text>
      ),
      minimal: (
        <Text modifiers={[font({ textStyle: 'headline', weight: 'bold' }), primaryForeground]}>
          {hasCounts ? primaryCount : ''}
        </Text>
      ),
      expandedLeading: (
        <VStack alignment="leading" spacing={2}>
          {countRows}
        </VStack>
      ),
      expandedTrailing: (
        <VStack alignment="leading" spacing={2}>
          {statusLine !== null ? <Text modifiers={[mutedForeground]}>{statusLine}</Text> : null}
          {elapsedAnchor !== null ? (
            <Text
              date={new Date(elapsedAnchor)}
              dateStyle="relative"
              modifiers={[mutedForeground]}
            />
          ) : null}
        </VStack>
      ),
      expandedBottom: (
        <VStack alignment="leading" spacing={2}>
          {statusLine !== null && !hasCounts ? (
            <Text modifiers={[mutedForeground]}>{statusLine}</Text>
          ) : null}
        </VStack>
      ),
    };
  }
);
