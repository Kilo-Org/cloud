'use client';

import { useState } from 'react';
import { Boxes, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { EnvironmentRepository, EnvironmentSummary } from '@/hooks/useCloudAgentEnvironments';
import { useCloudAgentSettingsCanManage } from '@/hooks/useCloudAgentSettings';
import { EnvironmentDialog } from './EnvironmentDialog';

const chipClassName =
  'inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/50 bg-muted/30 px-2 py-1 text-xs text-muted-foreground';
const interactiveClassName =
  'cursor-pointer transition-colors hover:border-border hover:bg-muted/60 hover:text-foreground';

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

  const label = environment ? (
    <>
      <Boxes className="size-3 shrink-0" aria-hidden />
      <span className="font-medium">Env</span>
    </>
  ) : (
    <>
      <Plus className="size-3 shrink-0" aria-hidden />
      <span>Set up environment</span>
    </>
  );

  return (
    <>
      <button
        type="button"
        className={cn(chipClassName, interactiveClassName)}
        aria-label={
          environment ? (canManage ? 'Edit environment' : 'View environment') : 'Set up environment'
        }
        title={
          environment
            ? canManage
              ? 'Edit environment'
              : 'View environment'
            : 'Save setup commands, variables, secrets, and a sandbox size for this repository.'
        }
        onClick={() => setDialogOpen(true)}
      >
        {label}
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
