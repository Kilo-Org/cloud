/* eslint-disable max-lines -- Model option tests mirror the SDK/web suite. */
import { describe, expect, it } from 'vitest';
import { type ContextUsage } from 'cloud-agent-sdk/context-usage';

import {
  buildSessionModelOptions,
  createRemoteModelOverride,
  revalidateLegacyGatewayOverride,
} from './hooks/use-session-model-options';
import { buildModelPickerRows, modelPickerFavoriteId } from './model-picker-rows';
import { resolveSessionContextInfo } from './session-context-info';

const gatewayModels = [
  {
    id: 'gateway/model',
    name: 'Gateway Model',
    variants: ['high'],
    isPreferred: true,
    isFree: true,
    context_length: 200_000,
  },
];

describe('revalidateLegacyGatewayOverride', () => {
  it('clears an override when its Gateway model is removed', () => {
    expect(
      revalidateLegacyGatewayOverride(
        {
          source: 'legacy-gateway',
          selection: {
            model: { providerID: 'kilo', modelID: 'removed/model' },
            variant: 'high',
          },
        },
        gatewayModels
      )
    ).toBeNull();
  });

  it('retains a valid Gateway model and variant without replacing the override', () => {
    const override = {
      source: 'legacy-gateway' as const,
      selection: {
        model: { providerID: 'kilo', modelID: 'gateway/model' },
        variant: 'high',
      },
    };

    expect(revalidateLegacyGatewayOverride(override, gatewayModels)).toBe(override);
  });

  it('retains a Gateway model while removing a variant no longer offered', () => {
    expect(
      revalidateLegacyGatewayOverride(
        {
          source: 'legacy-gateway',
          selection: {
            model: { providerID: 'kilo', modelID: 'gateway/model' },
            variant: 'removed',
          },
        },
        gatewayModels
      )
    ).toEqual({
      source: 'legacy-gateway',
      selection: { model: { providerID: 'kilo', modelID: 'gateway/model' } },
    });
  });
});

describe('buildSessionModelOptions', () => {
  it('uses provider-aware CLI rows with distinct opaque values for duplicate model IDs', () => {
    const result = buildSessionModelOptions({
      activeSessionType: 'remote',
      remoteModelState: {
        ownerConnectionId: 'cli-owner',
        protocol: 'v1',
        refresh: 'idle',
        catalog: {
          protocolVersion: 1,
          truncated: false,
          providers: [
            {
              id: 'anthropic-local',
              name: 'Anthropic Local',
              models: [
                {
                  id: 'shared/model.id',
                  name: 'Claude Workspace',
                  variants: ['low', 'high'],
                  capabilities: { attachment: true, reasoning: true },
                  limits: { context: 200_000, output: 8192 },
                },
              ],
            },
            {
              id: 'custom-openai',
              name: 'Custom OpenAI',
              models: [
                {
                  id: 'shared/model.id',
                  name: 'Internal Deployment',
                  variants: [],
                  capabilities: { attachment: false, reasoning: false },
                  limits: { context: 32_000, output: 4096 },
                },
              ],
            },
          ],
        },
      },
      observedModel: {
        model: { providerID: 'anthropic-local', modelID: 'shared/model.id' },
        variant: 'high',
      },
      remoteModelOverride: null,
      gatewayModels,
      gatewayModelsLoading: false,
      organizationId: 'org-persisted',
    });

    expect(result.source).toBe('remote-cli-catalog');
    expect(result.options).toHaveLength(2);
    expect(result.options[0]?.id).not.toBe(result.options[1]?.id);
    expect(result.options.map(option => option.id)).not.toContain('shared/model.id');
    expect(result.options.map(option => option.displayId)).toEqual([
      'shared/model.id',
      'shared/model.id',
    ]);
    expect(result.options.map(option => option.provider?.name)).toEqual([
      'Anthropic Local',
      'Custom OpenAI',
    ]);
    expect(result.options[0]).toMatchObject({
      modelRef: { providerID: 'anthropic-local', modelID: 'shared/model.id' },
      overrideSource: 'cli-catalog',
      variants: ['low', 'high'],
      showGatewayMetadata: false,
    });
    expect(result.selectedValue).toBe(result.options[0]?.id);
    expect(result.selectedVariant).toBe('high');
  });

  it('sorts provider-aware CLI rows like the CLI TUI picker', () => {
    const result = buildSessionModelOptions({
      activeSessionType: 'remote',
      remoteModelState: {
        ownerConnectionId: 'cli-owner',
        protocol: 'v1',
        refresh: 'idle',
        catalog: {
          protocolVersion: 1,
          truncated: false,
          providers: [
            {
              id: 'zeta-provider',
              name: 'Zeta Provider',
              models: [
                {
                  id: 'zeta-model',
                  name: 'Zeta Model',
                  variants: [],
                  capabilities: { attachment: false, reasoning: false },
                  limits: { context: 32_000, output: 4096 },
                },
              ],
            },
            {
              id: 'kilo',
              name: 'Kilo Gateway',
              models: [
                {
                  id: 'kilo-later',
                  name: 'Kilo Later',
                  recommendedIndex: 2,
                  variants: [],
                  capabilities: { attachment: false, reasoning: false },
                  limits: { context: 32_000, output: 4096 },
                },
                {
                  id: 'kilo-first',
                  name: 'Kilo First',
                  recommendedIndex: 0,
                  variants: [],
                  capabilities: { attachment: false, reasoning: false },
                  limits: { context: 32_000, output: 4096 },
                },
              ],
            },
            {
              id: 'alpha-provider',
              name: 'Alpha Provider',
              models: [
                {
                  id: 'beta-model',
                  name: 'Beta Model',
                  variants: [],
                  capabilities: { attachment: false, reasoning: false },
                  limits: { context: 32_000, output: 4096 },
                },
                {
                  id: 'alpha-model',
                  name: 'Alpha Model',
                  variants: [],
                  capabilities: { attachment: false, reasoning: false },
                  limits: { context: 32_000, output: 4096 },
                },
              ],
            },
            {
              id: 'opencode',
              name: 'OpenCode',
              models: [
                {
                  id: 'z-model',
                  name: 'Z Model',
                  isFree: true,
                  variants: [],
                  capabilities: { attachment: false, reasoning: false },
                  limits: { context: 32_000, output: 4096 },
                },
                {
                  id: 'a-model',
                  name: 'A Model',
                  isFree: true,
                  variants: [],
                  capabilities: { attachment: false, reasoning: false },
                  limits: { context: 32_000, output: 4096 },
                },
              ],
            },
          ],
        },
      },
      observedModel: null,
      remoteModelOverride: null,
      gatewayModels,
      gatewayModelsLoading: false,
      organizationId: 'org-persisted',
    });

    expect(result.options.map(option => option.modelRef)).toEqual([
      { providerID: 'opencode', modelID: 'a-model' },
      { providerID: 'opencode', modelID: 'z-model' },
      { providerID: 'alpha-provider', modelID: 'alpha-model' },
      { providerID: 'alpha-provider', modelID: 'beta-model' },
      { providerID: 'kilo', modelID: 'kilo-first' },
      { providerID: 'kilo', modelID: 'kilo-later' },
      { providerID: 'zeta-provider', modelID: 'zeta-model' },
    ]);
  });

  it('uses Kilo Gateway recommendedIndex ranks from CLI metadata', () => {
    const result = buildSessionModelOptions({
      activeSessionType: 'remote',
      remoteModelState: {
        ownerConnectionId: 'cli-owner',
        protocol: 'v1',
        refresh: 'idle',
        catalog: {
          protocolVersion: 1,
          truncated: false,
          providers: [
            {
              id: 'kilo',
              name: 'Kilo Gateway',
              models: [
                {
                  id: 'zzz-unranked-model',
                  name: 'AAA Unranked Model',
                  variants: [],
                  capabilities: { attachment: false, reasoning: false },
                  limits: { context: 32_000, output: 4096 },
                },
                {
                  id: 'anthropic/claude-sonnet-4.6',
                  name: 'ZZZ Claude Sonnet',
                  recommendedIndex: 1,
                  variants: [],
                  capabilities: { attachment: true, reasoning: true },
                  limits: { context: 1_000_000, output: 128_000 },
                },
                {
                  id: 'kilo-auto/efficient',
                  name: 'MMM Auto Efficient',
                  recommendedIndex: 0,
                  variants: [],
                  capabilities: { attachment: true, reasoning: true },
                  limits: { context: 1_000_000, output: 65_536 },
                },
              ],
            },
          ],
        },
      },
      observedModel: null,
      remoteModelOverride: null,
      gatewayModels,
      gatewayModelsLoading: false,
      organizationId: 'org-persisted',
    });

    expect(result.options.map(option => option.modelRef)).toEqual([
      { providerID: 'kilo', modelID: 'kilo-auto/efficient' },
      { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4.6' },
      { providerID: 'kilo', modelID: 'zzz-unranked-model' },
    ]);
  });

  it('uses Gateway rows only for an exact legacy CLI and preserves override provenance', () => {
    const result = buildSessionModelOptions({
      activeSessionType: 'remote',
      remoteModelState: {
        ownerConnectionId: 'legacy-owner',
        protocol: 'legacy',
        refresh: 'idle',
      },
      observedModel: {
        model: { providerID: 'local-provider', modelID: 'private-model' },
        variant: 'old-variant',
      },
      remoteModelOverride: null,
      gatewayModels,
      gatewayModelsLoading: false,
      organizationId: 'org-from-session',
    });

    const gatewayOption = result.options.find(option => option.overrideSource === 'legacy-gateway');
    const unavailableOption = result.options.find(option => option.unavailable);

    expect(result.source).toBe('remote-legacy-gateway');
    expect(gatewayOption).toMatchObject({
      id: 'gateway/model',
      modelRef: { providerID: 'kilo', modelID: 'gateway/model' },
      overrideSource: 'legacy-gateway',
      showGatewayMetadata: true,
    });
    expect(unavailableOption).toMatchObject({
      displayId: 'private-model',
      modelRef: { providerID: 'local-provider', modelID: 'private-model' },
      unavailable: true,
    });
    expect(result.selectedValue).toBe(unavailableOption?.id);
    expect(result.selectedVariant).toBe('');
  });

  it('does not project a removed legacy Gateway override as the selected model', () => {
    const result = buildSessionModelOptions({
      activeSessionType: 'remote',
      remoteModelState: {
        ownerConnectionId: 'legacy-owner',
        protocol: 'legacy',
        refresh: 'idle',
      },
      observedModel: {
        model: { providerID: 'kilo', modelID: 'gateway/model' },
        variant: 'high',
      },
      remoteModelOverride: {
        source: 'legacy-gateway',
        selection: {
          model: { providerID: 'kilo', modelID: 'removed/model' },
          variant: 'high',
        },
      },
      gatewayModels,
      gatewayModelsLoading: false,
      organizationId: undefined,
    });

    expect(result.selectedValue).toBe('gateway/model');
    expect(result.selectedVariant).toBe('high');
    expect(result.options.some(option => option.unavailable)).toBe(false);
    expect(result.options.some(option => option.name === 'Use session model')).toBe(false);
  });

  it('disables model changes when remote discovery fails without exposing Gateway rows', () => {
    const result = buildSessionModelOptions({
      activeSessionType: 'remote',
      remoteModelState: {
        ownerConnectionId: 'cli-owner',
        protocol: 'unknown',
        refresh: 'error',
        error: 'catalog request failed',
      },
      observedModel: null,
      remoteModelOverride: null,
      gatewayModels,
      gatewayModelsLoading: false,
      organizationId: 'org-persisted',
    });

    expect(result.source).toBe('remote-unavailable');
    expect(result.options).toEqual([
      expect.objectContaining({ name: 'Session model', unavailable: true }),
    ]);
    expect(result.options.some(option => option.id === gatewayModels[0]?.id)).toBe(false);
    expect(result.pickerDisabled).toBe(true);
  });

  it('retains a stale v1 catalog with truncation and local-provider selection', () => {
    const result = buildSessionModelOptions({
      activeSessionType: 'remote',
      remoteModelState: {
        ownerConnectionId: 'cli-owner',
        protocol: 'v1',
        refresh: 'error',
        error: 'refresh failed',
        catalog: {
          protocolVersion: 1,
          truncated: true,
          providers: [
            {
              id: 'local-provider',
              name: 'Local Provider',
              models: [
                {
                  id: 'private-model',
                  variants: ['low', 'high'],
                  capabilities: { attachment: false, reasoning: true },
                  limits: { context: 64_000, output: 4096 },
                },
              ],
            },
          ],
        },
      },
      observedModel: null,
      remoteModelOverride: {
        source: 'cli-catalog',
        selection: {
          model: { providerID: 'local-provider', modelID: 'private-model' },
          variant: 'high',
        },
      },
      gatewayModels,
      gatewayModelsLoading: false,
      organizationId: 'org-persisted',
    });

    const cliOption = result.options.find(option => option.overrideSource === 'cli-catalog');

    expect(createRemoteModelOverride(cliOption, 'removed')).toEqual({
      source: 'cli-catalog',
      selection: { model: { providerID: 'local-provider', modelID: 'private-model' } },
    });
    expect(result.selectedValue).toBe(cliOption?.id);
    expect(result.selectedVariant).toBe('high');
  });
});

describe('buildSessionModelOptions capacity projection', () => {
  it('preserves Gateway picker grouping and favorite identity while projecting context capacity', () => {
    const result = buildSessionModelOptions({
      activeSessionType: 'cloud-agent',
      remoteModelState: {
        ownerConnectionId: null,
        protocol: 'unknown',
        refresh: 'idle',
      },
      observedModel: null,
      remoteModelOverride: null,
      gatewayModels: [
        {
          id: 'gateway/recommended',
          name: 'Recommended',
          variants: [],
          isPreferred: true,
          context_length: 200_000,
        },
        {
          id: 'gateway/other',
          name: 'Other',
          variants: [],
          isPreferred: false,
          context_length: 32_000,
        },
      ],
      gatewayModelsLoading: false,
      organizationId: 'org-1',
    });

    const [gatewayOption] = result.options;
    if (!gatewayOption) {
      throw new Error('Expected a Gateway option');
    }
    expect(gatewayOption.provider).toBeUndefined();
    expect(gatewayOption.modelRef).toBeUndefined();
    expect(modelPickerFavoriteId(gatewayOption)).toBe('gateway/recommended');
    expect(
      buildModelPickerRows({ models: result.options, search: '', favoriteIds: new Set() })
        .filter(row => row.type === 'header')
        .map(row => row.title)
    ).toEqual(['RECOMMENDED', 'ALL MODELS']);
  });

  it('projects Cloud Agent Gateway context_length onto every option', () => {
    const result = buildSessionModelOptions({
      activeSessionType: 'cloud-agent',
      remoteModelState: {
        ownerConnectionId: null,
        protocol: 'unknown',
        refresh: 'idle',
      },
      observedModel: null,
      remoteModelOverride: null,
      gatewayModels: [
        { id: 'gateway/a', name: 'A', variants: [], isPreferred: true, context_length: 200_000 },
        { id: 'gateway/b', name: 'B', variants: [], isPreferred: false, context_length: 32_000 },
        {
          id: 'gateway/missing',
          name: 'M',
          variants: [],
          isPreferred: false,
          context_length: null,
        },
        { id: 'gateway/undefined', name: 'U', variants: [], isPreferred: false },
      ],
      gatewayModelsLoading: false,
      organizationId: 'org-1',
    });

    expect(result.source).toBe('cloud-agent-gateway');
    expect(result.options.find(option => option.id === 'gateway/a')?.contextWindow).toBe(200_000);
    expect(result.options.find(option => option.id === 'gateway/b')?.contextWindow).toBe(32_000);
    expect(
      result.options.find(option => option.id === 'gateway/missing')?.contextWindow
    ).toBeUndefined();
    expect(
      result.options.find(option => option.id === 'gateway/undefined')?.contextWindow
    ).toBeUndefined();
  });

  it('projects legacy Gateway context_length and omits contextWindow on the unavailable option', () => {
    const result = buildSessionModelOptions({
      activeSessionType: 'remote',
      remoteModelState: {
        ownerConnectionId: 'legacy-owner',
        protocol: 'legacy',
        refresh: 'idle',
      },
      observedModel: {
        model: { providerID: 'local-provider', modelID: 'private-model' },
        variant: 'old-variant',
      },
      remoteModelOverride: null,
      gatewayModels: [
        {
          id: 'gateway/model',
          name: 'Gateway Model',
          variants: ['high'],
          isPreferred: true,
          context_length: 200_000,
        },
      ],
      gatewayModelsLoading: false,
      organizationId: 'org-legacy',
    });

    const legacyOption = result.options.find(option => option.overrideSource === 'legacy-gateway');
    const unavailableOption = result.options.find(option => option.unavailable);

    expect(result.source).toBe('remote-legacy-gateway');
    expect(legacyOption?.contextWindow).toBe(200_000);
    expect(legacyOption?.modelRef).toEqual({ providerID: 'kilo', modelID: 'gateway/model' });
    expect(unavailableOption?.contextWindow).toBeUndefined();
  });

  it('projects v1 CLI limits.context onto each provider-aware row, distinct per provider', () => {
    const result = buildSessionModelOptions({
      activeSessionType: 'remote',
      remoteModelState: {
        ownerConnectionId: 'cli-owner',
        protocol: 'v1',
        refresh: 'idle',
        catalog: {
          protocolVersion: 1,
          truncated: false,
          providers: [
            {
              id: 'anthropic-local',
              name: 'Anthropic Local',
              models: [
                {
                  id: 'shared/model.id',
                  name: 'Claude Workspace',
                  variants: ['low', 'high'],
                  capabilities: { attachment: true, reasoning: true },
                  limits: { context: 200_000, output: 8192 },
                },
              ],
            },
            {
              id: 'custom-openai',
              name: 'Custom OpenAI',
              models: [
                {
                  id: 'shared/model.id',
                  name: 'Internal Deployment',
                  variants: [],
                  capabilities: { attachment: false, reasoning: false },
                  limits: { context: 32_000, output: 4096 },
                },
              ],
            },
          ],
        },
      },
      observedModel: null,
      remoteModelOverride: null,
      gatewayModels: [],
      gatewayModelsLoading: false,
      organizationId: 'org-cli',
    });

    const anthropicRow = result.options.find(
      option => option.modelRef?.providerID === 'anthropic-local'
    );
    const customRow = result.options.find(
      option => option.modelRef?.providerID === 'custom-openai'
    );

    expect(anthropicRow?.contextWindow).toBe(200_000);
    expect(customRow?.contextWindow).toBe(32_000);
  });

  it('resolves Cloud Agent Gateway context capacity through buildSessionModelOptions', () => {
    const result = buildSessionModelOptions({
      activeSessionType: 'cloud-agent',
      remoteModelState: {
        ownerConnectionId: null,
        protocol: 'unknown',
        refresh: 'idle',
      },
      observedModel: null,
      remoteModelOverride: null,
      gatewayModels: [
        {
          id: 'gateway/model',
          name: 'Gateway Model',
          variants: [],
          isPreferred: true,
          context_length: 200_000,
        },
      ],
      gatewayModelsLoading: false,
      organizationId: 'org-1',
    });

    const contextUsage: ContextUsage = {
      contextTokens: 84_000,
      providerID: 'kilo',
      modelID: 'gateway/model',
    };

    const resolved = resolveSessionContextInfo(contextUsage, result.options);

    expect(resolved).toEqual({
      contextTokens: 84_000,
      providerID: 'kilo',
      modelID: 'gateway/model',
      contextWindow: 200_000,
      percentage: 42,
    });
  });
});
