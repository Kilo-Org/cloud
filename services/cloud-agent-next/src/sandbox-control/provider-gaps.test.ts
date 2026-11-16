import { describe, expect, it } from 'vitest';
import {
  SANDBOX_PROVIDER_CAPABILITIES,
  SANDBOX_PROVIDER_FEATURES,
  type SandboxProviderFeature,
} from '@kilocode/worker-utils/sandbox-provider-capabilities';
import {
  AGENT_SANDBOX_PROVIDERS,
  PROVIDER_DESCRIPTORS,
  type AgentSandboxProvider,
} from '../shared/sandbox-provider.js';

type ProviderGap = {
  provider: AgentSandboxProvider;
  feature: SandboxProviderFeature;
  /**
   * `gap`: not built yet; delete the line when the provider gains the feature.
   * `intentional`: a product decision; the feature does not apply.
   * `retired`: the provider is retired and starts no new compute.
   */
  class: 'gap' | 'intentional' | 'retired';
  reason: string;
};

const RETIRED = 'The retired runtime starts no new compute.';

/**
 * Every `false` entry in the provider capability table. This list only
 * shrinks: a provider reaches parity when it has no `gap` entry.
 */
const PROVIDER_GAPS: readonly ProviderGap[] = [
  {
    provider: 'vercel',
    feature: 'workspaceSnapshots',
    class: 'gap',
    reason: 'The adapter has no per-workspace capture and restore.',
  },
  {
    provider: 'vercel',
    feature: 'egressPolicy',
    class: 'gap',
    reason: 'The allowlist and the audit do not map to the Vercel network policy.',
  },
  {
    provider: 'vercel',
    feature: 'multiRepository',
    class: 'gap',
    reason: 'The network policy forwards only the launch repository capability.',
  },
  {
    provider: 'vercel',
    feature: 'meteredBilling',
    class: 'intentional',
    reason: 'The customer pays Vercel; Kilo does not meter BYOC compute.',
  },
  { provider: 'cloudflare', feature: 'preview', class: 'retired', reason: RETIRED },
  { provider: 'cloudflare', feature: 'workspaceSnapshots', class: 'retired', reason: RETIRED },
  { provider: 'cloudflare', feature: 'environmentSnapshots', class: 'retired', reason: RETIRED },
  { provider: 'cloudflare', feature: 'egressPolicy', class: 'retired', reason: RETIRED },
  { provider: 'cloudflare', feature: 'meteredBilling', class: 'retired', reason: RETIRED },
];

const key = (provider: string, feature: string) => `${provider}.${feature}`;

describe('provider gap list', () => {
  it('lists every unsupported feature exactly once, and nothing else', () => {
    const unsupported = AGENT_SANDBOX_PROVIDERS.flatMap(provider =>
      SANDBOX_PROVIDER_FEATURES.filter(
        feature => !SANDBOX_PROVIDER_CAPABILITIES[provider][feature]
      ).map(feature => key(provider, feature))
    );
    const listed = PROVIDER_GAPS.map(gap => key(gap.provider, gap.feature));
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...unsupported].sort());
  });

  it('uses the retired class exactly for retired providers', () => {
    for (const gap of PROVIDER_GAPS) {
      expect(gap.class === 'retired', key(gap.provider, gap.feature)).toBe(
        PROVIDER_DESCRIPTORS[gap.provider].retired
      );
    }
  });

  it('gives each entry a reason', () => {
    for (const gap of PROVIDER_GAPS) expect(gap.reason.trim()).not.toBe('');
  });
});
