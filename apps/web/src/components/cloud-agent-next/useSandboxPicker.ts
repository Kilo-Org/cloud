'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getSandboxAllocationKey,
  type SandboxSelectionCapabilities,
} from '@kilocode/worker-utils/sandbox-allocation';
import type { RepositoryPlatform } from '@/components/shared/RepositoryCombobox';
import { useTRPC } from '@/lib/trpc/utils';
import {
  getLastUsedSandboxAllocationKey,
  setLastUsedSandboxAllocationKey,
} from './model-preferences';
import {
  DEFAULT_SANDBOX_VALUE,
  getSandboxSelectionGroups,
  getSandboxSelectionOptions,
  resolveSandboxChoice,
  resolveSandboxPicker,
  resolveSandboxSelection,
  type SandboxSelectionDraft,
} from './sandbox-selection';

type SandboxPickerOwner = { organizationId: string | undefined };

/**
 * State of the new session sandbox picker: what the owner offers for the
 * selected repository, the choice made in this panel, and the sandbox this
 * browser last chose for the owner.
 */
export function useSandboxPicker({
  organizationId,
  platform,
  repository,
}: {
  organizationId: string | undefined;
  platform: RepositoryPlatform;
  repository: string;
}) {
  const trpc = useTRPC();
  const [draft, setDraft] = useState<SandboxSelectionDraft>({ organizationId });
  const [lastUsed, setLastUsed] = useState(() => readLastUsed(organizationId));
  // The last answer for this owner keeps the picker in place while the answer
  // for a newly selected repository loads.
  const [previous, setPrevious] = useState<
    (SandboxPickerOwner & { data: SandboxSelectionCapabilities }) | undefined
  >();

  if (draft.organizationId !== organizationId) setDraft({ organizationId });
  if (lastUsed.organizationId !== organizationId) setLastUsed(readLastUsed(organizationId));

  const input = {
    repositoryType: platform,
    ...(repository ? { repositoryFullName: repository } : {}),
  };
  const query = useQuery({
    ...(organizationId
      ? trpc.organizations.cloudAgentNext.getSandboxSelectionOptions.queryOptions({
          organizationId,
          ...input,
        })
      : trpc.cloudAgentNext.getSandboxSelectionOptions.queryOptions(input)),
    retry: false,
  });

  if (
    query.isSuccess &&
    (!previous || previous.data !== query.data || previous.organizationId !== organizationId)
  ) {
    setPrevious({ organizationId, data: query.data });
  }
  const capabilities = query.isSuccess
    ? query.data
    : query.isPending && previous && previous.organizationId === organizationId
      ? previous.data
      : undefined;

  const { sandboxAllocation: draftAllocation, error } = resolveSandboxSelection({
    organizationId,
    draft,
    capabilities,
  });
  const picker = resolveSandboxPicker({ capabilities, draftAllocation, lastUsedKey: lastUsed.key });
  const options = getSandboxSelectionOptions(capabilities);

  const choose = (value: string) => {
    const choice = resolveSandboxChoice(value, picker, options);
    if (!choice) return;
    const key = choice.allocation ? getSandboxAllocationKey(choice.allocation) : undefined;
    setDraft({ organizationId, ...(choice.allocation ? { allocation: choice.allocation } : {}) });
    setLastUsed({ organizationId, key: key ?? null });
    setLastUsedSandboxAllocationKey(key, organizationId);
  };

  return {
    picker,
    groups: getSandboxSelectionGroups(options),
    error,
    // A choice made earlier stays visible even when the owner's options fail to load.
    isVisible: capabilities?.enabled === true || !!draftAllocation,
    query,
    choose,
    chooseDefault: () => choose(DEFAULT_SANDBOX_VALUE),
  };
}

function readLastUsed(organizationId: string | undefined) {
  return { organizationId, key: getLastUsedSandboxAllocationKey(organizationId) };
}
