import { describe, expect, it } from 'vitest';
import { type RemoteModelCatalogV1 } from '@kilocode/cloud-agent-sdk/instance-model-catalog';
import { type ModelRef } from '@kilocode/cloud-agent-sdk/remote-model-catalog';

import { buildCreateRemoteSessionInput } from '@/lib/hooks/remote-instance-spawn-classifier';
import { type ModelOption } from '@/lib/hooks/use-available-models';
import {
  resolveNewSessionModelView,
  type ResolveNewSessionModelViewInput,
} from './new-session-model-view';

const gatewayModels: ModelOption[] = [
  {
    id: 'kilo-auto/efficient',
    name: 'Auto Efficient',
    variants: ['low', 'high'],
    isPreferred: true,
  },
  {
    id: 'kilo-auto/maximum',
    name: 'Auto Maximum',
    variants: [],
    isPreferred: false,
  },
];

type CatalogModelInput = {
  id: string;
  name?: string;
  variants?: string[];
};

type CatalogProviderInput = {
  id: string;
  name?: string;
  models: CatalogModelInput[];
};

function createCatalog(
  providers: CatalogProviderInput[],
  defaultModel?: ModelRef
): RemoteModelCatalogV1 {
  return {
    protocolVersion: 1,
    truncated: false,
    providers: providers.map(provider => ({
      id: provider.id,
      ...(provider.name ? { name: provider.name } : {}),
      models: provider.models.map(model => ({
        id: model.id,
        ...(model.name ? { name: model.name } : {}),
        variants: model.variants ?? [],
        capabilities: { attachment: true, reasoning: true },
        limits: { context: 200_000, output: 16_000 },
      })),
    })),
    ...(defaultModel ? { defaultModel } : {}),
  };
}

const baseCatalog = createCatalog([
  {
    id: 'kilo',
    name: 'Kilo Gateway',
    models: [
      { id: 'kilo-auto/efficient', name: 'Auto Efficient', variants: ['low', 'high'] },
      { id: 'kilo-model-a', name: 'Kilo Model A', variants: [] },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    models: [{ id: 'claude-x', name: 'Claude X', variants: [] }],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    models: [{ id: 'opencode-model', name: 'OpenCode Model', variants: [] }],
  },
]);

const baseInput: ResolveNewSessionModelViewInput = {
  isRemoteTarget: true,
  catalog: baseCatalog,
  catalogLoading: false,
  gatewayModels,
  gatewayModelsLoading: false,
  gatewayModel: 'kilo-auto/efficient',
  gatewayVariant: 'high',
  remoteOverride: null,
};

describe('resolveNewSessionModelView', () => {
  it('returns the gateway options and persisted strings for a Cloud Agent target', () => {
    const view = resolveNewSessionModelView({ ...baseInput, isRemoteTarget: false });

    expect(view.options.map(option => option.id)).toEqual(gatewayModels.map(model => model.id));
    expect(view.options.some(option => option.modelRef)).toBe(false);
    expect(view.selectedValue).toBe('kilo-auto/efficient');
    expect(view.selectedVariant).toBe('high');
    expect(view.spawnSelection).toBeUndefined();
    expect(view.isSelectionUnavailable).toBe(false);
  });

  it('projects the instance catalog into provider-grouped CLI options', () => {
    const view = resolveNewSessionModelView(baseInput);

    expect(view.options.some(option => option.provider?.id === 'anthropic')).toBe(true);
    expect(view.options.every(option => option.modelRef)).toBe(true);
    expect(view.options.every(option => option.overrideSource === 'cli-catalog')).toBe(true);
  });

  it('starts on the persisted gateway model when the instance offers it', () => {
    const view = resolveNewSessionModelView(baseInput);

    expect(view.spawnSelection).toEqual({
      model: { providerID: 'kilo', modelID: 'kilo-auto/efficient' },
      variant: 'high',
    });
  });

  it('falls back to the catalog default when the gateway model is absent', () => {
    const catalog = createCatalog(
      [
        { id: 'kilo', models: [{ id: 'kilo-model-a' }] },
        { id: 'anthropic', models: [{ id: 'claude-x' }] },
        { id: 'opencode', models: [{ id: 'opencode-model' }] },
      ],
      { providerID: 'anthropic', modelID: 'claude-x' }
    );
    const view = resolveNewSessionModelView({ ...baseInput, catalog });

    expect(view.spawnSelection).toEqual({
      model: { providerID: 'anthropic', modelID: 'claude-x' },
    });
  });

  it('honors a CLI override on a non-kilo model present in the catalog', () => {
    const view = resolveNewSessionModelView({
      ...baseInput,
      remoteOverride: {
        source: 'cli-catalog',
        selection: { model: { providerID: 'anthropic', modelID: 'claude-x' } },
      },
    });

    expect(view.spawnSelection).toEqual({
      model: { providerID: 'anthropic', modelID: 'claude-x' },
    });
  });

  it('blocks Start when the override model is absent from the catalog', () => {
    const view = resolveNewSessionModelView({
      ...baseInput,
      remoteOverride: {
        source: 'cli-catalog',
        selection: { model: { providerID: 'openai', modelID: 'gpt-y' } },
      },
    });

    expect(view.isSelectionUnavailable).toBe(true);
    expect(view.spawnSelection).toBeUndefined();
  });

  it('drops a variant the selected model does not offer from the wire', () => {
    const catalog = createCatalog([
      { id: 'kilo', models: [{ id: 'kilo-auto/efficient', variants: ['low'] }] },
      { id: 'anthropic', models: [{ id: 'claude-x' }] },
      { id: 'opencode', models: [{ id: 'opencode-model' }] },
    ]);
    const view = resolveNewSessionModelView({
      ...baseInput,
      catalog,
      remoteOverride: {
        source: 'cli-catalog',
        selection: {
          model: { providerID: 'kilo', modelID: 'kilo-auto/efficient' },
          variant: 'high',
        },
      },
    });

    expect(view.spawnSelection).toEqual({
      model: { providerID: 'kilo', modelID: 'kilo-auto/efficient' },
    });
  });

  it('falls back to gateway-shaped options when the catalog is unavailable', () => {
    const view = resolveNewSessionModelView({ ...baseInput, catalog: null });

    expect(view.options.every(option => option.overrideSource === 'legacy-gateway')).toBe(true);
    expect(view.options.every(option => option.modelRef?.providerID === 'kilo')).toBe(true);
    expect(view.spawnSelection).toEqual({
      model: { providerID: 'kilo', modelID: 'kilo-auto/efficient' },
      variant: 'high',
    });
  });

  it('emits no wire model when the fallback gateway model is not in the gateway list', () => {
    const view = resolveNewSessionModelView({
      ...baseInput,
      catalog: null,
      gatewayModel: 'unknown/model',
      gatewayVariant: '',
    });

    expect(view.spawnSelection).toBeUndefined();
  });

  it('selects the first catalog option when the catalog has no defaultModel', () => {
    const catalog = createCatalog([
      { id: 'kilo', models: [{ id: 'kilo-model-a' }] },
      { id: 'anthropic', models: [{ id: 'claude-x' }] },
      { id: 'opencode', models: [{ id: 'opencode-model' }] },
    ]);
    const view = resolveNewSessionModelView({ ...baseInput, catalog });

    expect(view.selectedValue).toBe(view.options[0]?.id);
    expect(view.spawnSelection).toEqual({ model: view.options[0]?.modelRef });
  });

  it('drops a CLI override when the catalog is gone and falls back to the gateway', () => {
    const view = resolveNewSessionModelView({
      ...baseInput,
      catalog: null,
      remoteOverride: {
        source: 'cli-catalog',
        selection: { model: { providerID: 'anthropic', modelID: 'claude-x' }, variant: 'high' },
      },
    });

    expect(view.isSelectionUnavailable).toBe(false);
    expect(view.options.every(option => option.modelRef?.providerID === 'kilo')).toBe(true);
    expect(view.spawnSelection).toEqual({
      model: { providerID: 'kilo', modelID: 'kilo-auto/efficient' },
      variant: 'high',
    });
  });

  it('drops a stale legacy override when a catalog without that model arrives', () => {
    const catalog = createCatalog(
      [
        { id: 'kilo', models: [{ id: 'kilo-model-a' }] },
        { id: 'anthropic', models: [{ id: 'claude-x' }] },
        { id: 'opencode', models: [{ id: 'opencode-model' }] },
      ],
      { providerID: 'anthropic', modelID: 'claude-x' }
    );
    const view = resolveNewSessionModelView({
      ...baseInput,
      catalog,
      remoteOverride: {
        source: 'legacy-gateway',
        selection: { model: { providerID: 'kilo', modelID: 'stale/gateway-model' } },
      },
    });

    expect(view.options.some(option => option.unavailable)).toBe(false);
    expect(view.isSelectionUnavailable).toBe(false);
    expect(view.spawnSelection).toEqual({
      model: { providerID: 'anthropic', modelID: 'claude-x' },
    });
  });

  it('keeps the unavailable signal for a CLI pick the catalog dropped', () => {
    const view = resolveNewSessionModelView({
      ...baseInput,
      remoteOverride: {
        source: 'cli-catalog',
        selection: { model: { providerID: 'anthropic', modelID: 'removed-model' } },
      },
    });

    expect(view.isSelectionUnavailable).toBe(true);
    expect(view.spawnSelection).toBeUndefined();
  });

  it('never leaks a previous instance model into a new instance selection', () => {
    const catalogA = createCatalog([
      { id: 'kilo', models: [{ id: 'kilo-model-a' }] },
      { id: 'anthropic', models: [{ id: 'claude-x' }] },
      { id: 'opencode', models: [{ id: 'opencode-model' }] },
    ]);
    const catalogB = createCatalog([
      { id: 'kilo', models: [{ id: 'kilo-model-a' }] },
      { id: 'openai', models: [{ id: 'gpt-y' }] },
      { id: 'opencode', models: [{ id: 'opencode-model' }] },
    ]);
    const claudeOverride = {
      source: 'cli-catalog' as const,
      selection: { model: { providerID: 'anthropic', modelID: 'claude-x' } },
    };

    const onInstanceA = resolveNewSessionModelView({
      ...baseInput,
      catalog: catalogA,
      remoteOverride: claudeOverride,
    });
    expect(onInstanceA.spawnSelection?.model.providerID).toBe('anthropic');

    const onInstanceB = resolveNewSessionModelView({
      ...baseInput,
      catalog: catalogB,
      remoteOverride: null,
    });
    expect(onInstanceB.options.some(option => option.provider?.id === 'anthropic')).toBe(false);
    expect(onInstanceB.spawnSelection).toBeDefined();
    expect(onInstanceB.spawnSelection?.model.providerID).not.toBe('anthropic');

    const onInstanceBWithStaleOverride = resolveNewSessionModelView({
      ...baseInput,
      catalog: catalogB,
      remoteOverride: claudeOverride,
    });
    expect(onInstanceBWithStaleOverride.isSelectionUnavailable).toBe(true);
    expect(onInstanceBWithStaleOverride.spawnSelection).toBeUndefined();
  });

  it('composes the view with the real wire builder end to end', () => {
    const view = resolveNewSessionModelView({
      ...baseInput,
      remoteOverride: {
        source: 'cli-catalog',
        selection: { model: { providerID: 'anthropic', modelID: 'claude-x' } },
      },
    });

    expect(buildCreateRemoteSessionInput({ mode: 'code', selection: view.spawnSelection })).toEqual(
      {
        agent: 'code',
        model: { providerID: 'anthropic', modelID: 'claude-x' },
      }
    );
  });
});
