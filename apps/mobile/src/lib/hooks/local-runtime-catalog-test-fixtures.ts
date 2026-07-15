import { type LocalRuntime } from '@/lib/hooks/runtime-discovery-logic';

import { type LocalRuntimeCatalog } from './local-runtime-catalog-types';

export const RUNTIME_A = {
  runtimeId: '11111111-1111-4111-8111-111111111111',
  connectionId: 'cli-a',
  protocolVersion: 1 as const,
  cliVersion: '1.2.3',
  displayName: 'Mac A',
  projectName: 'kilo',
  capabilities: ['catalog.v1', 'create-and-run.v1'] as LocalRuntime['capabilities'],
};
export const RUNTIME_B = {
  runtimeId: '22222222-2222-4222-8222-222222222222',
  connectionId: 'cli-b',
  protocolVersion: 1 as const,
  cliVersion: '1.2.3',
  displayName: 'Mac B',
  projectName: 'kilo',
  capabilities: ['catalog.v1', 'create-and-run.v1'] as LocalRuntime['capabilities'],
};
export const RUNTIME_INCAPABLE = {
  runtimeId: '33333333-3333-4333-8333-333333333333',
  connectionId: 'cli-c',
  protocolVersion: 1 as const,
  cliVersion: '1.2.3',
  displayName: 'Mac C',
  projectName: 'kilo',
  capabilities: ['create-and-run.v1'] as LocalRuntime['capabilities'],
};

export function makeRuntime(overrides: Partial<LocalRuntime> = {}): LocalRuntime {
  return { ...RUNTIME_A, ...overrides };
}

type CatalogOverrides = {
  defaultAgent?: string;
  agents?: LocalRuntimeCatalog['agents'];
  defaultModel?: LocalRuntimeCatalog['models']['defaultModel'];
  providers?: LocalRuntimeCatalog['models']['providers'];
};

export function makeCatalog(overrides: Partial<CatalogOverrides> = {}): LocalRuntimeCatalog {
  return {
    protocolVersion: 1,
    models: {
      protocolVersion: 1,
      providers: overrides.providers ?? [
        {
          id: 'anthropic',
          name: 'Anthropic',
          models: [{ id: 'claude-1', name: 'Claude 1', variants: ['low', 'high'] }],
        },
      ],
      ...(overrides.defaultModel ? { defaultModel: overrides.defaultModel } : {}),
      truncated: false,
    },
    agents: overrides.agents ?? [
      { slug: 'build', name: 'Build' },
      { slug: 'plan', name: 'Plan' },
    ],
    defaultAgent: overrides.defaultAgent ?? 'build',
  };
}
