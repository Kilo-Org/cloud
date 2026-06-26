'use client';

import { useSyncExternalStore } from 'react';
import { formatCostInsightDateTime } from '../formatting';

const subscribe = () => () => {};

export function useViewerTimeZone() {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  )
    ? undefined
    : 'UTC';
}

export function LocalDateTime({
  timestamp,
  prefix = '',
  className,
}: {
  timestamp: string;
  prefix?: string;
  className?: string;
}) {
  const label = formatCostInsightDateTime(timestamp, useViewerTimeZone());

  return (
    <time dateTime={timestamp} className={className}>
      {prefix}
      {label}
    </time>
  );
}
