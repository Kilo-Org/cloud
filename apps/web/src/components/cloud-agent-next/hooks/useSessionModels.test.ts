import { describe, expect, it } from '@jest/globals';
import type { RemoteModelState } from '@/lib/cloud-agent-sdk';
import type { ModelOption } from '@/components/shared/ModelCombobox';
import {
  buildSessionModels,
  createRemoteModelOverride,
  resolveGatewayOrganization,
  validateRemoteModelOverride,
  type SessionModelOption,
} from './useSessionModels';

const gatewayModels = [
  {
    id: 'anthropic/claude-sonnet-4',
    name: 'Claude Sonnet 4',
    isFree: true,
    hasUserByokAvailable: true,
    variants: ['none', 'high'],
  },
] satisfies ModelOption[];

const emptyRemoteState = {
  ownerConnectionId: null,
  protocol: 'unknown',
  refresh: 'idle',
} satisfies RemoteModelState;

describe('resolveGatewayOrganization', () => {
  it('uses the persisted session organization instead of the route organization', () => {
    expect(
      resolveGatewayOrganization({ organizationId: 'org-persisted' }, 'org-route', 'ses_existing')
    ).toEqual({ organizationId: 'org-persisted', resolved: true });
  });

  it('keeps a persisted personal session personal on an organization route', () => {
    expect(
      resolveGatewayOrganization({ organizationId: null }, 'org-route', 'ses_existing')
    ).toEqual({ organizationId: undefined, resolved: true });
  });

  it('stays unresolved while an existing session loads so the personal catalog is not fetched', () => {
    expect(resolveGatewayOrganization(null, 'org-route', 'ses_remote')).toEqual({
      resolved: false,
    });
  });

  it('uses the route organization while creating a Cloud Agent', () => {
    expect(resolveGatewayOrganization(null, 'org-route', null)).toEqual({
      organizationId: 'org-route',
      resolved: true,
    });
  });
});

describe('buildSessionModels', () => {
  it('keeps Cloud Agent on the existing Gateway catalog and selection', () => {
    const result = buildSessionModels({
      activeSessionType: 'cloud-agent',
      remoteModelState: emptyRemoteState,
      observedModel: null,
      remoteModelOverride: null,
      gatewayModels,
      gatewayModelsLoading: false,
      gatewayModelId: 'anthropic/claude-sonnet-4',
      gatewayVariant: 'high',
      gatewayOrganizationId: 'org-persisted',
    });

    expect(result.source).toBe('cloud-agent-gateway');
    expect(result.modelOptions).toBe(gatewayModels);
    expect(result.selectedValue).toBe('anthropic/claude-sonnet-4');
    expect(result.selectedVariant).toBe('high');
    expect(result.availableVariants).toEqual(['none', 'high']);
    expect(result.modelPickerDisabled).toBe(false);
    expect(result.notices).toEqual([]);
    expect(result.gatewayOrganizationId).toBe('org-persisted');
  });

  it('projects a v1 CLI catalog into distinct opaque provider-aware options', () => {
    const result = buildSessionModels({
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
                  limits: { context: 200_000, output: 8_192 },
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
                  limits: { context: 32_000, output: 4_096 },
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
      gatewayModelId: gatewayModels[0].id,
      gatewayOrganizationId: 'org-persisted',
    });

    const cliOptions = result.modelOptions as SessionModelOption[];
    expect(result.source).toBe('remote-cli-catalog');
    expect(cliOptions).toHaveLength(2);
    expect(cliOptions[0].id).not.toBe(cliOptions[1].id);
    expect(cliOptions.map(option => option.displayId)).toEqual([
      'shared/model.id',
      'shared/model.id',
    ]);
    expect(cliOptions.map(option => option.providerGroup?.label)).toEqual([
      'Anthropic Local',
      'Custom OpenAI',
    ]);
    expect(cliOptions[0]).toMatchObject({
      modelRef: { providerID: 'anthropic-local', modelID: 'shared/model.id' },
      overrideSource: 'cli-catalog',
      variants: ['low', 'high'],
      supportsVision: true,
      supportsReasoning: true,
      showGatewayMetadata: false,
    });
    expect(cliOptions[0].searchTerms).toEqual(
      expect.arrayContaining([
        'anthropic-local',
        'Anthropic Local',
        'shared/model.id',
        'Claude Workspace',
      ])
    );
    expect(result.selectedValue).toBe(cliOptions[0].id);
    expect(result.selectedVariant).toBe('high');
    expect(result.availableVariants).toEqual(['low', 'high']);
  });

  it('sorts v1 CLI catalog options like the CLI TUI picker', () => {
    const result = buildSessionModels({
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
                  limits: { context: 32_000, output: 4_096 },
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
                  limits: { context: 32_000, output: 4_096 },
                },
                {
                  id: 'kilo-first',
                  name: 'Kilo First',
                  recommendedIndex: 0,
                  variants: [],
                  capabilities: { attachment: false, reasoning: false },
                  limits: { context: 32_000, output: 4_096 },
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
                  limits: { context: 32_000, output: 4_096 },
                },
                {
                  id: 'alpha-model',
                  name: 'Alpha Model',
                  variants: [],
                  capabilities: { attachment: false, reasoning: false },
                  limits: { context: 32_000, output: 4_096 },
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
                  limits: { context: 32_000, output: 4_096 },
                },
                {
                  id: 'a-model',
                  name: 'A Model',
                  isFree: true,
                  variants: [],
                  capabilities: { attachment: false, reasoning: false },
                  limits: { context: 32_000, output: 4_096 },
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
    });

    expect(result.modelOptions.map(option => option.modelRef)).toEqual([
      { providerID: 'opencode', modelID: 'a-model' },
      { providerID: 'opencode', modelID: 'z-model' },
      { providerID: 'alpha-provider', modelID: 'alpha-model' },
      { providerID: 'alpha-provider', modelID: 'beta-model' },
      { providerID: 'kilo', modelID: 'kilo-first' },
      { providerID: 'kilo', modelID: 'kilo-later' },
      { providerID: 'zeta-provider', modelID: 'zeta-model' },
    ]);
  });

  it('uses Kilo Gateway recommendedIndex ranks and a Recommended group from CLI metadata', () => {
    const result = buildSessionModels({
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
                  limits: { context: 32_000, output: 4_096 },
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
    });

    expect(result.modelOptions.map(option => option.modelRef)).toEqual([
      { providerID: 'kilo', modelID: 'kilo-auto/efficient' },
      { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4.6' },
      { providerID: 'kilo', modelID: 'zzz-unranked-model' },
    ]);
    expect(result.modelOptions.map(option => option.providerGroup)).toEqual([
      { id: 'kilo-recommended', label: 'Recommended' },
      { id: 'kilo-recommended', label: 'Recommended' },
      { id: 'kilo', label: 'Kilo Gateway' },
    ]);
  });

  it('uses persisted-organization Gateway fallback only for an exact legacy CLI', () => {
    const result = buildSessionModels({
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
      gatewayModelId: gatewayModels[0].id,
      gatewayOrganizationId: 'org-from-fetched-session',
    });

    const gatewayOption = result.modelOptions.find(
      option => option.modelRef?.providerID === 'kilo'
    );
    const unavailableObserved = result.modelOptions.find(option => option.unavailable);

    expect(result.source).toBe('remote-legacy-gateway');
    expect(result.gatewayOrganizationId).toBe('org-from-fetched-session');
    expect(result.notices.map(notice => notice.id)).toEqual(['legacy']);
    expect(gatewayOption).toMatchObject({
      id: 'anthropic/claude-sonnet-4',
      modelRef: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' },
      overrideSource: 'legacy-gateway',
      isFree: true,
      hasUserByokAvailable: true,
    });
    expect(unavailableObserved).toMatchObject({
      displayId: 'private-model',
      modelRef: { providerID: 'local-provider', modelID: 'private-model' },
      unavailable: true,
    });
    expect(result.selectedValue).toBe(unavailableObserved?.id);
    expect(createRemoteModelOverride(gatewayOption, 'stale-variant')).toEqual({
      source: 'legacy-gateway',
      selection: {
        model: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' },
      },
    });
  });

  it('does not expose Gateway models when remote capability discovery fails', () => {
    const result = buildSessionModels({
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
      gatewayModelId: gatewayModels[0].id,
      gatewayOrganizationId: 'org-persisted',
    });

    expect(result.source).toBe('remote-unavailable');
    expect(result.modelOptions).toEqual([
      expect.objectContaining({
        name: 'Session model',
        unavailable: true,
      }),
    ]);
    expect(result.modelOptions.some(option => option.id === gatewayModels[0].id)).toBe(false);
    expect(result.selectedValue).toBe(result.modelOptions[0].id);
    expect(result.modelPickerDisabled).toBe(true);
    expect(result.notices).toEqual([expect.objectContaining({ id: 'error', retry: true })]);
  });

  it('keeps a stale v1 catalog with truncation and local-provider disclosure', () => {
    const result = buildSessionModels({
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
                  limits: { context: 64_000, output: 4_096 },
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
      gatewayOrganizationId: 'org-persisted',
    });

    const cliOption = result.modelOptions.find(option => option.overrideSource === 'cli-catalog');

    expect(result.source).toBe('remote-cli-catalog');
    expect(result.notices.map(notice => notice.id)).toEqual([
      'stale',
      'truncated',
      'local-provider',
    ]);
    expect(result.notices[2].message).toContain("organization's model restrictions");
    expect(createRemoteModelOverride(cliOption, 'removed-variant')).toEqual({
      source: 'cli-catalog',
      selection: {
        model: { providerID: 'local-provider', modelID: 'private-model' },
      },
    });
    expect(result.selectedValue).toBe(cliOption?.id);
    expect(result.selectedVariant).toBe('high');
  });
});

describe('validateRemoteModelOverride', () => {
  const legacyModelOptions = gatewayModels.map(model => ({
    ...model,
    modelRef: { providerID: 'kilo', modelID: model.id },
    overrideSource: 'legacy-gateway' as const,
  }));

  it('clears a same-source override when its exact model is no longer available', () => {
    expect(
      validateRemoteModelOverride(
        {
          source: 'legacy-gateway',
          selection: {
            model: { providerID: 'kilo', modelID: 'removed/model' },
            variant: 'high',
          },
        },
        legacyModelOptions,
        'legacy-gateway'
      )
    ).toBeNull();
  });

  it('keeps a valid model and drops a variant removed from the same source', () => {
    expect(
      validateRemoteModelOverride(
        {
          source: 'legacy-gateway',
          selection: {
            model: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' },
            variant: 'removed-variant',
          },
        },
        legacyModelOptions,
        'legacy-gateway'
      )
    ).toEqual({
      source: 'legacy-gateway',
      selection: {
        model: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' },
      },
    });
  });

  it('preserves a valid override by reference', () => {
    const override = {
      source: 'legacy-gateway',
      selection: {
        model: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' },
        variant: 'high',
      },
    } as const;

    expect(validateRemoteModelOverride(override, legacyModelOptions, 'legacy-gateway')).toBe(
      override
    );
  });

  it('does not validate an override from a different source', () => {
    const override = {
      source: 'cli-catalog',
      selection: {
        model: { providerID: 'local-provider', modelID: 'private-model' },
      },
    } as const;

    expect(validateRemoteModelOverride(override, legacyModelOptions, 'legacy-gateway')).toBe(
      override
    );
  });
});
