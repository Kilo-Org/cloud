import { type ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';

import { SessionSkeletonMessages } from '@/components/agents/session-detail-skeleton';

const hiddenStyle = { opacity: 0 } satisfies ViewStyle;

/**
 * Holds a transcript's rows back until their position is final.
 *
 * The list lays its rows out at their natural offsets and then moves them twice
 * before they settle: the bottom-start adjustment margin, then the scroll to the
 * newest row. The time marker above the newest rows, and every row around it,
 * moves by the transcript's whole overflow a beat after the rows were already on
 * screen. A row that is visible during that window is a row about to jump.
 *
 * So the rows are mounted, measured and not shown (`opacity: 0` also keeps them
 * out of the design gate's frame readings, which drop hidden subtrees), and the
 * loading skeleton covers the same area. `settled` arrives from
 * `useSessionListOpenSettle` once the measurements stop changing.
 */
export function SessionTranscriptOpenGate({
  settled,
  sessionId,
  children,
}: Readonly<{ settled: boolean; sessionId: string; children: ReactNode }>) {
  return (
    <View className="flex-1">
      <View
        className="flex-1"
        style={settled ? null : hiddenStyle}
        pointerEvents={settled ? 'auto' : 'none'}
      >
        {children}
      </View>
      {settled ? null : (
        <View className="absolute inset-0 bg-background">
          <SessionSkeletonMessages sessionId={sessionId} />
        </View>
      )}
    </View>
  );
}
