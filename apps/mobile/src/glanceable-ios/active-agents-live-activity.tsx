import { Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityElement,
  accessibilityLabel,
  font,
  foregroundStyle,
  frame,
} from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity } from 'expo-widgets';
import { PlatformColor } from 'react-native';

import { type GlanceableLiveActivityContentState } from '@kilocode/notifications';

/* eslint-disable new-cap -- PlatformColor is a React Native factory function, not a constructor */

// The layout function below is marked with the `'widget'` directive, so Babel
// stringifies it and the watcher extension re-evaluates the source. Everything
// it references must be a watcher global (`Text`, `VStack`, the modifiers,
// `PlatformColor`) or a built-in. Do not call `@/` helpers or i18n from here.
// The server pushes raw counts + status (it cannot translate), and the
// foreground app passes the same raw shape, so the inlined English copy below
// is the single producer of the displayed Live Activity copy.

export const ActiveAgentsLiveActivity = createLiveActivity<
  Partial<GlanceableLiveActivityContentState>
>('ActiveAgentsLiveActivity', (props, environment) => {
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

  const countLines = [
    { label: 'Needs input', count: props.needsInput ?? 0 },
    { label: 'Reconnecting', count: props.reconnecting ?? 0 },
    { label: 'Running', count: props.running ?? 0 },
  ].filter(line => line.count > 0);
  const hasCounts = countLines.length > 0;
  const primary = countLines[0] ?? null;
  const primaryLabel = primary === null ? null : primary.label;
  const primaryCount = String(primary === null ? 0 : primary.count);
  // Elapsed time shows while eligible counts exist, including the stale status,
  // so the running work keeps its elapsed timer when updates stop.
  const elapsedAnchor = hasCounts ? (props.eligibleStartedAt ?? null) : null;

  // Spoken label: status word, numeric counts, then Open agents. Stale keeps
  // its status word; happy (no status line) speaks counts then Open agents.
  const openAgentsCopy = 'Open agents';
  const spokenParts = [
    ...(statusLine !== null ? [statusLine] : []),
    ...countLines.map(line => `${line.count} ${line.label}`),
    openAgentsCopy,
  ];
  const accessibility = spokenParts.join(', ');

  const primaryForeground = foregroundStyle(PlatformColor('label'));
  const mutedForeground = foregroundStyle(
    dark ? PlatformColor('secondaryLabel') : PlatformColor('tertiaryLabel')
  );

  const countRows = countLines.map(line => (
    <Text key={line.label} modifiers={[font({ textStyle: 'body' }), primaryForeground]}>
      {`${line.count} ${line.label}`}
    </Text>
  ));

  const showOpenAgents = status === 'happy' || status === 'stale';
  const openAgentsControl = (
    <Text
      modifiers={[
        font({ textStyle: 'body', weight: 'semibold' }),
        primaryForeground,
        frame({ minHeight: 44, alignment: 'leading' }),
      ]}
    >
      {openAgentsCopy}
    </Text>
  );

  return {
    banner: (
      <VStack
        alignment="leading"
        spacing={4}
        modifiers={[accessibilityElement('combine'), accessibilityLabel(accessibility)]}
      >
        {hasCounts ? (
          <VStack alignment="leading" spacing={2}>
            {countRows}
          </VStack>
        ) : null}
        {statusLine !== null ? <Text modifiers={[mutedForeground]}>{statusLine}</Text> : null}
        {elapsedAnchor !== null ? (
          <Text date={new Date(elapsedAnchor)} dateStyle="relative" modifiers={[mutedForeground]} />
        ) : null}
        {showOpenAgents ? openAgentsControl : null}
      </VStack>
    ),
    compactLeading: (
      <Text
        modifiers={[
          font({ textStyle: 'headline', weight: 'bold' }),
          primaryForeground,
          accessibilityLabel(accessibility),
        ]}
      >
        {hasCounts ? primaryCount : statusLine}
      </Text>
    ),
    compactTrailing: (
      <Text
        modifiers={[
          font({ textStyle: 'footnote' }),
          primaryForeground,
          accessibilityLabel(accessibility),
        ]}
      >
        {hasCounts ? (primaryLabel ?? primaryCount) : ''}
      </Text>
    ),
    minimal: (
      <Text
        modifiers={[
          font({ textStyle: 'headline', weight: 'bold' }),
          primaryForeground,
          accessibilityLabel(accessibility),
        ]}
      >
        {hasCounts ? primaryCount : ''}
      </Text>
    ),
    expandedLeading: (
      <VStack alignment="leading" spacing={2} modifiers={[accessibilityLabel(accessibility)]}>
        {countRows}
      </VStack>
    ),
    expandedTrailing: (
      <VStack alignment="leading" spacing={2} modifiers={[accessibilityLabel(accessibility)]}>
        {statusLine !== null ? <Text modifiers={[mutedForeground]}>{statusLine}</Text> : null}
        {elapsedAnchor !== null ? (
          <Text date={new Date(elapsedAnchor)} dateStyle="relative" modifiers={[mutedForeground]} />
        ) : null}
      </VStack>
    ),
    expandedBottom: (
      <VStack alignment="leading" spacing={2} modifiers={[accessibilityLabel(accessibility)]}>
        {statusLine !== null && !hasCounts ? (
          <Text modifiers={[mutedForeground]}>{statusLine}</Text>
        ) : null}
        {showOpenAgents ? openAgentsControl : null}
      </VStack>
    ),
  };
});
