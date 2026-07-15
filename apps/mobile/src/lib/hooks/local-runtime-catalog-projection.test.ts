import { describe, expect, it } from 'vitest';

import { projectLocalRuntimeCatalog } from './local-runtime-catalog-projection';

const WIRE_CATALOG = {
  protocolVersion: 1 as const,
  models: {
    protocolVersion: 1 as const,
    providers: [
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: [
          {
            id: 'claude-3-5-sonnet',
            name: 'Claude 3.5 Sonnet',
            variants: ['low', 'high'],
            capabilities: { attachment: true, reasoning: true },
            limits: { context: 200_000, output: 8192 },
          },
        ],
      },
    ],
    defaultModel: { providerID: 'anthropic', modelID: 'claude-3-5-sonnet' },
    truncated: false,
  },
  agents: [
    { slug: 'build', name: 'Build', description: 'Plans and writes code.' },
    {
      slug: 'pinned',
      name: 'Pinned',
      model: { providerID: 'anthropic', modelID: 'claude-3-5-sonnet' },
      variant: 'low',
    },
    { slug: 'unknown-model', name: 'Unknown', model: 'not-an-object' },
  ],
  defaultAgent: 'build',
};

describe('projectLocalRuntimeCatalog', () => {
  it('returns the mobile-facing catalog shape', () => {
    const projected = projectLocalRuntimeCatalog(WIRE_CATALOG);
    expect(projected).toEqual({
      protocolVersion: 1,
      models: {
        protocolVersion: 1,
        providers: [
          {
            id: 'anthropic',
            name: 'Anthropic',
            models: [
              {
                id: 'claude-3-5-sonnet',
                name: 'Claude 3.5 Sonnet',
                recommendedIndex: undefined,
                isFree: undefined,
                mayTrainOnYourPrompts: undefined,
                hasUserByokAvailable: undefined,
                variants: ['low', 'high'],
              },
            ],
          },
        ],
        defaultModel: { providerID: 'anthropic', modelID: 'claude-3-5-sonnet' },
        truncated: false,
      },
      agents: [
        { slug: 'build', name: 'Build', description: 'Plans and writes code.' },
        {
          slug: 'pinned',
          name: 'Pinned',
          model: { providerID: 'anthropic', modelID: 'claude-3-5-sonnet' },
          variant: 'low',
        },
        { slug: 'unknown-model', name: 'Unknown' },
      ],
      defaultAgent: 'build',
    });
  });

  it('narrows a typed agent model to providerID + modelID', () => {
    const projected = projectLocalRuntimeCatalog(WIRE_CATALOG);
    const pinned = projected.agents.find(agent => agent.slug === 'pinned');
    expect(pinned?.model).toEqual({ providerID: 'anthropic', modelID: 'claude-3-5-sonnet' });
  });

  it('drops agents whose model field is not an object', () => {
    const projected = projectLocalRuntimeCatalog(WIRE_CATALOG);
    const unknown = projected.agents.find(agent => agent.slug === 'unknown-model');
    expect(unknown).toBeDefined();
    expect(unknown?.model).toBeUndefined();
  });

  it('strips model capabilities and limits that the mobile slice does not consume', () => {
    const projected = projectLocalRuntimeCatalog(WIRE_CATALOG);
    const model = projected.models.providers[0]?.models[0];
    expect(model).toBeDefined();
    expect(model).not.toHaveProperty('capabilities');
    expect(model).not.toHaveProperty('limits');
  });
});
