'use client';

import { useParams } from 'next/navigation';
import { useInstancePresence } from '@/hooks/useInstancePresence';
import { useOrgKiloClawStatus } from '@/hooks/useOrgKiloClaw';

export function OrgInstancePresenceMount() {
  const params = useParams<{ id: string }>();
  const organizationId = params?.id;
  const { data: status } = useOrgKiloClawStatus(organizationId);
  useInstancePresence(status?.sandboxId ?? undefined);
  return null;
}
