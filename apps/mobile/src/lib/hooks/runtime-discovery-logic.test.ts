import { describe, expect, it, vi } from 'vitest';

import {
  buildRuntimeDiscoveryRows,
  buildRuntimeDiscoveryViewModel,
  hasRequiredRuntimeCapabilities,
  type LocalRuntime,
  RUNTIME_DISCOVERY_COPY,
  type RuntimeDiscoveryRow,
  type RuntimeDiscoveryViewModel,
} from './runtime-discovery-logic';

function makeRuntime(overrides: Partial<LocalRuntime> = {}): LocalRuntime {
  const runtime: LocalRuntime = {
    runtimeId: '11111111-1111-4111-8111-111111111111',
    connectionId: 'conn-1',
    protocolVersion: 1,
    cliVersion: '1.2.3',
    displayName: 'My MacBook',
    projectName: 'kilo',
    capabilities: ['catalog.v1', 'create-and-run.v1'],
    ...overrides,
  };
  return runtime;
}

describe('hasRequiredRuntimeCapabilities', () => {
  it('returns true when both required capabilities are present', () => {
    expect(hasRequiredRuntimeCapabilities(['catalog.v1', 'create-and-run.v1'])).toBe(true);
  });

  it('returns false when catalog.v1 is missing', () => {
    expect(hasRequiredRuntimeCapabilities(['create-and-run.v1'])).toBe(false);
  });

  it('returns false when create-and-run.v1 is missing', () => {
    expect(hasRequiredRuntimeCapabilities(['catalog.v1'])).toBe(false);
  });

  it('returns false for an empty capability list', () => {
    expect(hasRequiredRuntimeCapabilities([])).toBe(false);
  });

  it('is order-independent', () => {
    expect(hasRequiredRuntimeCapabilities(['create-and-run.v1', 'catalog.v1'])).toBe(true);
  });
});

describe('buildRuntimeDiscoveryRows', () => {
  it('returns an empty array when the list is empty', () => {
    expect(buildRuntimeDiscoveryRows([])).toEqual([]);
  });

  it('marks a single capable runtime as capable and projects all three labels', () => {
    const runtime = makeRuntime();
    const rows = buildRuntimeDiscoveryRows([runtime]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual<RuntimeDiscoveryRow>({
      kind: 'capable',
      runtime,
      displayName: 'My MacBook',
      projectName: 'kilo',
      cliVersion: '1.2.3',
    });
  });

  it('marks a runtime without both capabilities as incapable', () => {
    const runtime = makeRuntime({ capabilities: ['catalog.v1'] });
    const rows = buildRuntimeDiscoveryRows([runtime]);
    expect(rows[0]?.kind).toBe('incapable');
  });

  it('preserves input order across multiple rows', () => {
    const a = makeRuntime({ runtimeId: '11111111-1111-4111-8111-111111111111', displayName: 'A' });
    const b = makeRuntime({
      runtimeId: '22222222-2222-4222-8222-222222222222',
      displayName: 'B',
      capabilities: ['catalog.v1'],
    });
    const rows = buildRuntimeDiscoveryRows([a, b]);
    expect(rows.map(r => r.displayName)).toEqual(['A', 'B']);
    expect(rows[0]?.kind).toBe('capable');
    expect(rows[1]?.kind).toBe('incapable');
  });
});

describe('buildRuntimeDiscoveryViewModel', () => {
  it('returns loading when no data and not in error', () => {
    const refetch = vi.fn<() => void>();
    const vm = buildRuntimeDiscoveryViewModel({ data: undefined, isError: false, refetch });
    expect(vm).toEqual<RuntimeDiscoveryViewModel>({ kind: 'loading' });
    expect(refetch).not.toHaveBeenCalled();
  });

  it('returns error with exact title/message and the refetch callback when the initial load fails', () => {
    const refetch = vi.fn<() => void>();
    const vm = buildRuntimeDiscoveryViewModel({ data: undefined, isError: true, refetch });
    expect(vm.kind).toBe('error');
    if (vm.kind !== 'error') {
      throw new Error('expected error view model');
    }
    expect(vm.title).toBe(RUNTIME_DISCOVERY_COPY.error.title);
    expect(vm.message).toBe(RUNTIME_DISCOVERY_COPY.error.message);
    vm.retry();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('returns empty with exact title/message and the refetch callback when the list has no runtimes', () => {
    const refetch = vi.fn<() => void>();
    const vm = buildRuntimeDiscoveryViewModel({
      data: { runtimes: [] },
      isError: false,
      refetch,
    });
    expect(vm.kind).toBe('empty');
    if (vm.kind !== 'empty') {
      throw new Error('expected empty view model');
    }
    expect(vm.title).toBe(RUNTIME_DISCOVERY_COPY.empty.title);
    expect(vm.message).toBe(RUNTIME_DISCOVERY_COPY.empty.message);
    vm.retry();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('returns ready with projected rows when a capable runtime is present', () => {
    const runtime = makeRuntime();
    const onSelect = vi.fn<(runtime: LocalRuntime) => void>();
    const refetch = vi.fn<() => void>();
    const vm = buildRuntimeDiscoveryViewModel({
      data: { runtimes: [runtime] },
      isError: false,
      refetch,
      onSelect,
    });
    expect(vm.kind).toBe('ready');
    if (vm.kind !== 'ready') {
      throw new Error('expected ready view model');
    }
    expect(vm.rows).toHaveLength(1);
    expect(vm.rows[0]).toMatchObject<RuntimeDiscoveryRow>({
      kind: 'capable',
      runtime,
      displayName: 'My MacBook',
      projectName: 'kilo',
      cliVersion: '1.2.3',
    });
  });

  it('preserves runtimes input order across mixed capable/incapable rows', () => {
    const capable = makeRuntime({
      runtimeId: '11111111-1111-4111-8111-111111111111',
      displayName: 'Capable',
    });
    const incapable = makeRuntime({
      runtimeId: '22222222-2222-4222-8222-222222222222',
      displayName: 'Incapable',
      capabilities: ['catalog.v1'],
    });
    const vm = buildRuntimeDiscoveryViewModel({
      data: { runtimes: [capable, incapable] },
      isError: false,
      refetch: vi.fn<() => void>(),
    });
    if (vm.kind !== 'ready') {
      throw new Error('expected ready view model');
    }
    expect(vm.rows.map(r => [r.kind, r.displayName])).toEqual([
      ['capable', 'Capable'],
      ['incapable', 'Incapable'],
    ]);
  });

  it('keeps cached rows and never collapses into the error state when a background refetch fails', () => {
    const runtime = makeRuntime();
    const refetch = vi.fn<() => void>();
    const vm = buildRuntimeDiscoveryViewModel({
      data: { runtimes: [runtime] },
      isError: true,
      refetch,
    });
    expect(vm.kind).toBe('ready');
    if (vm.kind !== 'ready') {
      throw new Error('expected ready view model to win over error');
    }
    expect(vm.rows[0]?.runtime).toBe(runtime);
    // The retry surface is only present on the error/empty branches, so a
    // ready view-model must not expose one.
    expect('retry' in vm).toBe(false);
  });

  it('routes onSelect through to the consumer for capable rows when provided', () => {
    const onSelect = vi.fn<(runtime: LocalRuntime) => void>();
    const vm = buildRuntimeDiscoveryViewModel({
      data: { runtimes: [makeRuntime()] },
      isError: false,
      refetch: vi.fn<() => void>(),
      onSelect,
    });
    if (vm.kind !== 'ready') {
      throw new Error('expected ready view model');
    }
    const row = vm.rows[0];
    if (!row) {
      throw new Error('expected at least one row');
    }
    vm.onSelect(row.runtime);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(row.runtime);
  });

  it('no-ops onSelect when the consumer did not pass a callback', () => {
    const vm = buildRuntimeDiscoveryViewModel({
      data: { runtimes: [makeRuntime()] },
      isError: false,
      refetch: vi.fn<() => void>(),
    });
    if (vm.kind !== 'ready') {
      throw new Error('expected ready view model');
    }
    const row = vm.rows[0];
    if (!row) {
      throw new Error('expected at least one row');
    }
    expect(() => {
      vm.onSelect(row.runtime);
    }).not.toThrow();
  });
});
