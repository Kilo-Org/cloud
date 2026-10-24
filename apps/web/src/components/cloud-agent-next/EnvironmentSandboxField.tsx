'use client';

import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SelectableSandboxAllocation } from '@kilocode/worker-utils/sandbox-allocation';
import { Label } from '@/components/ui/label';
import { useTRPC } from '@/lib/trpc/utils';
import type { EnvironmentRepository } from '@/hooks/useCloudAgentEnvironments';
import { SandboxSelect } from './settings/SandboxSelect';
import { describeDefaultSandbox, getEligibleAllocationChoices } from './settings/settings-options';

type EnvironmentSandboxFieldProps = {
  organizationId?: string;
  repository: { platform: EnvironmentRepository['platform']; fullName: string };
  value: SelectableSandboxAllocation | null;
  disabled: boolean;
  onChange: (value: SelectableSandboxAllocation | null) => void;
};

/**
 * The sandbox new sessions in this repository start in. Hidden when the owner
 * cannot choose a sandbox and nothing is saved.
 */
export function EnvironmentSandboxField({
  organizationId,
  repository,
  value,
  disabled,
  onChange,
}: EnvironmentSandboxFieldProps) {
  const labelId = useId();
  const trpc = useTRPC();
  const input = { repositoryType: repository.platform, repositoryFullName: repository.fullName };
  const { data: capabilities, isPending } = useQuery({
    ...(organizationId
      ? trpc.organizations.cloudAgentNext.getSandboxSelectionOptions.queryOptions({
          organizationId,
          ...input,
        })
      : trpc.cloudAgentNext.getSandboxSelectionOptions.queryOptions(input)),
    retry: false,
  });

  if (!value && !capabilities?.enabled) return null;

  return (
    <div className="grid gap-2">
      <Label id={labelId} className="text-xs">
        Sandbox size
      </Label>
      <SandboxSelect
        value={value}
        choices={getEligibleAllocationChoices(capabilities)}
        unavailableReason={undefined}
        noneLabel="Use default size"
        noneDescription={describeDefaultSandbox(
          capabilities?.effectiveDestination ?? capabilities?.defaultDestination
        )}
        labelledBy={labelId}
        disabled={disabled || isPending}
        onChange={onChange}
      />
    </div>
  );
}
