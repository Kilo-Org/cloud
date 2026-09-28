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
  devcontainer: 'Dev container',
  small: 'Small',
  large: 'Medium',
  default: 'Provider default',
};

/**
 * Names the account whose cloud runs the sandbox alongside the provider. Both
 * halves stay visible because a BYOC account can offer the same provider as Kilo.
 */
export function formatSandboxProvider(provider: SandboxDestination['provider']): string {
  return `${accountLabels[provider.account]} · ${providerLabels[provider.id]}`;
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
  const options = capabilities?.enabled ? [...capabilities.options] : [];

  // Display order for the picker: BYOC accounts first, then one block per
  // provider, keeping each provider's instances in the order the Worker offers.
  return options.sort(
    (a, b) =>
      Number(a.allocation.provider.account !== 'byoc') -
        Number(b.allocation.provider.account !== 'byoc') ||
      a.allocation.provider.id.localeCompare(b.allocation.provider.id)
  );
}

export function getPreferredInitialSandboxAllocation({
  options,
  lastUsedKey,
}: {
  options: SandboxSelectionCapabilities['options'];
  lastUsedKey: string | null;
}): SelectableSandboxAllocationRequest | undefined {
  if (!lastUsedKey) return undefined;
  return options.find(option => getSandboxAllocationKey(option.allocation) === lastUsedKey)
    ?.allocation;
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
  devcontainer,
}: {
  organizationId: string | undefined;
  draft: SandboxSelectionDraft;
  capabilities: SandboxSelectionCapabilities | undefined;
  devcontainer: boolean;
}): { sandboxAllocation?: SelectableSandboxAllocationRequest; error?: string } {
  if (draft.organizationId !== organizationId || devcontainer || !draft.allocation) {
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

  return { sandboxAllocation: draft.allocation };
}
