import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

import { i18n } from '@/i18n';

/**
 * The sandbox-selection capabilities exactly as the backend returns them. Every
 * type below is derived from this router result — never a copied shape — so a
 * backend change to the offered allocation set reaches the mobile labels
 * through the compiler (AGENTS.md: derive mobile types from tRPC results).
 */
export type SandboxSelectionCapabilities =
  inferRouterOutputs<MobileRouter>['cloudAgentNext']['getSandboxSelectionOptions'];

/** One allocation row the backend offers. */
type SandboxAllocationOption = SandboxSelectionCapabilities['options'][number];

/** The allocation a session requests (the shape a picker row carries). */
export type SandboxAllocation = SandboxAllocationOption['allocation'];

/** The backend's own default destination. */
export type SandboxDestination = NonNullable<SandboxSelectionCapabilities['defaultDestination']>;

/** A destination-shaped value (a picked allocation is one). */
type SandboxProviderLike = { provider: SandboxDestination['provider'] };
type SandboxInstanceLike = { instanceType: SandboxDestination['instanceType'] };

/**
 * Provider display names. The account ('kilo') is deliberately absent: every
 * selectable allocation runs under the Kilo account, so naming it on every row
 * would be noise.
 */
const PROVIDER_LABEL_KEYS = {
  cloudflare: 'agentChat.newSession.sandboxProviderCloudflare',
  vercel: 'agentChat.newSession.sandboxProviderVercel',
} satisfies Record<SandboxDestination['provider']['id'], string>;

/**
 * Instance display names. `single` and `small` are the same size on different
 * providers, so they share the "Small" copy; `isolated-standard` is a
 * destination the picker never offers, so it falls back to its raw value.
 */
const INSTANCE_LABEL_KEYS = {
  single: 'agentChat.newSession.sandboxInstanceSmall',
  small: 'agentChat.newSession.sandboxInstanceSmall',
  shared: 'agentChat.newSession.sandboxInstanceShared',
  large: 'agentChat.newSession.sandboxInstanceLarge',
  devcontainer: 'agentChat.newSession.sandboxInstanceDevcontainer',
  default: 'agentChat.newSession.sandboxInstanceProviderDefault',
} satisfies Partial<Record<SandboxDestination['instanceType'], string>>;

export function formatSandboxProviderLabel(destination: SandboxProviderLike): string {
  return i18n.t(PROVIDER_LABEL_KEYS[destination.provider.id]);
}

export function formatSandboxInstanceLabel(destination: SandboxInstanceLike): string {
  const key = INSTANCE_LABEL_KEYS[destination.instanceType as keyof typeof INSTANCE_LABEL_KEYS];
  return key ? i18n.t(key) : destination.instanceType;
}

/** `{{provider}} · {{instance}}` — the picker row and closed-field label. */
export function formatSandboxOptionLabel(destination: SandboxProviderLike & SandboxInstanceLike) {
  return `${formatSandboxProviderLabel(destination)} · ${formatSandboxInstanceLabel(destination)}`;
}

/**
 * The default row's label: `Default · {{destination}}` while the backend names
 * a default, bare "Default" while it does not. The bare copy is the existing
 * `branchDefault` key rather than a new one: two keys holding "Default" would
 * drift, and the sandbox default has no destination to distinguish it.
 */
export function formatSandboxDefaultLabel(destination: SandboxDestination | undefined): string {
  if (!destination) {
    return i18n.t('agentChat.newSession.branchDefault');
  }
  return i18n.t('agentChat.newSession.sandboxDefaultWithDestination', {
    destination: formatSandboxOptionLabel(destination),
  });
}

/** The backend's own allocation identity: `provider:account:instanceType`. */
export function sandboxAllocationKey(allocation: SandboxAllocation): string {
  return `${allocation.provider.id}:${allocation.provider.account}:${allocation.instanceType}`;
}

export function isSameSandboxAllocation(
  left: SandboxAllocation | undefined,
  right: SandboxAllocation | undefined
): boolean {
  if (!left || !right) {
    return false;
  }
  return sandboxAllocationKey(left) === sandboxAllocationKey(right);
}

export type SandboxOptionGroup = {
  key: string;
  label: string;
  options: SandboxSelectionCapabilities['options'];
};

/**
 * The picker rows for the backend capabilities: one group per provider, each
 * carrying the backend's own options in its order. Disabled capabilities render
 * nothing — the form's empty state, with no CTA.
 */
export function resolveSandboxOptionGroups(
  capabilities: SandboxSelectionCapabilities | undefined
): SandboxOptionGroup[] {
  if (!capabilities?.enabled) {
    return [];
  }

  const groups: SandboxOptionGroup[] = [];
  for (const option of capabilities.options) {
    const { provider } = option.allocation;
    const key = `${provider.account}:${provider.id}`;
    let group = groups.find(candidate => candidate.key === key);
    if (!group) {
      group = { key, label: formatSandboxProviderLabel(option.allocation), options: [] };
      groups.push(group);
    }
    group.options.push(option);
  }
  return groups;
}

/**
 * The two non-retryable reasons a picked allocation cannot be submitted,
 * mirroring the web resolver: the owner's capabilities are disabled, or the
 * backend no longer offers the picked allocation. `undefined` means the pick is
 * fine (or nothing is picked, so the backend default applies).
 */
export type SandboxSelectionErrorReason = 'selection-unavailable' | 'not-offered';

export function resolveSandboxSelectionError({
  capabilities,
  allocation,
}: {
  capabilities: SandboxSelectionCapabilities | undefined;
  allocation: SandboxAllocation | undefined;
}): SandboxSelectionErrorReason | undefined {
  if (!allocation) {
    return undefined;
  }
  if (!capabilities?.enabled) {
    return 'selection-unavailable';
  }
  const offered = capabilities.options.some(option =>
    isSameSandboxAllocation(option.allocation, allocation)
  );
  return offered ? undefined : 'not-offered';
}
