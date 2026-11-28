import { useMemo } from 'react';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';

/** Null until the server names a worker URL; there is no client-side default destination. */
export function useGatewayUrl(status: KiloClawDashboardStatus | undefined): string | null {
  return useMemo(() => {
    const baseUrl = status?.workerUrl;
    if (!baseUrl) return null;
    if (!status.userId) return baseUrl;
    const params = new URLSearchParams({ userId: status.userId });
    // Instance-keyed instances need the instanceId so the access gateway
    // can resolve the correct sandboxId and set the active-instance cookie.
    if (status.instanceId) {
      params.set('instanceId', status.instanceId);
    }
    return `${baseUrl}/kilo-access-gateway?${params.toString()}`;
  }, [status?.workerUrl, status?.userId, status?.instanceId]);
}
