'use client';

import { useSyncExternalStore } from 'react';
import { formatCostInsightDateTime } from '../formatting';

const subscribe = () => () => {};

export function useViewerTimeZone() {
  const useClientTimeZone = useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
  return useClientTimeZone ? undefined : 'UTC';
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
