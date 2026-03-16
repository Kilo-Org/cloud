'use client';

import { use } from 'react';
import { TerminalBar } from '@/components/gastown/TerminalBar';
import { useGastownUiContext } from '@/components/gastown/useGastownUiContext';
import { GASTOWN_URL } from '@/lib/constants';

export function MayorTerminalBar({ params }: { params: Promise<{ townId: string }> }) {
  const { townId } = use(params);
  // Track dashboard navigation context and sync to TownDO
  useGastownUiContext(townId, GASTOWN_URL);
  return <TerminalBar townId={townId} />;
}
