import {
  getKiloSandboxAllocation,
  getSandboxAllocationKey,
  getSandboxAllocationResources,
  type SelectableSandboxAllocationRequest,
  type SandboxDestination,
  type SandboxSelectionCapabilities,
} from '@kilocode/worker-utils/sandbox-allocation';
import {
  containerCapacityForService,
  formatContainerCapacity,
} from '@/lib/cloudflare/container-capacity';
import type { CloudSessionCreationOperation } from './types';

const accountLabels: Record<SandboxDestination['provider']['account'], string> = {
  kilo: 'Kilo',
  byoc: 'BYOC',
};

const providerLabels: Record<SandboxDestination['provider']['id'], string> = {
  cloudflare: 'Cloudflare',
  'cloudflare-containers': 'Cloudflare Containers',
  vercel: 'Vercel',
};

const cloudflareServices: Partial<Record<SandboxDestination['instanceType'], string>> = {
  single: 'cloud-agent-next-sandbox-small',
  shared: 'cloud-agent-next-sandbox',
  'isolated-standard': 'cloud-agent-next-sandbox',
  devcontainer: 'cloud-agent-next-sandbox-dind',
  'standard-3': 'cloud-agent-next-sandbox-containers-standard3',
  'standard-4': 'cloud-agent-next-sandbox-containers-standard4',
};

const instanceLabels: Record<SandboxDestination['instanceType'], string> = {
  single: 'Small',
  shared: 'Large · Shared',
  'isolated-standard': 'Large',
  'standard-3': 'Medium',
  'standard-4': 'Large',
  devcontainer: 'Retired devcontainer',
  small: 'Small',
  large: 'Medium',
  default: 'Provider default',
};

/**
 * Names the account whose cloud runs the sandbox alongside the provider. Both
 * halves stay visible because a BYOC account can offer the same provider as Kilo.
 */
export function formatSandboxProvider(provider: SandboxDestination['provider']): string {
  return `${accountLabels[provider.account]} · ${formatSandboxProviderName(provider)}`;
}

export function formatSandboxProviderName(provider: SandboxDestination['provider']): string {
  return providerLabels[provider.id];
}

/**
 * Formats the fixed Vercel instance resources. Both accounts run the same
 * hardware, so the Kilo allocation is the existing mapping to the single
 * resource table in worker-utils.
 */
function formatVercelCapacity(instanceType: 'small' | 'large'): string | null {
  const resources = getSandboxAllocationResources(
    getKiloSandboxAllocation({ provider: { id: 'vercel', account: 'kilo' }, instanceType })
  );
  return resources
    ? formatContainerCapacity({
        vcpu: resources.vcpus,
        memoryBytes: resources.memory * 1024 ** 2,
      })
    : null;
}

function sandboxDestinationCapacity(destination: SandboxDestination): string | null {
  const service = cloudflareServices[destination.instanceType];
  if (service) {
    const capacity = containerCapacityForService(service);
    return capacity ? formatContainerCapacity(capacity) : null;
  }
  const { instanceType } = destination;
  if (
    destination.provider.id === 'vercel' &&
    (instanceType === 'small' || instanceType === 'large')
  ) {
    return formatVercelCapacity(instanceType);
  }
  return null;
}

/**
 * Splits an instance into the capacity every provider can be compared by and the
 * tenancy tier only the provider names on top of it.
 */
function getSandboxInstanceLabels(destination: SandboxDestination): {
  capacity: string;
  tier?: string;
} {
  const name = instanceLabels[destination.instanceType];
  const capacity = sandboxDestinationCapacity(destination);
  return capacity ? { capacity, tier: name } : { capacity: name };
}

export function formatSandboxCapacity(destination: SandboxDestination): string {
  return getSandboxInstanceLabels(destination).capacity;
}

export function formatSandboxInstance(destination: SandboxDestination): string {
  const { capacity, tier } = getSandboxInstanceLabels(destination);
  return tier ? `${capacity} · ${tier}` : capacity;
}

export function formatSandboxDestination(destination: SandboxDestination | undefined): string {
  if (!destination) return 'Default';
  return `${formatSandboxProvider(destination.provider)} · ${formatSandboxInstance(destination)}`;
}

/**
 * Trigger label. Capacity is the part users weigh when picking a sandbox, so it
 * stays; the tenancy tier waits for the open menu. Instances without a resolved
 * capacity fall back to the name.
 */
export function formatSandboxDestinationWithoutTier(
  destination: SandboxDestination | undefined
): string {
  if (!destination) return 'Default';
  return `${formatSandboxProvider(destination.provider)} · ${formatSandboxCapacity(destination)}`;
}

type SandboxSelectionGroup = {
  key: string;
  label: string;
  options: SandboxSelectionCapabilities['options'];
};

export function getSandboxSelectionGroups(
  options: SandboxSelectionCapabilities['options']
): SandboxSelectionGroup[] {
  const groups: SandboxSelectionGroup[] = [];
  for (const option of options) {
    const { provider } = option.allocation;
    const key = `${provider.account}:${provider.id}`;
    let group = groups.find(group => group.key === key);
    if (!group) {
      group = { key, label: formatSandboxProvider(provider), options: [] };
      groups.push(group);
    }
    group.options.push(option);
  }
  return groups;
}

export function getSandboxSelectionOptions(
  capabilities: SandboxSelectionCapabilities | undefined
): SandboxSelectionCapabilities['options'] {
  const options = capabilities?.enabled
    ? capabilities.options.filter(
        option =>
          option.unavailableReason === undefined && option.repositoryUnavailableReason === undefined
      )
    : [];

  // Display order for the picker: BYOC accounts first, then one block per
  // provider, keeping each provider's instances in the order the Worker offers.
  return options.sort(
    (a, b) =>
      Number(a.allocation.provider.account !== 'byoc') -
        Number(b.allocation.provider.account !== 'byoc') ||
      a.allocation.provider.id.localeCompare(b.allocation.provider.id)
  );
}

/** Select value for a default that no listed option matches, such as a provider-chosen instance. */
export const DEFAULT_SANDBOX_VALUE = 'default';

export type SandboxPickerState = {
  /** Select value: the key of the listed option, or `DEFAULT_SANDBOX_VALUE`. */
  value: string;
  /** Key of the option that is the default, when the default is a listed option. */
  defaultKey: string | undefined;
  /** Where a session starts without a choice: saved repository or owner default, else platform. */
  defaultDestination: SandboxDestination | undefined;
  /** The choice to send. Undefined leaves the saved default to the server. */
  allocation: SelectableSandboxAllocationRequest | undefined;
  /** What the trigger shows. */
  destination: SandboxDestination | undefined;
};

/**
 * Decides what the new session picker shows and sends. A choice made in this
 * panel wins, then the sandbox last chosen in this browser while it is still
 * offered for the repository, then the default. A remembered choice that the
 * repository cannot use falls back to the default instead of raising an error.
 */
export function resolveSandboxPicker({
  capabilities,
  draftAllocation,
  lastUsedKey,
}: {
  capabilities: SandboxSelectionCapabilities | undefined;
  draftAllocation: SelectableSandboxAllocationRequest | undefined;
  lastUsedKey: string | null;
}): SandboxPickerState {
  const defaultDestination = capabilities?.effectiveDestination ?? capabilities?.defaultDestination;
  const options = getSandboxSelectionOptions(capabilities);
  const defaultKey =
    defaultDestination &&
    options.find(option => isSameSandbox(option.allocation, defaultDestination))
      ? getSandboxAllocationKey(defaultDestination)
      : undefined;
  const remembered =
    lastUsedKey && lastUsedKey !== defaultKey
      ? options.find(option => getSandboxAllocationKey(option.allocation) === lastUsedKey)
          ?.allocation
      : undefined;
  const allocation = draftAllocation ?? remembered;

  return {
    value: allocation ? getSandboxAllocationKey(allocation) : (defaultKey ?? DEFAULT_SANDBOX_VALUE),
    defaultKey,
    defaultDestination,
    allocation,
    destination: allocation ?? defaultDestination,
  };
}

/** Maps a picked select value to a choice. `undefined` means keep the default. */
export function resolveSandboxChoice(
  value: string,
  picker: Pick<SandboxPickerState, 'defaultKey'>,
  options: SandboxSelectionCapabilities['options']
): { allocation: SelectableSandboxAllocationRequest | undefined } | undefined {
  if (value === DEFAULT_SANDBOX_VALUE || value === picker.defaultKey) {
    return { allocation: undefined };
  }
  const option = options.find(option => getSandboxAllocationKey(option.allocation) === value);
  return option ? { allocation: option.allocation } : undefined;
}

function isSameSandbox(a: SandboxDestination, b: SandboxDestination): boolean {
  return getSandboxAllocationKey(a) === getSandboxAllocationKey(b);
}

export function resolveSandboxSelectionSubmissionError({
  error,
  intent,
  pendingOperation,
}: {
  error: string | undefined;
  intent: string;
  pendingOperation: CloudSessionCreationOperation | null;
}): string | undefined {
  return pendingOperation?.intent === intent ? undefined : error;
}

export type SandboxSelectionDraft = {
  organizationId: string | undefined;
  allocation?: SelectableSandboxAllocationRequest;
};

export function resolveSandboxSelection({
  organizationId,
  draft,
  capabilities,
}: {
  organizationId: string | undefined;
  draft: SandboxSelectionDraft;
  capabilities: SandboxSelectionCapabilities | undefined;
}): { sandboxAllocation?: SelectableSandboxAllocationRequest; error?: string } {
  if (draft.organizationId !== organizationId || !draft.allocation) {
    return {};
  }

  if (!capabilities?.enabled) {
    return {
      sandboxAllocation: draft.allocation,
      error: 'Sandbox selection is unavailable. Retry or choose Default to continue.',
    };
  }

  const selectedKey = getSandboxAllocationKey(draft.allocation);
  const option = capabilities.options.find(
    option => getSandboxAllocationKey(option.allocation) === selectedKey
  );
  if (!option) {
    return {
      sandboxAllocation: draft.allocation,
      error: 'This sandbox is unavailable. Choose another sandbox or Default.',
    };
  }

  const unavailableReason = option.repositoryUnavailableReason ?? option.unavailableReason;
  if (unavailableReason) {
    return { sandboxAllocation: draft.allocation, error: unavailableReason };
  }

  return { sandboxAllocation: draft.allocation };
}
