import { useEffect, useRef, useState } from 'react';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { type StoredMessage } from '@kilocode/cloud-agent-sdk';

import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatDurationIncludingZero } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { SESSION_FOOTER_ROW_ITEM_PADDING } from './session-working-state';
import { computeBlockingAskStatus, computeMessageStatus } from './compute-status';
import { type BlockingInteraction } from './agent-interaction-policy';

type WorkingIndicatorProps = {
  messages: StoredMessage[];
  isStreaming: boolean;
  /**
   * The ask on screen that blocks the agent, when there is one. A blocked agent
   * names the ask instead of the tool activity whose part the transcript holds
   * unfinished, because the command has not started.
   */
  blockingInteraction?: BlockingInteraction;
};

export function WorkingIndicator({
  messages,
  isStreaming,
  blockingInteraction = 'none',
}: Readonly<WorkingIndicatorProps>) {
  const colors = useThemeColors();
  const [elapsed, setElapsed] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  // Work time of the segments that already ended, in milliseconds. An ask banks
  // the segment it interrupts here, so the counter holds still while nothing
  // works and resumes from the banked value once the ask is answered.
  const bankedMsRef = useRef(0);

  useEffect(() => {
    if (!isStreaming) {
      startTimeRef.current = null;
      bankedMsRef.current = 0;
      setElapsed(0);
      return undefined;
    }

    if (blockingInteraction !== 'none') {
      const startedAt = startTimeRef.current;
      if (startedAt !== null) {
        bankedMsRef.current += Date.now() - startedAt;
        startTimeRef.current = null;
        setElapsed(Math.floor(bankedMsRef.current / 1000));
      }
      return undefined;
    }

    startTimeRef.current = Date.now();
    const interval = setInterval(() => {
      const segmentStart = startTimeRef.current;
      if (segmentStart !== null) {
        setElapsed(Math.floor((bankedMsRef.current + Date.now() - segmentStart) / 1000));
      }
    }, 1000);

    return () => {
      clearInterval(interval);
    };
  }, [isStreaming, blockingInteraction]);

  if (!isStreaming) {
    return null;
  }

  // Find the last assistant message and its status part for the label.
  // `computeMessageStatus` skips the empty text placeholder opencode creates
  // before the response block, so a reasoning stream reads "Thinking" instead
  // of "Writing response".
  let messageStatus = i18n.t('agentChat.computeStatus.consideringNextSteps');
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.info.role === 'assistant' && msg.parts.length > 0) {
      messageStatus = computeMessageStatus(msg.parts);
      break;
    }
  }
  const statusText =
    blockingInteraction === 'none' ? messageStatus : computeBlockingAskStatus(blockingInteraction);

  const time = formatDurationIncludingZero(elapsed, i18n.language);

  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(150)}
      // The design gate's proof readiness marker for this row.
      testID="agent-activity-row"
      className={`flex-row items-center gap-2 ${SESSION_FOOTER_ROW_ITEM_PADDING}`}
    >
      <ActivityIndicator size="small" color={colors.mutedForeground} />
      <Text className="text-sm text-muted-foreground">
        {statusText} · {time}
      </Text>
    </Animated.View>
  );
}
