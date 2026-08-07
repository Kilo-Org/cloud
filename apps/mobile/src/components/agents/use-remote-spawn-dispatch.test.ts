import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ModelSelection } from '@kilocode/cloud-agent-sdk';

import { type InstancePickerInstance } from '@/lib/picker-bridge';
import {
  __resetSharePayloadStoreForTests,
  peekSharePayload,
  type SharePayload,
} from '@/lib/share-payload';
import { buildCreateRemoteSessionInput } from '@/lib/hooks/remote-instance-spawn-classifier';

import { useRemoteSpawnDispatch } from './use-remote-spawn-dispatch';

const spawnMock = vi.hoisted(() =>
  vi.fn(async () => {
    await Promise.resolve();
    return {
      status: 'ready' as const,
      sessionID: 'ses_12345678901234567890123456',
    };
  })
);

const useRemoteInstanceSpawnMock = vi.hoisted(() =>
  vi.fn((_organizationId?: string | null) => ({
    status: { status: 'idle' as const },
    spawn: spawnMock,
  }))
);

const routerReplace = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: routerReplace }),
}));

vi.mock('sonner-native', () => ({
  toast: { error: vi.fn() },
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'share-id-fixed' }));

vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: null,
  copyAsync: vi.fn().mockResolvedValue('/tmp/copy'),
  deleteAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('expo-share-intent', () => ({}));

// Keep the real input builder; only stub the RN-touching spawn hook.
vi.mock('@/lib/hooks/use-remote-instance-spawn', () => ({
  buildCreateRemoteSessionInput,
  useRemoteInstanceSpawn: (organizationId?: string | null) =>
    useRemoteInstanceSpawnMock(organizationId),
}));

type ReactInternals = {
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
    H: unknown;
  };
};

type HookDispatcher = {
  useCallback: <T>(callback: T, _deps?: unknown) => T;
  useEffect: (effect: React.EffectCallback, _deps?: unknown) => void;
  useMemo: <T>(factory: () => T, _deps?: unknown) => T;
  useRef: <T>(initial: T) => { current: T };
  useState: <T>(initialValue: T) => [T, (value: T | ((previous: T) => T)) => void];
};

const INSTANCE: InstancePickerInstance = {
  connectionId: 'conn-abc',
  name: 'laptop',
  projectName: 'kilo',
};

/** Stub payload for the ready-path-with-payload case. */
const samplePayload: SharePayload = { text: 'hello', files: [], failedFiles: [] };

/**
 * Runs `onStart` and returns the arguments the spawn mock was called with.
 * Extracts the wait-and-capture boilerplate shared by the spawn-input tests.
 */
async function captureSpawnCall(onStart: () => void) {
  onStart();
  await vi.waitFor(() => {
    expect(spawnMock).toHaveBeenCalled();
  });
  return spawnMock.mock.calls[0];
}

/** Runs `onStart` and waits for the ready-path navigation to the spawned session. */
async function runStartAndWaitForReplace(onStart: () => void) {
  onStart();
  await vi.waitFor(() => {
    expect(routerReplace).toHaveBeenCalled();
  });
}

/**
 * Minimal React hook runner. Mirrors the fake-dispatcher pattern in
 * `use-interaction-handlers.test.ts` so we can exercise
 * `useRemoteSpawnDispatch` without pulling react-native into vitest.
 */
function runHook(args: {
  organizationId: string | undefined;
  mode?: string;
  selection?: ModelSelection;
  getSubmitPayload?: () => SharePayload | null;
}) {
  const reactInternals = React as typeof React & ReactInternals;
  const hookState: unknown[] = [];
  const refs: { current: unknown }[] = [];
  let hookIndex = 0;
  let refIndex = 0;

  const dispatcher: HookDispatcher = {
    useCallback: hookCallback => {
      hookIndex += 1;
      return hookCallback;
    },
    useEffect: effect => {
      hookIndex += 1;
      effect();
    },
    useMemo: factory => {
      hookIndex += 1;
      return factory();
    },
    useRef: initial => {
      const index = refIndex;
      refIndex += 1;
      refs[index] ??= { current: initial };
      return refs[index] as { current: typeof initial };
    },
    useState: initialValue => {
      const stateIndex = hookIndex;
      hookIndex += 1;
      hookState[stateIndex] ??= initialValue;
      const setState = (
        value: typeof initialValue | ((previous: typeof initialValue) => typeof initialValue)
      ) => {
        hookState[stateIndex] =
          typeof value === 'function'
            ? (value as (previous: typeof initialValue) => typeof initialValue)(
                hookState[stateIndex] as typeof initialValue
              )
            : value;
      };
      return [hookState[stateIndex] as typeof initialValue, setState];
    },
  };

  const previousDispatcher =
    reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
  hookIndex = 0;
  refIndex = 0;
  reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher;
  try {
    const mountDispatch = useRemoteSpawnDispatch;
    return mountDispatch({
      organizationId: args.organizationId,
      mode: args.mode,
      selection: args.selection,
      runOnInstance: INSTANCE,
      // eslint-disable-next-line no-empty-function -- no-op setter for harness
      setRunOnInstance: (_next: InstancePickerInstance | null) => {},
      // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
      refetchInstances: () => Promise.resolve({ data: { instances: [INSTANCE] } }),
      instanceList: [INSTANCE],
      getSubmitPayload: args.getSubmitPayload,
    });
  } finally {
    reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H =
      previousDispatcher;
  }
}

describe('useRemoteSpawnDispatch spawn input chain', () => {
  beforeEach(() => {
    spawnMock.mockClear();
    useRemoteInstanceSpawnMock.mockClear();
    routerReplace.mockClear();
    __resetSharePayloadStoreForTests();
  });

  it('onStart builds agent from explicit mode and wire model from selection', async () => {
    const { onStart } = runHook({
      organizationId: 'org-xyz',
      mode: 'plan',
      selection: { model: { providerID: 'anthropic', modelID: 'claude-x' }, variant: 'high' },
    });

    expect(await captureSpawnCall(onStart)).toEqual([
      'conn-abc',
      {
        agent: 'plan',
        model: { providerID: 'anthropic', modelID: 'claude-x', variant: 'high' },
        orgId: 'org-xyz',
      },
    ]);
  });

  it('onStart without mode yields org-only input', async () => {
    const { onStart } = runHook({
      organizationId: 'org-xyz',
    });

    expect(await captureSpawnCall(onStart)).toEqual(['conn-abc', { orgId: 'org-xyz' }]);
  });

  it('explicit mode and selection reach the spawn input', async () => {
    const { onStart } = runHook({
      organizationId: undefined,
      mode: 'code',
      selection: { model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' } },
    });

    expect(await captureSpawnCall(onStart)).toEqual([
      'conn-abc',
      { agent: 'code', model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' } },
    ]);
  });

  it('org route passes the route org into useRemoteInstanceSpawn (not inherit)', () => {
    runHook({ organizationId: 'org-route-1' });
    expect(useRemoteInstanceSpawnMock).toHaveBeenCalledWith('org-route-1');
  });

  it('personal route (no param) passes null so context org cannot win', () => {
    runHook({ organizationId: undefined });
    expect(useRemoteInstanceSpawnMock).toHaveBeenCalledWith(null);
  });

  it('personal-route onStart omits orgId when only mode and selection are set', async () => {
    const { onStart } = runHook({
      organizationId: undefined,
      mode: 'code',
      selection: { model: { providerID: 'kilo', modelID: 'kilo-auto/efficient' } },
    });

    expect(await captureSpawnCall(onStart)).toEqual([
      'conn-abc',
      {
        agent: 'code',
        model: { providerID: 'kilo', modelID: 'kilo-auto/efficient' },
      },
    ]);
  });

  it('a non-kilo selection reaches spawn as the provider own model with its variant', async () => {
    const { onStart } = runHook({
      organizationId: 'org-xyz',
      mode: 'code',
      selection: { model: { providerID: 'opencode', modelID: 'opencode-model' }, variant: 'xhigh' },
    });

    expect(await captureSpawnCall(onStart)).toEqual([
      'conn-abc',
      {
        agent: 'code',
        model: { providerID: 'opencode', modelID: 'opencode-model', variant: 'xhigh' },
        orgId: 'org-xyz',
      },
    ]);
  });

  it('an omitted selection reaches spawn with no model key at all', async () => {
    const { onStart } = runHook({
      organizationId: 'org-xyz',
      mode: 'code',
    });

    expect(await captureSpawnCall(onStart)).toEqual([
      'conn-abc',
      { agent: 'code', orgId: 'org-xyz' },
    ]);
  });

  it('ready path stages the press-time payload and navigates with shareId + autoSend', async () => {
    const { onStart } = runHook({
      organizationId: 'org-xyz',
      getSubmitPayload: () => samplePayload,
    });

    await runStartAndWaitForReplace(onStart);

    const calledWith = routerReplace.mock.calls[0]?.[0] as string | undefined;
    expect(typeof calledWith).toBe('string');
    expect(calledWith).toContain('spawned=1');
    expect(calledWith).toContain('shareId=share-id-fixed');
    expect(calledWith).toContain('autoSend=1');
    expect(calledWith).toContain('ses_12345678901234567890123456');

    const stored = peekSharePayload('share-id-fixed');
    expect(stored).not.toBeNull();
    expect(stored?.text).toBe('hello');
  });

  it('ready path navigates without share params when press-time payload is null', async () => {
    const { onStart } = runHook({
      organizationId: 'org-xyz',
      getSubmitPayload: () => null,
    });

    await runStartAndWaitForReplace(onStart);

    const calledWith = routerReplace.mock.calls[0]?.[0] as string | undefined;
    expect(typeof calledWith).toBe('string');
    expect(calledWith).toContain('spawned=1');
    expect(calledWith).toContain('ses_12345678901234567890123456');
    expect(calledWith).not.toContain('shareId=');
    expect(calledWith).not.toContain('autoSend=');
  });

  it('ready path navigates without share params when getSubmitPayload is omitted', async () => {
    const { onStart } = runHook({
      organizationId: 'org-xyz',
    });

    await runStartAndWaitForReplace(onStart);

    const calledWith = routerReplace.mock.calls[0]?.[0] as string | undefined;
    expect(typeof calledWith).toBe('string');
    expect(calledWith).toContain('spawned=1');
    expect(calledWith).not.toContain('shareId=');
    expect(calledWith).not.toContain('autoSend=');
  });
});
