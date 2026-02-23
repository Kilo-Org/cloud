'use client';

import { use } from 'react';
import { MayorChat } from '@/components/gastown/MayorChat';

export function MayorTerminalBar({ params }: { params: Promise<{ townId: string }> }) {
  const { townId } = use(params);
  return <MayorChat townId={townId} />;
}
