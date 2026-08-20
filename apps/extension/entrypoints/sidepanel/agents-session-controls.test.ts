/* eslint-disable sort-keys */
import { describe, expect, it } from 'vitest';
import type {
  ContextUsage,
  RemoteModelCatalogV1,
  RemoteModelState,
} from '@kilocode/cloud-agent-sdk';
import type { KiloGatewayModelOption } from '@/src/shared/kilo-api-client';
import {
  cliCatalogModelId,
  findCliCatalogModelRef,
  resolveSessionContextWindow,
  selectSessionCostUsd,
  selectSessionModelPicker,
  shouldShowContextMetrics,
} from './agents-session-controls';

const model = (id: string, contextLength?: number): KiloGatewayModelOption => ({
  id,
  isPreferred: false,
  name: id,
  variants: [],
  ...(contextLength === undefined ? {} : { contextLength }),
});

const usage = (modelID: string, providerID = 'kilo'): ContextUsage => ({
  contextTokens: 1234,
  modelID,
  providerID,
});

describe('resolveSessionContextWindow()', () => {
  it('resolves the window for a gateway model', () => {
    expect(resolveSessionContextWindow(usage('a/b'), [model('a/b', 200_000)])).toBe(200_000);
  });

  it('returns undefined without context usage', () => {
    expect(resolveSessionContextWindow(undefined, [model('a/b', 200_000)])).toBeUndefined();
  });

  it('returns undefined for a non-gateway provider', () => {
    expect(
      resolveSessionContextWindow(usage('a/b', 'anthropic'), [model('a/b', 200_000)])
    ).toBeUndefined();
  });

  it('returns undefined when the catalog has no matching id', () => {
    expect(resolveSessionContextWindow(usage('a/b'), [model('c/d', 200_000)])).toBeUndefined();
  });

  it('returns undefined when the matching option has no window', () => {
    expect(resolveSessionContextWindow(usage('a/b'), [model('a/b')])).toBeUndefined();
  });

  it('ignores a non-positive window', () => {
    expect(resolveSessionContextWindow(usage('a/b'), [model('a/b', 0)])).toBeUndefined();
  });

  it('treats a conflicting duplicate id as unknown', () => {
    expect(
      resolveSessionContextWindow(usage('a/b'), [model('a/b', 200_000), model('a/b', 128_000)])
    ).toBeUndefined();
  });

  it('accepts an agreeing duplicate id', () => {
    expect(
      resolveSessionContextWindow(usage('a/b'), [model('a/b', 200_000), model('a/b', 200_000)])
    ).toBe(200_000);
  });
});

describe('selectSessionCostUsd()', () => {
  it('takes the persisted total when it is larger', () => {
    expect(selectSessionCostUsd(2_500_000, 1.5)).toBe(2.5);
  });

  it('takes the live total when it is larger', () => {
    expect(selectSessionCostUsd(1_000_000, 3.25)).toBe(3.25);
  });

  it('ignores a missing or non-finite persisted total', () => {
    expect(selectSessionCostUsd(null, 2)).toBe(2);
    expect(selectSessionCostUsd(undefined, 2)).toBe(2);
    expect(selectSessionCostUsd(Number.NaN, 2)).toBe(2);
  });

  it('clamps negative inputs to zero', () => {
    expect(selectSessionCostUsd(-5, -1)).toBe(0);
  });
});

const noUsage: ContextUsage | undefined = undefined;

describe('shouldShowContextMetrics()', () => {
  it('hides while the session loads', () => {
    expect(shouldShowContextMetrics(true, usage('a/b'))).toBe(false);
  });

  it('hides until the first assistant reply reports usage', () => {
    expect(shouldShowContextMetrics(false, noUsage)).toBe(false);
  });

  it('shows for a loaded session with usage', () => {
    expect(shouldShowContextMetrics(false, usage('a/b'))).toBe(true);
  });
});

const catalogModel = (
  id: string,
  extra: { readonly name?: string; readonly recommendedIndex?: number } = {}
): RemoteModelCatalogV1['providers'][number]['models'][number] => ({
  capabilities: { attachment: false, reasoning: false },
  id,
  limits: { context: 128_000, output: 8000 },
  variants: [],
  ...extra,
});

const catalog: RemoteModelCatalogV1 = {
  protocolVersion: 1,
  providers: [
    { id: 'kilo', models: [catalogModel('grok-code', { recommendedIndex: 0 })], name: 'Kilo' },
    { id: 'anthropic', models: [catalogModel('claude-sonnet-4', { name: 'Sonnet 4' })] },
  ],
  defaultModel: { modelID: 'grok-code', providerID: 'kilo' },
  truncated: false,
};

const remoteState = (overrides: Partial<RemoteModelState> = {}): RemoteModelState => ({
  ownerConnectionId: null,
  protocol: 'unknown',
  refresh: 'idle',
  ...overrides,
});

const pickerInput = {
  activeSessionType: null,
  cloudOverride: null,
  gatewayModels: [model('a/b', 200_000)],
  observedModel: null,
  remoteModelOverride: null,
  remoteModelState: remoteState(),
  sessionModel: null,
} satisfies Parameters<typeof selectSessionModelPicker>[0];

describe('cliCatalogModelId and findCliCatalogModelRef', () => {
  it('round-trips a catalog model ref through its row id', () => {
    const id = cliCatalogModelId({ modelID: 'claude-sonnet-4', providerID: 'anthropic' });
    expect(id).toBe('cli:anthropic/claude-sonnet-4');
    expect(findCliCatalogModelRef(catalog, id)).toStrictEqual({
      modelID: 'claude-sonnet-4',
      providerID: 'anthropic',
    });
  });

  it('returns undefined for an id the catalog does not have', () => {
    expect(findCliCatalogModelRef(catalog, 'cli:anthropic/nope')).toBeUndefined();
    expect(findCliCatalogModelRef(undefined, 'cli:anthropic/claude-sonnet-4')).toBeUndefined();
    expect(findCliCatalogModelRef(catalog, 'anthropic/claude-sonnet-4')).toBeUndefined();
  });
});

describe('selectSessionModelPicker()', () => {
  it('picks gateway models for a cloud-agent session', () => {
    expect(
      selectSessionModelPicker({
        ...pickerInput,
        activeSessionType: 'cloud-agent',
        cloudOverride: { model: 'picked' },
        sessionModel: 'configured',
      })
    ).toStrictEqual({
      disabledReason: undefined,
      options: pickerInput.gatewayModels,
      selectedId: 'picked',
      target: 'cloud-agent',
    });
  });

  it('falls back to the session model for a cloud-agent session', () => {
    expect(
      selectSessionModelPicker({
        ...pickerInput,
        activeSessionType: 'cloud-agent',
        sessionModel: 'configured',
      }).selectedId
    ).toBe('configured');
  });

  it('picks gateway models for a legacy remote session', () => {
    expect(
      selectSessionModelPicker({
        ...pickerInput,
        activeSessionType: 'remote',
        remoteModelOverride: {
          selection: { model: { modelID: 'picked', providerID: 'kilo' } },
          source: 'legacy-gateway',
        },
        remoteModelState: remoteState({ protocol: 'legacy' }),
      })
    ).toStrictEqual({
      disabledReason: undefined,
      options: pickerInput.gatewayModels,
      selectedId: 'picked',
      target: 'remote-legacy',
    });
  });

  it("projects a v1 CLI's own catalog, prefixed so no gateway id can collide", () => {
    const picker = selectSessionModelPicker({
      ...pickerInput,
      activeSessionType: 'remote',
      remoteModelState: remoteState({ catalog, protocol: 'v1' }),
    });

    expect(picker.target).toBe('remote-cli');
    expect(picker.options.map(option => option.id)).toStrictEqual([
      'cli:kilo/grok-code',
      'cli:anthropic/claude-sonnet-4',
    ]);
    expect(picker.options.map(option => option.name)).toStrictEqual(['grok-code', 'Sonnet 4']);
    // No row is promoted: the CLI's own catalog order stands.
    expect(picker.options.map(option => option.isPreferred)).toStrictEqual([false, false]);
    expect(picker.options[0]?.contextLength).toBe(128_000);
  });

  it('selects the catalog default, then the observed model, then the override', () => {
    const base = {
      ...pickerInput,
      activeSessionType: 'remote' as const,
      remoteModelState: remoteState({ catalog, protocol: 'v1' }),
    };

    expect(selectSessionModelPicker(base).selectedId).toBe('cli:kilo/grok-code');
    expect(
      selectSessionModelPicker({
        ...base,
        observedModel: { model: { modelID: 'claude-sonnet-4', providerID: 'anthropic' } },
      }).selectedId
    ).toBe('cli:anthropic/claude-sonnet-4');
    expect(
      selectSessionModelPicker({
        ...base,
        observedModel: { model: { modelID: 'claude-sonnet-4', providerID: 'anthropic' } },
        remoteModelOverride: {
          selection: { model: { modelID: 'grok-code', providerID: 'kilo' } },
          source: 'cli-catalog',
        },
      }).selectedId
    ).toBe('cli:kilo/grok-code');
  });

  it('offers no options while a v1 CLI has reported no catalog', () => {
    expect(
      selectSessionModelPicker({
        ...pickerInput,
        activeSessionType: 'remote',
        remoteModelState: remoteState({ protocol: 'v1' }),
        sessionModel: 'session-model',
      })
    ).toStrictEqual({
      disabledReason: 'Loading models…',
      options: [],
      selectedId: 'session-model',
      target: 'remote-unavailable',
    });
  });

  it('offers no options when the CLI catalog has no connected provider', () => {
    const picker = selectSessionModelPicker({
      ...pickerInput,
      activeSessionType: 'remote',
      remoteModelState: remoteState({
        catalog: { ...catalog, providers: [] },
        protocol: 'v1',
      }),
    });

    expect(picker.target).toBe('remote-unavailable');
    expect(picker.disabledReason).toBe('Loading models…');
  });

  it('reports a failed catalog fetch as unavailable', () => {
    expect(
      selectSessionModelPicker({
        ...pickerInput,
        activeSessionType: 'remote',
        remoteModelState: remoteState({ protocol: 'unknown', refresh: 'error' }),
      }).disabledReason
    ).toBe('Models unavailable');
  });

  it('has no picker for a read-only or unresolved session', () => {
    const readOnly = selectSessionModelPicker({ ...pickerInput, activeSessionType: 'read-only' });
    expect(readOnly.target).toBeNull();
    expect(selectSessionModelPicker(pickerInput).target).toBeNull();
  });
});
