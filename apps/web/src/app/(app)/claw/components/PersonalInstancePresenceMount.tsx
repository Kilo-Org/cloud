'use client';

import { useInstancePresence } from '@/hooks/useInstancePresence';
import { useKiloClawStatus } from '@/hooks/useKiloClaw';

export function PersonalInstancePresenceMount() {
  const { data: status } = useKiloClawStatus();
  useInstancePresence(status?.sandboxId ?? undefined);
  return null;
}
