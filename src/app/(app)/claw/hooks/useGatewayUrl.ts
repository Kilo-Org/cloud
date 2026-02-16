import { useMemo } from 'react';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';

export function useGatewayUrl(status: KiloClawDashboardStatus | undefined) {
  return useMemo(() => {
    const baseUrl = status?.workerUrl || 'https://claw.kilo.ai';
    if (!status?.userId) return baseUrl;
    return `${baseUrl}/kilo-access-gateway?userId=${encodeURIComponent(status.userId)}`;
  }, [status?.workerUrl, status?.userId]);
}
