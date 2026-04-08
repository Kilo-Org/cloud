import { useMemo } from 'react';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';

export function useGatewayUrl(status: KiloClawDashboardStatus | undefined) {
  return useMemo(() => {
    const baseUrl = status?.workerUrl || 'https://claw.kilo.ai';
    if (!status?.userId) return baseUrl;
    const params = new URLSearchParams({ userId: status.userId });
    // Instance-keyed instances need the instanceId so the access gateway
    // can resolve the correct sandboxId and set the active-instance cookie.
    if (status.instanceId) {
      params.set('instanceId', status.instanceId);
    }
    return `${baseUrl}/kilo-access-gateway?${params.toString()}`;
  }, [status?.workerUrl, status?.userId, status?.instanceId]);
}
