'use client';

import React from 'react';

import { formatAdminTime } from './admin-time';

/**
 * Local time with its relative age underneath, the exact ISO value in a `title`
 * tooltip. Shared by the runs list and the failed-models table so both read the
 * same way.
 */
export function AdminTimeLabel({ iso, now }: { iso: string; now?: number }) {
  const time = formatAdminTime(iso, now);
  return (
    <span title={time.iso} className="whitespace-nowrap">
      {time.local}
      {time.relative ? (
        <span className="text-muted-foreground block text-[11px]">{time.relative}</span>
      ) : null}
    </span>
  );
}
