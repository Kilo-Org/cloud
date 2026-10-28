'use client';

import { useId, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import type { SelectableSandboxAllocation } from '@kilocode/worker-utils/sandbox-allocation';
import { Button } from '@/components/ui/button';
import { useCombinedProfiles, useProfiles } from '@/hooks/useCloudAgentProfiles';
import {
  useRemoveRepositorySettingsMutation,
  useSetRepositorySettingsMutation,
  type CloudAgentSettingsData,
  type CloudAgentSettingsRepositoryRow,
} from '@/hooks/useCloudAgentSettings';
import { RepositoryPicker, type RepositoryOption } from './RepositoryPicker';
import { RepositoryRow } from './RepositoryRow';
import {
  describeDefaultSandbox,
  getEligibleAllocationChoices,
  repositoryRowKey,
  toSelectableAllocation,
} from './settings-options';

type RowValues = {
  profileId: string | null;
  allocation: SelectableSandboxAllocation | null;
};

type RepositoryOverridesSectionProps = {
  organizationId?: string;
  settings: CloudAgentSettingsData;
  onManageProfiles: () => void;
};

const rowKey = (row: CloudAgentSettingsRepositoryRow) =>
  repositoryRowKey(row.repositoryFullName, row.repositoryPlatform);

const toDraftRow = (repository: RepositoryOption): CloudAgentSettingsRepositoryRow => ({
  repositoryFullName: repository.fullName,
  repositoryPlatform: repository.platform,
  profileId: null,
  profileName: null,
  allocation: null,
});

export function RepositoryOverridesSection({
  organizationId,
  settings,
  onManageProfiles,
}: RepositoryOverridesSectionProps) {
  const { canManage, repositories, capabilitiesByPlatform } = settings;
  const headingId = useId();
  const save = useSetRepositorySettingsMutation(organizationId);
  const remove = useRemoveRepositorySettingsMutation(organizationId);
  const [draft, setDraft] = useState<RepositoryOption | null>(null);

  const personalProfiles = useProfiles({ organizationId: undefined, enabled: !organizationId });
  const combinedProfiles = useCombinedProfiles({
    organizationId: organizationId ?? '',
    enabled: !!organizationId,
  });
  const profiles = organizationId
    ? (combinedProfiles.data?.orgProfiles ?? [])
    : (personalProfiles.data ?? []);

  const disabled = !canManage || save.isPending || remove.isPending;
  const { enabled: canChooseSandbox, defaultDestination } = settings.capabilities;
  const fixedSandbox = canChooseSandbox ? undefined : describeDefaultSandbox(defaultDestination);
  const pending = save.isPending ? save.variables : undefined;

  const showPending = (row: CloudAgentSettingsRepositoryRow): CloudAgentSettingsRepositoryRow =>
    pending && repositoryRowKey(pending.repoFullName, pending.platform) === rowKey(row)
      ? { ...row, profileId: pending.profileId ?? null, allocation: pending.allocation ?? null }
      : row;

  const saveValues = (
    repository: { fullName: string; platform: 'github' | 'gitlab' },
    values: RowValues,
    onSaved?: () => void
  ) =>
    save.mutate(
      {
        organizationId,
        repoFullName: repository.fullName,
        platform: repository.platform,
        ...values,
      },
      { onSuccess: onSaved, onError: error => toast.error(error.message) }
    );

  const changeRow = (row: CloudAgentSettingsRepositoryRow, patch: Partial<RowValues>) =>
    saveValues(
      { fullName: row.repositoryFullName, platform: row.repositoryPlatform },
      { profileId: row.profileId, allocation: toSelectableAllocation(row.allocation), ...patch }
    );

  const changeDraft = (current: RepositoryOption, patch: Partial<RowValues>) => {
    const values = { profileId: null, allocation: null, ...patch };
    if (!values.profileId && !values.allocation) return;
    saveValues(current, values, () => {
      setDraft(null);
      toast.success(`Added overrides for ${current.fullName}`);
    });
  };

  const removeRow = (row: CloudAgentSettingsRepositoryRow) =>
    remove.mutate(
      { organizationId, repoFullName: row.repositoryFullName, platform: row.repositoryPlatform },
      {
        onSuccess: () => toast.success(`Removed overrides for ${row.repositoryFullName}`),
        onError: error => toast.error(error.message),
      }
    );

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 id={headingId} className="text-sm font-medium">
          Repository overrides
        </h3>
        <RepositoryPicker
          organizationId={organizationId}
          listed={repositories}
          disabled={disabled}
          onSelect={setDraft}
        />
      </div>

      {repositories.length === 0 && !draft ? (
        <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-sm">
          No overrides yet. Repositories use the default sandbox and profile.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {draft && (
            <RepositoryRow
              key={`draft:${draft.platform}:${draft.fullName}`}
              row={showPending(toDraftRow(draft))}
              profiles={profiles}
              choices={getEligibleAllocationChoices(capabilitiesByPlatform[draft.platform])}
              fixedSandbox={fixedSandbox}
              disabled={disabled}
              action={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground -my-1.5 -mr-1.5"
                  aria-label={`Discard ${draft.fullName}`}
                  disabled={disabled}
                  onClick={() => setDraft(null)}
                >
                  <X />
                </Button>
              }
              onProfileChange={profileId => changeDraft(draft, { profileId })}
              onAllocationChange={allocation => changeDraft(draft, { allocation })}
              onManageProfiles={onManageProfiles}
            />
          )}
          {repositories.map(row => {
            const shown = showPending(row);
            return (
              <RepositoryRow
                key={rowKey(row)}
                row={shown}
                profiles={profiles}
                choices={getEligibleAllocationChoices(
                  capabilitiesByPlatform[row.repositoryPlatform]
                )}
                fixedSandbox={fixedSandbox}
                disabled={disabled}
                action={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-destructive -my-1.5 -mr-1.5"
                    aria-label={`Remove overrides for ${row.repositoryFullName}`}
                    disabled={disabled}
                    onClick={() => removeRow(row)}
                  >
                    <Trash2 />
                  </Button>
                }
                onProfileChange={profileId => changeRow(shown, { profileId })}
                onAllocationChange={allocation => changeRow(shown, { allocation })}
                onManageProfiles={onManageProfiles}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}
