import {
  getSandboxAllocationKey,
  type SelectableSandboxAllocationRequest,
  type SandboxDestination,
  type SandboxSelectionCapabilities,
} from '@kilocode/worker-utils/sandbox-allocation';
import { containerCapacityForService } from '@/lib/cloudflare/container-capacity';
import type { CloudSessionCreationOperation } from './types';

const accountLabels: Record<SandboxDestination['provider']['account'], string> = {
  kilo: 'Kilo',
  byoc: 'BYOC',
};

const providerLabels: Record<SandboxDestination['provider']['id'], string> = {
  cloudflare: 'Cloudflare',
  vercel: 'Vercel',
};

const cloudflareServices: Partial<Record<SandboxDestination['instanceType'], string>> = {
  single: 'cloud-agent-next-sandbox-small',
  shared: 'cloud-agent-next-sandbox',
  'isolated-standard': 'cloud-agent-next-sandbox',
  devcontainer: 'cloud-agent-next-sandbox-dind',
};

const instanceLabels: Record<SandboxDestination['instanceType'], string> = {
  single: 'Single',
  shared: 'Shared',
  'isolated-standard': 'Dedicated Standard',
  devcontainer: 'Dev container',
  small: '2 vCPU / 4 GiB',
  large: '4 vCPU / 8 GiB',
  default: 'Provider default',
};

export function formatSandboxInstance(destination: SandboxDestination): string {
  const label = instanceLabels[destination.instanceType];
  if (destination.provider.id !== 'cloudflare') return label;

  const service = cloudflareServices[destination.instanceType];
  const capacity = service ? containerCapacityForService(service) : null;
  return capacity
    ? `${capacity.vcpu} vCPU / ${capacity.memoryBytes / 1024 ** 3} GiB · ${label}`
    : label;
}

export function formatSandboxDestination(destination: SandboxDestination | undefined): string {
  if (!destination) return 'Default';

  const account = accountLabels[destination.provider.account];
  const provider = providerLabels[destination.provider.id];
  return `${account} · ${provider} · ${formatSandboxInstance(destination)}`;
}

type SandboxSelectionGroup = {
  account: SandboxDestination['provider']['account'];
  label: string;
  providers: Array<{
    id: SandboxDestination['provider']['id'];
    label: string;
    options: SandboxSelectionCapabilities['options'];
  }>;
};

export function getSandboxSelectionGroups(
  options: SandboxSelectionCapabilities['options']
): SandboxSelectionGroup[] {
  const groups: SandboxSelectionGroup[] = [];
  for (const option of options) {
    const { account, id } = option.allocation.provider;
    let group = groups.find(group => group.account === account);
    if (!group) {
      group = { account, label: accountLabels[account], providers: [] };
      groups.push(group);
    }
    let provider = group.providers.find(provider => provider.id === id);
    if (!provider) {
      provider = { id, label: providerLabels[id], options: [] };
      group.providers.push(provider);
    }
    provider.options.push(option);
  }
  for (const group of groups) {
    group.providers.sort((a, b) => a.id.localeCompare(b.id));
  }
  return groups;
}

export function getSandboxSelectionOptions(
  capabilities: SandboxSelectionCapabilities | undefined,
  selectedAllocation?: SelectableSandboxAllocationRequest
): SandboxSelectionCapabilities['options'] {
  const options = capabilities?.enabled ? [...capabilities.options] : [];
  if (
    selectedAllocation &&
    !options.some(
      option =>
        getSandboxAllocationKey(option.allocation) === getSandboxAllocationKey(selectedAllocation)
    )
  ) {
    options.push({
      allocation: selectedAllocation,
      available: false,
      reason: 'Unavailable for this organization',
    });
  }

  return options.sort(
    (a, b) =>
      Number(a.allocation.provider.account !== 'byoc') -
      Number(b.allocation.provider.account !== 'byoc')
  );
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
  if (
    !organizationId ||
    draft.organizationId !== organizationId ||
    devcontainer ||
    !draft.allocation
  ) {
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
  if (!option?.available) {
    return {
      sandboxAllocation: draft.allocation,
      error: option?.reason ?? 'This sandbox is unavailable. Choose another sandbox or Default.',
    };
  }

  return { sandboxAllocation: draft.allocation };
}
