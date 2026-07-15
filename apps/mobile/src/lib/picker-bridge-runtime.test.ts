import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type LocalRuntime } from '@/lib/hooks/runtime-discovery-logic';

import {
  areRuntimePickerSelectionScopesEqual,
  clearRuntimePickerBridge,
  commitRuntimePickerSelection,
  getRuntimePickerBridge,
  resolveRuntimePickerSelection,
  type RuntimePickerSelectionScope,
  setRuntimePickerBridge,
} from './picker-bridge';

const RUNTIME_A: LocalRuntime = {
  runtimeId: '11111111-1111-4111-8111-111111111111',
  connectionId: 'cli-a',
  protocolVersion: 1,
  cliVersion: '1.2.3',
  displayName: 'Mac A',
  projectName: 'kilo',
  capabilities: ['catalog.v1', 'create-and-run.v1'],
};

const RUNTIME_B: LocalRuntime = {
  runtimeId: '22222222-2222-4222-8222-222222222222',
  connectionId: 'cli-b',
  protocolVersion: 1,
  cliVersion: '1.2.3',
  displayName: 'Mac B',
  projectName: 'kilo',
  capabilities: ['catalog.v1', 'create-and-run.v1'],
};

describe('runtime picker bridge', () => {
  beforeEach(() => {
    clearRuntimePickerBridge();
  });

  it('preserves exact runtimeId and connectionId when resolving a draft fence', () => {
    const onSelect = vi.fn<(fence: { runtimeId: string; connectionId: string }) => void>();
    setRuntimePickerBridge({
      runtimes: [RUNTIME_A, RUNTIME_B],
      currentFence: { runtimeId: RUNTIME_A.runtimeId, connectionId: RUNTIME_A.connectionId },
      selectionScope: {
        runtimeId: RUNTIME_A.runtimeId,
        connectionId: RUNTIME_A.connectionId,
      },
      isSelectionCurrent: () => true,
      onSelect: fence => {
        onSelect(fence);
      },
    });

    const bridge = getRuntimePickerBridge();
    if (!bridge) {
      throw new Error('Expected runtime picker bridge');
    }

    const fence = resolveRuntimePickerSelection(
      bridge,
      RUNTIME_A.runtimeId,
      RUNTIME_A.connectionId
    );
    expect(fence).toEqual({
      runtimeId: RUNTIME_A.runtimeId,
      connectionId: RUNTIME_A.connectionId,
    });
  });

  it('returns null when the candidate fence is not in the live list', () => {
    setRuntimePickerBridge({
      runtimes: [RUNTIME_A],
      currentFence: null,
      selectionScope: null,
      isSelectionCurrent: () => true,
      onSelect: () => undefined,
    });
    const bridge = getRuntimePickerBridge();
    if (!bridge) {
      throw new Error('Expected runtime picker bridge');
    }

    expect(
      resolveRuntimePickerSelection(bridge, RUNTIME_B.runtimeId, RUNTIME_B.connectionId)
    ).toBeNull();
  });

  it('treats runtimeId and connectionId changes as stale runtime scopes', () => {
    const scope: RuntimePickerSelectionScope = {
      runtimeId: RUNTIME_A.runtimeId,
      connectionId: RUNTIME_A.connectionId,
    };
    expect(areRuntimePickerSelectionScopesEqual(scope, scope)).toBe(true);
    expect(
      areRuntimePickerSelectionScopesEqual(scope, { ...scope, connectionId: 'cli-a-new' })
    ).toBe(false);
    expect(
      areRuntimePickerSelectionScopesEqual(scope, {
        runtimeId: RUNTIME_B.runtimeId,
        connectionId: RUNTIME_A.connectionId,
      })
    ).toBe(false);
  });

  it('commits a runtime tap when the scope is current and the fence is in the list', () => {
    const onSelect = vi.fn<(fence: { runtimeId: string; connectionId: string }) => void>();
    const bridge = {
      runtimes: [RUNTIME_A, RUNTIME_B],
      currentFence: null,
      selectionScope: {
        runtimeId: RUNTIME_A.runtimeId,
        connectionId: RUNTIME_A.connectionId,
      },
      isSelectionCurrent: vi.fn(() => true),
      onSelect,
    };

    expect(commitRuntimePickerSelection(bridge, RUNTIME_B.runtimeId, RUNTIME_B.connectionId)).toBe(
      true
    );
    expect(onSelect).toHaveBeenCalledWith({
      runtimeId: RUNTIME_B.runtimeId,
      connectionId: RUNTIME_B.connectionId,
    });
  });

  it('discards a tap when the scope is stale', () => {
    const onSelect = vi.fn<(fence: { runtimeId: string; connectionId: string }) => void>();
    const bridge = {
      runtimes: [RUNTIME_A, RUNTIME_B],
      currentFence: null,
      selectionScope: {
        runtimeId: RUNTIME_A.runtimeId,
        connectionId: RUNTIME_A.connectionId,
      },
      isSelectionCurrent: vi.fn(() => false),
      onSelect,
    };

    expect(commitRuntimePickerSelection(bridge, RUNTIME_B.runtimeId, RUNTIME_B.connectionId)).toBe(
      false
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('discards a tap when the selectionScope is null', () => {
    const onSelect = vi.fn<(fence: { runtimeId: string; connectionId: string }) => void>();
    const bridge = {
      runtimes: [RUNTIME_A, RUNTIME_B],
      currentFence: null,
      selectionScope: null,
      isSelectionCurrent: vi.fn(() => true),
      onSelect,
    };

    expect(commitRuntimePickerSelection(bridge, RUNTIME_A.runtimeId, RUNTIME_A.connectionId)).toBe(
      false
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('discards a tap when the candidate fence is not in the live list', () => {
    const onSelect = vi.fn<(fence: { runtimeId: string; connectionId: string }) => void>();
    const bridge = {
      runtimes: [RUNTIME_A],
      currentFence: null,
      selectionScope: {
        runtimeId: RUNTIME_A.runtimeId,
        connectionId: RUNTIME_A.connectionId,
      },
      isSelectionCurrent: vi.fn(() => true),
      onSelect,
    };

    expect(commitRuntimePickerSelection(bridge, RUNTIME_B.runtimeId, RUNTIME_B.connectionId)).toBe(
      false
    );
    expect(onSelect).not.toHaveBeenCalled();
  });
});
