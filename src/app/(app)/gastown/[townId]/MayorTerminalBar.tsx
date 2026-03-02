'use client';

import { use } from 'react';
import { TerminalBar } from '@/components/gastown/TerminalBar';

export function MayorTerminalBar({ params }: { params: Promise<{ townId: string }> }) {
  const { townId } = use(params);
  return <TerminalBar townId={townId} />;
}
