'use client';

import { TriangleAlert } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Environment setup replaces profile setup."
          className="text-status-warning focus-visible:ring-ring inline-flex size-6 shrink-0 cursor-help items-center justify-center rounded-sm focus-visible:ring-2 focus-visible:outline-none"
        >
          <TriangleAlert className="size-4" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        Environment setup replaces profile setup.
      </TooltipContent>
    </Tooltip>
  );
}
