/* eslint-disable max-lines -- Model option tests mirror the SDK/web suite. */
import { describe, expect, it } from 'vitest';

import {
  buildSessionModelOptions,
  createRemoteModelOverride,
  revalidateLegacyGatewayOverride,
} from './hooks/use-session-model-options';

const gatewayModels = [
  {
    id: 'gateway/model',
    name: 'Gateway Model',
    variants: ['high'],
    isPreferred: true,
    isFree: true,
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
    expect(result.notices.map(notice => notice.id)).toEqual(['legacy', 'unavailable']);
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
    expect(result.notices).toEqual([expect.objectContaining({ id: 'error', retry: true })]);
  });

  it('retains a stale v1 catalog with truncation and local-provider notices', () => {
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

    expect(result.notices.map(notice => notice.id)).toEqual([
      'stale',
      'truncated',
      'local-provider',
    ]);
    expect(result.notices[2]?.message).toContain("organization's model restrictions");
    expect(createRemoteModelOverride(cliOption, 'removed')).toEqual({
      source: 'cli-catalog',
      selection: { model: { providerID: 'local-provider', modelID: 'private-model' } },
    });
    expect(result.selectedValue).toBe(cliOption?.id);
    expect(result.selectedVariant).toBe('high');
  });
});
