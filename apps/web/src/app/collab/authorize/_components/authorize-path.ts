import type { PlatformId } from '../../_components/platforms';

export function buildReturnToPath({
  serviceIds,
  connectedServiceIds,
  organizationId,
  step,
}: {
  serviceIds: PlatformId[];
  connectedServiceIds: PlatformId[];
  organizationId?: string;
  step: number;
}): string {
  const params = new URLSearchParams({ services: serviceIds.join(','), step: step.toString() });
  if (connectedServiceIds.length > 0) params.set('connected', connectedServiceIds.join(','));
  if (organizationId) params.set('organizationId', organizationId);
  return `/collab/authorize?${params.toString()}`;
}
