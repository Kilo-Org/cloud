'use client';

import { useState, useEffect, useRef } from 'react';
import type { StoredMessage } from './types';
import { isAssistantMessage } from './types';
import { computeStatus } from './computeStatus';
import { StatusSpinner } from '@/components/shared/StatusSpinner';

type WorkingIndicatorProps = {
  messages: StoredMessage[];
  isStreaming: boolean;
  isPreparing?: boolean;
};

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

export function WorkingIndicator({
  messages,
  isStreaming,
  isPreparing = false,
}: WorkingIndicatorProps) {
  const isWorking = isStreaming || isPreparing;
  const startTimeRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isWorking) {
      startTimeRef.current = null;
      setElapsed(0);
      return;
    }

    startTimeRef.current = Date.now();
    setElapsed(0);

    const interval = setInterval(() => {
      if (startTimeRef.current !== null) {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [isWorking]);

  if (!isWorking) return null;

  let statusText = isPreparing ? 'Setting up environment' : 'Considering next steps';

  for (let i = messages.length - 1; !isPreparing && i >= 0; i--) {
    const msg = messages[i];
    if (isAssistantMessage(msg.info) && msg.parts.length > 0) {
      statusText = computeStatus(msg.parts[msg.parts.length - 1]);
      break;
    }
  }

  return (
    <div className="text-foreground flex items-center gap-2 py-2 text-sm font-medium">
      <StatusSpinner className="h-5 w-5 shrink-0" />
      <span role="status">{statusText}</span>
      <span className="text-muted-foreground tabular-nums">· {formatElapsed(elapsed)}</span>
    </div>
  );
}
