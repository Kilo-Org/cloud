'use client';

import { useState } from 'react';
import { Boxes, Check, ChevronDown, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  environmentMembers,
  type EnvironmentRepository,
  type EnvironmentSummary,
} from '@/hooks/useCloudAgentEnvironments';
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
  /** Every environment that contains the repository; undefined while unknown. */
  environments: EnvironmentSummary[] | undefined;
  /** The environment the session uses: null when none, undefined while unknown or not chosen. */
  environment: EnvironmentSummary | null | undefined;
  onChooseEnvironment: (environmentId: string) => void;
  selectedProfileId?: string | null;
};

/**
 * Shows the environment that new sessions in the selected repository use. One
 * match applies by itself. With several, the user chooses here. Managers open it
 * to edit it, or set one up when the repository has none.
 */
export function RepositoryEnvironmentChip({
  organizationId,
  repository,
  repositoryLabel,
  environments,
  environment,
  onChooseEnvironment,
  selectedProfileId,
}: RepositoryEnvironmentChipProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const { data: canManageData } = useCloudAgentSettingsCanManage({ organizationId });
  const canManage = canManageData?.canManage ?? false;

  if (!repository || environments === undefined) return null;
  const needsChoice = environments.length > 1;
  if (environments.length === 0 && !canManage) return null;

  const label = needsChoice ? (
    <>
      <Boxes className="size-3 shrink-0" aria-hidden />
      <span className={cn('truncate', !environment && 'text-status-warning font-medium')}>
        {environment ? environment.name : 'Choose environment'}
      </span>
      <ChevronDown className="size-3 shrink-0 opacity-50" aria-hidden />
    </>
  ) : environment ? (
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
      {needsChoice ? (
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(chipClassName, interactiveClassName)}
              aria-label="Choose environment"
            >
              {label}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-1" align="start">
            <p className="text-muted-foreground px-2 py-1.5 text-xs">
              Several environments contain this repository. Choose the one this session uses.
            </p>
            <ul>
              {environments.map(candidate => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    className="hover:bg-accent flex w-full cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-left text-xs"
                    aria-pressed={candidate.id === environment?.id}
                    onClick={() => {
                      onChooseEnvironment(candidate.id);
                      setPickerOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        'mt-0.5 size-3 shrink-0',
                        candidate.id !== environment?.id && 'invisible'
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{candidate.name}</span>
                      <span className="text-muted-foreground block truncate">
                        {environmentMembers(candidate)
                          .map(member => member.repoFullName)
                          .join(', ')}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {canManage && environment && (
              <button
                type="button"
                className="hover:bg-accent text-muted-foreground mt-1 w-full cursor-pointer rounded-sm border-t px-2 py-1.5 text-left text-xs"
                onClick={() => {
                  setPickerOpen(false);
                  setDialogOpen(true);
                }}
              >
                Edit environment
              </button>
            )}
          </PopoverContent>
        </Popover>
      ) : canManage ? (
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
          canManage={canManage}
          onSaved={() => setDialogOpen(false)}
          onDeleted={() => setDialogOpen(false)}
        />
      )}
    </>
  );
}
