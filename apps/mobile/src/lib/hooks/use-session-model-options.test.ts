/* eslint-disable max-lines -- Empty/populated v1 catalog projections stay beside each other. */
import { describe, expect, it } from 'vitest';
import { type RemoteModelCatalogV1, type RemoteModelState } from '@kilocode/cloud-agent-sdk';

import { buildSessionModelOptions } from '@/lib/hooks/use-session-model-options';

function remoteState(overrides: Partial<RemoteModelState>): RemoteModelState {
  return {
    ownerConnectionId: 'cli-owner',
    protocol: 'v1',
    refresh: 'idle',
    ...overrides,
  };
}

const EMPTY_CATALOG: RemoteModelCatalogV1 = {
  protocolVersion: 1,
  truncated: false,
  providers: [],
};

const POPULATED_CATALOG: RemoteModelCatalogV1 = {
  protocolVersion: 1,
  truncated: false,
  providers: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      models: [
        {
          id: 'claude-sonnet-4',
          name: 'Claude Sonnet 4',
          variants: ['fast'],
          capabilities: { attachment: true, reasoning: true },
          limits: { context: 200_000, output: 8192 },
        },
      ],
    },
  ],
};

// A connected provider with an empty `models` record: schema-valid, but it
// projects to zero options and must not become an enabled empty picker.
const ZERO_MODEL_CATALOG: RemoteModelCatalogV1 = {
  protocolVersion: 1,
  truncated: false,
  providers: [{ id: 'anthropic', name: 'Anthropic', models: [] }],
};

function build(state: RemoteModelState) {
  return buildSessionModelOptions({
    activeSessionType: 'remote',
    remoteModelState: state,
    observedModel: null,
    remoteModelOverride: null,
    gatewayModels: [],
    gatewayModelsLoading: false,
    organizationId: 'org-1',
  });
}

describe('buildSessionModelOptions empty v1 catalog', () => {
  it('routes an empty catalog through the unavailable projection instead of an enabled empty picker', () => {
    const result = build(remoteState({ catalog: EMPTY_CATALOG }));

    expect(result.source).toBe('remote-unavailable');
    expect(result.pickerDisabled).toBe(true);
    expect(result.options).toHaveLength(1);
    expect(result.options[0]).toMatchObject({ unavailable: true });
  });

  it('reports loading while the empty catalog refreshes', () => {
    const result = build(remoteState({ catalog: EMPTY_CATALOG, refresh: 'loading' }));

    expect(result.source).toBe('remote-unavailable');
    expect(result.pickerDisabled).toBe(true);
    expect(result.isLoading).toBe(true);
  });

  it('stays disabled without loading when the empty catalog refresh failed', () => {
    const result = build(
      remoteState({ catalog: EMPTY_CATALOG, refresh: 'error', error: 'catalog request failed' })
    );

    expect(result.source).toBe('remote-unavailable');
    expect(result.pickerDisabled).toBe(true);
    expect(result.isLoading).toBe(false);
  });

  it('stays disabled without loading when the empty catalog is idle', () => {
    const result = build(remoteState({ catalog: EMPTY_CATALOG, refresh: 'idle' }));

    expect(result.source).toBe('remote-unavailable');
    expect(result.pickerDisabled).toBe(true);
    expect(result.isLoading).toBe(false);
  });
});

describe('buildSessionModelOptions zero-model v1 catalog', () => {
  it('routes a connected provider with no models through the unavailable projection', () => {
    const result = build(remoteState({ catalog: ZERO_MODEL_CATALOG }));

    expect(result.source).toBe('remote-unavailable');
    expect(result.pickerDisabled).toBe(true);
    expect(result.options).toHaveLength(1);
    expect(result.options[0]).toMatchObject({ unavailable: true });
  });

  it('reports loading while the zero-model catalog refreshes', () => {
    const result = build(remoteState({ catalog: ZERO_MODEL_CATALOG, refresh: 'loading' }));

    expect(result.source).toBe('remote-unavailable');
    expect(result.pickerDisabled).toBe(true);
    expect(result.isLoading).toBe(true);
  });
});

describe('buildSessionModelOptions populated v1 catalog', () => {
  it('keeps an enabled catalog projection unchanged', () => {
    const result = build(remoteState({ catalog: POPULATED_CATALOG }));

    expect(result.source).toBe('remote-cli-catalog');
    expect(result.pickerDisabled).toBe(false);
    expect(result.isLoading).toBe(false);
    expect(result.options).toHaveLength(1);
    expect(result.options[0]?.modelRef).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4',
    });
  });

  it('does not surface loading for a populated catalog during a background refresh', () => {
    const result = build(remoteState({ catalog: POPULATED_CATALOG, refresh: 'loading' }));

    expect(result.source).toBe('remote-cli-catalog');
    expect(result.pickerDisabled).toBe(false);
    expect(result.isLoading).toBe(false);
  });
});
