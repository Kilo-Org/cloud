'use client';

import { useId, type ReactNode } from 'react';
import { Github, Gitlab } from 'lucide-react';
import type { SelectableSandboxAllocation } from '@kilocode/worker-utils/sandbox-allocation';
import type { CloudAgentSettingsRepositoryRow } from '@/hooks/useCloudAgentSettings';
import { ProfileSelect, type ProfileOption } from './ProfileSelect';
import { SandboxSelect } from './SandboxSelect';
import {
  splitRepositoryName,
  toSelectableAllocation,
  type DefaultSandboxDescription,
  type SandboxAllocationChoice,
} from './settings-options';

type RepositoryRowProps = {
  row: CloudAgentSettingsRepositoryRow;
  profiles: ProfileOption[];
  choices: SandboxAllocationChoice[];
  /** Set only where the sandbox cannot be chosen, so the row shows where sessions run. */
  fixedSandbox?: DefaultSandboxDescription;
  disabled: boolean;
  action: ReactNode;
  onProfileChange: (profileId: string | null) => void;
  onAllocationChange: (allocation: SelectableSandboxAllocation | null) => void;
  onManageProfiles: () => void;
};

export function RepositoryRow({
  row,
  profiles,
  choices,
  fixedSandbox,
  disabled,
  action,
  onProfileChange,
  onAllocationChange,
  onManageProfiles,
}: RepositoryRowProps) {
  const nameId = useId();
  const profileLabelId = useId();
  const sandboxLabelId = useId();
  const { owner, name } = splitRepositoryName(row.repositoryFullName);
  const isGitLab = row.repositoryPlatform === 'gitlab';
  const PlatformIcon = isGitLab ? Gitlab : Github;

  return (
    <li className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2">
        <PlatformIcon
          role="img"
          aria-label={isGitLab ? 'GitLab' : 'GitHub'}
          className="text-muted-foreground size-4 shrink-0"
        />
        <span
          id={nameId}
          title={row.repositoryFullName}
          className="min-w-0 flex-1 text-sm font-medium wrap-break-word"
        >
          <span className="text-muted-foreground font-normal">{owner}</span>
          <wbr />
          {name}
        </span>
        {action}
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span id={profileLabelId} className="text-muted-foreground text-xs font-medium">
            Profile
          </span>
          <ProfileSelect
            profileId={row.profileId}
            savedName={row.profileName}
            profiles={profiles}
            labelledBy={`${profileLabelId} ${nameId}`}
            disabled={disabled}
            onChange={onProfileChange}
            onManage={onManageProfiles}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span id={sandboxLabelId} className="text-muted-foreground text-xs font-medium">
            Sandbox
          </span>
          <SandboxSelect
            value={toSelectableAllocation(row.allocation)}
            choices={choices}
            unavailableReason={
              row.allocationRepositoryUnavailableReason ?? row.allocationUnavailableReason
            }
            noneLabel="Default"
            noneDescription={fixedSandbox}
            labelledBy={`${sandboxLabelId} ${nameId}`}
            disabled={disabled}
            onChange={onAllocationChange}
          />
        </div>
      </div>
    </li>
  );
}
