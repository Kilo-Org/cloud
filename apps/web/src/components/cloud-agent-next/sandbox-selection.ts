import {
  getKiloSandboxAllocation,
  getSandboxAllocationResources,
  type SandboxDestination,
  type SandboxSelectionCapabilities,
} from '@kilocode/worker-utils/sandbox-allocation';
import {
  containerCapacityForService,
  formatContainerCapacity,
} from '@/lib/cloudflare/container-capacity';

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

export function formatSandboxProvider(provider: SandboxDestination['provider']): string {
  const account = provider.account === 'byoc' ? 'BYOC' : 'Kilo';
  return `${account} · ${formatSandboxProviderName(provider)}`;
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
