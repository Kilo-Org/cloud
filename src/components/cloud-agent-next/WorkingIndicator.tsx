'use client';

import { useState, useEffect, useRef } from 'react';
import type { StoredMessage } from './types';
import { isAssistantMessage } from './types';
import { computeStatus } from './computeStatus';
import { StatusSpinner } from './StatusSpinner';

type WorkingIndicatorProps = {
  messages: StoredMessage[];
  isStreaming: boolean;
};

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

export function WorkingIndicator({ messages, isStreaming }: WorkingIndicatorProps) {
  const startTimeRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isStreaming) {
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
  }, [isStreaming]);

  if (!isStreaming) return null;

  let statusText = 'Considering next steps';

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (isAssistantMessage(msg.info) && msg.parts.length > 0) {
      statusText = computeStatus(msg.parts[msg.parts.length - 1]);
      break;
    }
  }

  return (
    <div className="text-muted-foreground flex items-center gap-2 py-2 text-xs">
      <StatusSpinner className="h-4 w-4" />
      <span>
        {statusText} · {formatElapsed(elapsed)}
      </span>
    </div>
  );
}
