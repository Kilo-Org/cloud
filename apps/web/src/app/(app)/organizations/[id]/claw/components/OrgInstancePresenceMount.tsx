'use client';

import { useInstancePresence } from '@/hooks/useInstancePresence';
import { useOrgKiloClawStatus } from '@/hooks/useOrgKiloClaw';

export function OrgInstancePresenceMount({ organizationId }: { organizationId: string }) {
  const { data: status } = useOrgKiloClawStatus(organizationId);
  useInstancePresence(status?.sandboxId ?? undefined);
  return null;
}
