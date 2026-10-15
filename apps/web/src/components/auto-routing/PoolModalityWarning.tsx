'use client';

// Web Jest compiles JSX with the classic runtime, which needs React in scope.
import React from 'react';
import { TriangleAlert } from 'lucide-react';
import {
  poolModalityUnknownMessage,
  poolModalityWarningMessage,
  type PoolModalityCoverage,
} from '@/lib/auto-routing-pool-modality';

export function PoolModalityWarning({ coverage }: { coverage: PoolModalityCoverage }) {
  if (coverage.status === 'covered' || coverage.status === 'pending') return null;

  if (coverage.status === 'unknown') {
    return (
      <p className="text-muted-foreground text-xs">
        {poolModalityUnknownMessage(coverage.unknownModelIds)}
      </p>
    );
  }

  return (
    <p className="flex items-start gap-1.5 text-xs text-amber-500">
      <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>{poolModalityWarningMessage(coverage.missing)}</span>
    </p>
  );
}
