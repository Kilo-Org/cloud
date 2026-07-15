import { describe, expect, it } from 'vitest';

import {
  findAgentBySlug,
  hasCatalogCapability,
  isUsableCatalog,
  resolveInitialModelSelection,
  resolveSelectedRuntimeFence,
  runtimeFenceEquals,
} from './local-runtime-catalog-selection';
import {
  makeCatalog,
  makeRuntime,
  RUNTIME_A,
  RUNTIME_B,
  RUNTIME_INCAPABLE,
} from './local-runtime-catalog-test-fixtures';

describe('runtimeFenceEquals', () => {
  it('returns true when runtimeId and connectionId both match', () => {
    expect(
      runtimeFenceEquals(makeRuntime(), {
        runtimeId: RUNTIME_A.runtimeId,
        connectionId: RUNTIME_A.connectionId,
      })
    ).toBe(true);
  });

  it('returns false when the connectionId differs (new socket for the same process)', () => {
    expect(
      runtimeFenceEquals(makeRuntime(), {
        runtimeId: RUNTIME_A.runtimeId,
        connectionId: 'cli-other',
      })
    ).toBe(false);
  });

  it('returns true when both arguments are fences with matching ids', () => {
    expect(
      runtimeFenceEquals(
        { runtimeId: RUNTIME_A.runtimeId, connectionId: RUNTIME_A.connectionId },
        { runtimeId: RUNTIME_A.runtimeId, connectionId: RUNTIME_A.connectionId }
      )
    ).toBe(true);
  });

  it('returns false when comparing two fences with different connectionIds', () => {
    expect(
      runtimeFenceEquals(
        { runtimeId: RUNTIME_A.runtimeId, connectionId: RUNTIME_A.connectionId },
        { runtimeId: RUNTIME_A.runtimeId, connectionId: 'cli-other' }
      )
    ).toBe(false);
  });
});

describe('hasCatalogCapability', () => {
  it('returns true when catalog.v1 is advertised', () => {
    expect(hasCatalogCapability(makeRuntime())).toBe(true);
  });

  it('returns false when the capability is missing', () => {
    expect(hasCatalogCapability(makeRuntime({ capabilities: ['create-and-run.v1'] }))).toBe(false);
  });
});

describe('resolveSelectedRuntimeFence', () => {
  it('returns the previous fence when the same fence is still in the list', () => {
    expect(
      resolveSelectedRuntimeFence([makeRuntime()], {
        runtimeId: RUNTIME_A.runtimeId,
        connectionId: RUNTIME_A.connectionId,
      })
    ).toEqual({
      runtimeId: RUNTIME_A.runtimeId,
      connectionId: RUNTIME_A.connectionId,
    });
  });

  it('drops the previous fence when its connectionId no longer matches (runtime reconnect)', () => {
    expect(
      resolveSelectedRuntimeFence([makeRuntime({ connectionId: 'cli-new' })], {
        runtimeId: RUNTIME_A.runtimeId,
        connectionId: RUNTIME_A.connectionId,
      })
    ).toEqual({ runtimeId: RUNTIME_A.runtimeId, connectionId: 'cli-new' });
  });

  it('drops the previous fence when the runtimeId is gone entirely (disconnect)', () => {
    expect(
      resolveSelectedRuntimeFence([makeRuntime({ runtimeId: RUNTIME_B.runtimeId })], {
        runtimeId: RUNTIME_A.runtimeId,
        connectionId: RUNTIME_A.connectionId,
      })
    ).toBeNull();
  });

  it('auto-selects the only capable runtime when no fence is set', () => {
    expect(resolveSelectedRuntimeFence([makeRuntime()], null)).toEqual({
      runtimeId: RUNTIME_A.runtimeId,
      connectionId: RUNTIME_A.connectionId,
    });
  });

  it('does not auto-select when multiple capable runtimes are present', () => {
    expect(resolveSelectedRuntimeFence([makeRuntime(), makeRuntime(RUNTIME_B)], null)).toBeNull();
  });

  it('does not auto-select an incapable runtime', () => {
    expect(resolveSelectedRuntimeFence([makeRuntime(RUNTIME_INCAPABLE)], null)).toBeNull();
  });

  it('preserves the current fence even if multiple other capable runtimes appear', () => {
    expect(
      resolveSelectedRuntimeFence([makeRuntime(), makeRuntime(RUNTIME_B)], {
        runtimeId: RUNTIME_A.runtimeId,
        connectionId: RUNTIME_A.connectionId,
      })
    ).toEqual({ runtimeId: RUNTIME_A.runtimeId, connectionId: RUNTIME_A.connectionId });
  });

  it('returns null on an empty list', () => {
    expect(resolveSelectedRuntimeFence([], null)).toBeNull();
  });
});

describe('findAgentBySlug', () => {
  it('finds the exact agent slug', () => {
    const catalog = makeCatalog();
    expect(findAgentBySlug(catalog, 'build')?.name).toBe('Build');
  });

  it('returns null for an unknown slug', () => {
    expect(findAgentBySlug(makeCatalog(), 'unknown')).toBeNull();
  });
});

describe('resolveInitialModelSelection', () => {
  it('uses the agent-pinned model and variant when present', () => {
    const catalog = makeCatalog();
    const agent = {
      slug: 'build',
      name: 'Build',
      model: { providerID: 'anthropic', modelID: 'claude-1' },
      variant: 'high',
    };
    expect(resolveInitialModelSelection(catalog, agent)).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-1',
      variant: 'high',
    });
  });

  it('falls back to the catalog defaultModel when the agent has no pinned model', () => {
    const catalog = makeCatalog({ defaultModel: { providerID: 'anthropic', modelID: 'claude-1' } });
    expect(resolveInitialModelSelection(catalog, { slug: 'build', name: 'Build' })).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-1',
      variant: '',
    });
  });

  it('falls back to the first model and first variant when nothing else is set', () => {
    const catalog = makeCatalog();
    expect(resolveInitialModelSelection(catalog, { slug: 'build', name: 'Build' })).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-1',
      variant: 'low',
    });
  });

  it('returns null when the catalog has no models at all', () => {
    const empty = makeCatalog({ providers: [] });
    expect(resolveInitialModelSelection(empty, { slug: 'build', name: 'Build' })).toBeNull();
  });
});

describe('isUsableCatalog', () => {
  it('returns true for a well-formed catalog', () => {
    expect(isUsableCatalog(makeCatalog())).toBe(true);
  });

  it('returns false when the default agent is missing from the catalog', () => {
    expect(isUsableCatalog(makeCatalog({ defaultAgent: 'ghost' }))).toBe(false);
  });

  it('returns false when the default agent is empty', () => {
    expect(isUsableCatalog(makeCatalog({ defaultAgent: '' }))).toBe(false);
  });

  it('returns false when there are no providers', () => {
    expect(isUsableCatalog(makeCatalog({ providers: [] }))).toBe(false);
  });

  it('returns false when there are no agents', () => {
    expect(isUsableCatalog(makeCatalog({ agents: [] }))).toBe(false);
  });
});
