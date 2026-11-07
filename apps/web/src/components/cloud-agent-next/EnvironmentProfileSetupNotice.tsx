'use client';

import { TriangleAlert } from 'lucide-react';
import type { EnvironmentRepository } from '@/hooks/useCloudAgentEnvironments';
import { useEnvironmentProfiles } from '@/hooks/useEnvironmentProfiles';
import { describeEnvironmentProfileImpact } from './environment-profile-impact';

/** Mount only when a repository environment applies, regardless of edit permissions. */
export function EnvironmentProfileSetupNotice({
  organizationId,
  repository,
  selectedProfileId,
}: {
  organizationId?: string;
  repository: EnvironmentRepository;
  selectedProfileId?: string | null;
}) {
  const { profiles, isLoading, isError } = useEnvironmentProfiles({
    organizationId,
    repository: {
      platform: repository.platform,
      fullName: repository.platform === 'gitlab' ? repository.projectPath : repository.fullName,
    },
    selectedProfileId,
  });
  if (isLoading || isError) return null;

  const { commandProfiles } = describeEnvironmentProfileImpact(profiles, []);
  if (commandProfiles.length === 0) return null;

  return (
    <p role="status" className="text-status-warning flex items-center justify-end gap-1 text-xs">
      <TriangleAlert className="size-3 shrink-0" aria-hidden />
      Environment setup replaces profile setup.
    </p>
  );
}
