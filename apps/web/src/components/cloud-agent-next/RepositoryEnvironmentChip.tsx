'use client';

import { useState } from 'react';
import { Boxes, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { EnvironmentRepository, EnvironmentSummary } from '@/hooks/useCloudAgentEnvironments';
import { useCloudAgentSettingsCanManage } from '@/hooks/useCloudAgentSettings';
import { EnvironmentDialog } from './EnvironmentDialog';
import {
  contextSegmentClassName,
  interactiveContextSegmentClassName,
} from './session-context-segments';

type RepositoryEnvironmentChipProps = {
  organizationId?: string;
  repository: EnvironmentRepository | undefined;
  repositoryLabel: string;
  /** null when the repository has no environment; undefined while unknown. */
  environment: EnvironmentSummary | null | undefined;
  selectedProfileId?: string | null;
};

export function RepositoryEnvironmentChip({
  organizationId,
  repository,
  repositoryLabel,
  environment,
  selectedProfileId,
}: RepositoryEnvironmentChipProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { data: canManageData } = useCloudAgentSettingsCanManage({ organizationId });
  const canManage = canManageData?.canManage ?? false;

  if (!repository || environment === undefined) return null;
  if (!environment && !canManage) return null;

  const Icon = environment ? Boxes : Plus;

  return (
    <>
      <button
        type="button"
        className={cn(
          contextSegmentClassName,
          interactiveContextSegmentClassName,
          environment && 'text-foreground'
        )}
        aria-label={
          environment ? (canManage ? 'Edit environment' : 'View environment') : 'Set up environment'
        }
        title={
          environment
            ? `${canManage ? 'Edit' : 'View'} the environment of ${repositoryLabel}`
            : `Save setup commands, variables, secrets, and a sandbox size for ${repositoryLabel}.`
        }
        onClick={() => setDialogOpen(true)}
      >
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="font-medium">Env</span>
      </button>
      <EnvironmentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        organizationId={organizationId}
        repository={repository}
        repositoryLabel={repositoryLabel}
        environmentId={environment?.id ?? null}
        selectedProfileId={selectedProfileId}
        canManage={canManage}
        onSaved={() => setDialogOpen(false)}
        onDeleted={() => setDialogOpen(false)}
      />
    </>
  );
}
