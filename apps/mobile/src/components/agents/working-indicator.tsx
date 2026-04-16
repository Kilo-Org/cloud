import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { type StoredMessage } from 'cloud-agent-sdk';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { computeStatus } from './compute-status';

type WorkingIndicatorProps = {
  messages: StoredMessage[];
  isStreaming: boolean;
};

export function WorkingIndicator({ messages, isStreaming }: Readonly<WorkingIndicatorProps>) {
  const colors = useThemeColors();
  const [elapsed, setElapsed] = useState(0);
  const startTimeRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isStreaming) {
      startTimeRef.current = null;
      setElapsed(0);
      return undefined;
    }

    startTimeRef.current = Date.now();
    setElapsed(0);

    const interval = setInterval(() => {
      if (startTimeRef.current !== null) {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }
    }, 1000);

    return () => {
      clearInterval(interval);
    };
  }, [isStreaming]);

  if (!isStreaming) {
    return null;
  }

  // Find the last assistant message and its last part for status
  let statusText = 'Considering next steps';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.info.role === 'assistant' && msg.parts.length > 0) {
      const lastPart = msg.parts.at(-1);
      if (lastPart) {
        statusText = computeStatus(lastPart);
      }
      break;
    }
  }

  const time = formatElapsed(elapsed);

  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(150)}
      className="flex-row items-center gap-2 px-4 py-3"
    >
      <ActivityIndicator size="small" color={colors.mutedForeground} />
      <Text className="text-sm text-muted-foreground">
        {statusText} · {time}
      </Text>
    </Animated.View>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}
