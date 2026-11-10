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
import { additionalEnvironmentMembers } from './environment-display';
import {
  contextSegmentClassName,
  interactiveContextSegmentClassName,
  SegmentText,
} from './session-context-segments';

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
  if (environments.length === 0 && !canManage) return null;
  const memberCount = environment ? environmentMembers(environment).length : 0;

  const label =
    environments.length > 0 ? (
      <>
        <Boxes className="size-3.5 shrink-0" aria-hidden />
        <SegmentText className={cn('max-w-48', !environment && 'text-status-warning font-medium')}>
          {environment ? environment.name : 'Choose environment'}
        </SegmentText>
        {environment && (
          <span className="shrink-0">
            <span aria-hidden>· </span>
            {memberCount} {memberCount === 1 ? 'repo' : 'repos'}
          </span>
        )}
        <ChevronDown className="size-3 shrink-0 opacity-50" aria-hidden />
      </>
    ) : (
      <>
        <Plus className="size-3.5 shrink-0" aria-hidden />
        <span>Set up environment</span>
      </>
    );

  return (
    <>
      {environments.length > 0 ? (
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                contextSegmentClassName,
                interactiveContextSegmentClassName,
                environment && 'text-foreground',
                pickerOpen && 'bg-muted/60 text-foreground'
              )}
              aria-label="Choose environment"
            >
              {label}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-80 max-w-[calc(100vw-2rem)] p-1" align="start">
            <p
              className="text-muted-foreground truncate px-2 py-1.5 text-xs"
              title={repositoryLabel}
            >
              Environments for {repositoryLabel}
            </p>
            <ul className="max-h-72 overflow-y-auto">
              {environments.map(candidate => {
                const members = environmentMembers(candidate);
                const additionalMembers = additionalEnvironmentMembers(candidate, repository);
                return (
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
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate font-medium">
                            {candidate.name}
                          </span>
                          <span className="text-muted-foreground shrink-0 text-[10px]">
                            {members.length} {members.length === 1 ? 'repo' : 'repos'}
                          </span>
                        </span>
                        {additionalMembers.length > 0 && (
                          <span className="mt-1 block space-y-1 border-l pl-2">
                            {additionalMembers.map(member => (
                              <span
                                key={`${member.platform}:${member.repoFullName}`}
                                className="text-muted-foreground flex items-center gap-2"
                              >
                                <span
                                  className="min-w-0 flex-1 truncate"
                                  title={member.repoFullName}
                                >
                                  {member.repoFullName}
                                </span>
                              </span>
                            ))}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {environment && (
              <button
                type="button"
                className="hover:bg-accent text-muted-foreground mt-1 w-full cursor-pointer rounded-sm border-t px-2 py-1.5 text-left text-xs"
                onClick={() => {
                  setPickerOpen(false);
                  setDialogOpen(true);
                }}
              >
                {canManage ? 'Edit environment' : 'View environment'}
              </button>
            )}
          </PopoverContent>
        </Popover>
      ) : (
        <button
          type="button"
          className={cn(contextSegmentClassName, interactiveContextSegmentClassName)}
          aria-label="Set up environment"
          title={`Save setup commands, variables, secrets, a sandbox size, and network access for ${repositoryLabel}.`}
          onClick={() => setDialogOpen(true)}
        >
          {label}
        </button>
      )}
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
