import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import type { StatusQueryLike } from '../components';

type ClawNewStatusBoundaryQuery = StatusQueryLike & {
  dataUpdatedAt: number;
};

type GetClawNewStatusQueryForBoundaryInput = {
  statusQuery: ClawNewStatusBoundaryQuery;
  setupFailed: boolean;
  billingInstanceId: string | null;
};

export function getClawNewStatusQueryForBoundary({
  statusQuery,
  setupFailed,
  billingInstanceId,
}: GetClawNewStatusQueryForBoundaryInput): StatusQueryLike {
  if (setupFailed) {
    return {
      data: statusQuery.data,
      isLoading: false,
      error: null,
    };
  }

  const renderableStatus = getRenderableStatus(statusQuery.data, billingInstanceId);
  if (renderableStatus) {
    return {
      data: renderableStatus,
      isLoading: false,
      error: null,
    };
  }

  if (statusQuery.error) {
    return {
      data: undefined,
      isLoading: false,
      error: statusQuery.error,
    };
  }

  return {
    data: undefined,
    isLoading: true,
    error: null,
  };
}

function getRenderableStatus(
  status: KiloClawDashboardStatus | undefined,
  billingInstanceId: string | null
): KiloClawDashboardStatus | undefined {
  if (!status) return undefined;

  if (billingInstanceId !== null) {
    if (status.instanceId === null && status.status === null) return undefined;
    if (status.instanceId !== null && status.instanceId !== billingInstanceId) return undefined;
  }

  return status;
}
