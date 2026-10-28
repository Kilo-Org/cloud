import {
  SELECTABLE_SANDBOX_ALLOCATIONS,
  getSandboxAllocation,
  getSandboxAllocationRequest,
  isSelectableSandboxAllocation,
  type SandboxDestination,
  type SandboxSelectionCapabilities,
  type SelectableSandboxAllocation,
} from '@kilocode/worker-utils/sandbox-allocation';
import {
  formatSandboxCapacity,
  formatSandboxInstance,
  formatSandboxProviderName,
  getSandboxSelectionOptions,
} from '../sandbox-selection';

export type SandboxAllocationChoice = {
  allocation: SelectableSandboxAllocation;
  provider: string;
  instance: string;
  summary: string;
  unavailableReason?: string;
};

export type SandboxAllocationGroup = {
  provider: string;
  choices: SandboxAllocationChoice[];
};

function toChoice(
  allocation: SelectableSandboxAllocation,
  destination: SandboxDestination
): SandboxAllocationChoice {
  const provider = formatSandboxProviderName(destination.provider);
  return {
    allocation,
    provider,
    instance: formatSandboxInstance(destination),
    summary: `${provider} · ${formatSandboxCapacity(destination)}`,
  };
}

export type DefaultSandboxDescription = {
  /** Provider and capacity, as a selected choice reads. */
  summary: string;
  /** Provider and full instance, for a place that offers no choice. */
  full: string;
};

/** Names the sandbox a session uses when nothing is chosen. */
export function describeDefaultSandbox(
  destination: SandboxDestination | undefined
): DefaultSandboxDescription | undefined {
  if (!destination) return undefined;
  const provider = formatSandboxProviderName(destination.provider);
  return {
    summary: `${provider} · ${formatSandboxCapacity(destination)}`,
    full: `${provider} · ${formatSandboxInstance(destination)}`,
  };
}

export function getEligibleAllocationChoices(
  capabilities: SandboxSelectionCapabilities | undefined
): SandboxAllocationChoice[] {
  return getSandboxSelectionOptions(capabilities).flatMap(option => {
    const allocation = getSandboxAllocation(option.allocation);
    return allocation && isSelectableSandboxAllocation(allocation)
      ? [toChoice(allocation, option.allocation)]
      : [];
  });
}

export function withSavedChoice(
  choices: SandboxAllocationChoice[],
  saved: string | null,
  unavailableReason: string | undefined
): SandboxAllocationChoice[] {
  const allocation = toSelectableAllocation(saved);
  if (!allocation || choices.some(choice => choice.allocation === allocation)) return choices;
  return [
    ...choices,
    {
      ...toChoice(allocation, getSandboxAllocationRequest(allocation)),
      unavailableReason: unavailableReason ?? 'This sandbox is unavailable',
    },
  ];
}

export function groupChoicesByProvider(
  choices: SandboxAllocationChoice[]
): SandboxAllocationGroup[] {
  const groups: SandboxAllocationGroup[] = [];
  for (const choice of choices) {
    const group = groups.find(candidate => candidate.provider === choice.provider);
    if (group) {
      group.choices.push(choice);
    } else {
      groups.push({ provider: choice.provider, choices: [choice] });
    }
  }
  return groups;
}

export function describeUnavailableSandbox(reason: string): string {
  const sentence = /[.!?]$/.test(reason) ? reason : `${reason}.`;
  return `${sentence} Sessions use the next available default.`;
}

export function toSelectableAllocation(value: string | null): SelectableSandboxAllocation | null {
  if (!value) return null;
  return SELECTABLE_SANDBOX_ALLOCATIONS.find(allocation => allocation === value) ?? null;
}

export function repositoryRowKey(fullName: string, platform: string): string {
  return `${platform}:${fullName.trim().toLowerCase()}`;
}

export function splitRepositoryName(fullName: string): { owner: string; name: string } {
  const separator = fullName.lastIndexOf('/') + 1;
  return { owner: fullName.slice(0, separator), name: fullName.slice(separator) };
}

export function excludeListedRepositories<
  T extends { fullName: string; platform: 'github' | 'gitlab' },
>(
  repositories: T[],
  listed: ReadonlyArray<{ repositoryFullName: string; repositoryPlatform: string }>
): T[] {
  const listedKeys = new Set(
    listed.map(row => repositoryRowKey(row.repositoryFullName, row.repositoryPlatform))
  );
  return repositories.filter(
    repo => !listedKeys.has(repositoryRowKey(repo.fullName, repo.platform))
  );
}
