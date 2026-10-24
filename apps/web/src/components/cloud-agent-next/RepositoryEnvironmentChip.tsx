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

/**
 * Shows the environment that new sessions in the selected repository use. There
 * is no choice to make: the server applies it from the repository. Managers open
 * it here to edit it, or set one up when the repository has none.
 */
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
      {canManage ? (
        <button
          type="button"
          className={cn(chipClassName, interactiveClassName)}
          aria-label={environment ? 'Edit environment' : 'Set up environment'}
          title={
            environment
              ? 'Edit environment'
              : 'Save setup commands, variables, secrets, and a sandbox size for this repository.'
          }
          onClick={() => setDialogOpen(true)}
        >
          {label}
        </button>
      ) : (
        <span
          className={chipClassName}
          title="New sessions in this repository use this environment. Organization owners and admins can edit it."
        >
          {label}
        </span>
      )}
      {canManage && (
        <EnvironmentDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          organizationId={organizationId}
          repository={repository}
          repositoryLabel={repositoryLabel}
          environmentId={environment?.id ?? null}
          selectedProfileId={selectedProfileId}
          onSaved={() => setDialogOpen(false)}
          onDeleted={() => setDialogOpen(false)}
        />
      )}
    </>
  );
}
