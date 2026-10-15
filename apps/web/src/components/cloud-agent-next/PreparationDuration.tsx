'use client';

import { useEffect, useState } from 'react';
import type { PreparationStepSnapshot } from '@kilocode/cloud-agent-sdk';
import { formatAttemptDuration } from './preparation-phases';

export function PreparationDuration({
  step,
  className,
}: {
  step: PreparationStepSnapshot;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const running = step.status === 'running' && step.completedAt === undefined;

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [running, step.startedAt]);

  const duration = formatAttemptDuration(step, running ? now : undefined);
  return duration ? <span className={className}>{duration}</span> : null;
}
