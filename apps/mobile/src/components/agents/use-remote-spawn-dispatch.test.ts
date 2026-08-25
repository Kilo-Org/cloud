/* eslint-disable max-lines -- spawn-input, navigation, and admission suites share the hook harness. */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type KiloSessionId, type ModelSelection } from '@kilocode/cloud-agent-sdk';

import { type InstancePickerInstance } from '@/lib/picker-bridge';
import {
  __resetSharePayloadStoreForTests,
  peekSharePayload,
  type SharePayload,
} from '@/lib/share-payload';
import {
  buildCreateRemoteSessionInput,
  type CreateSessionOutcome,
} from '@/lib/hooks/remote-instance-spawn-classifier';
import { REMOTE_SPAWN_FILES_NOT_SUPPORTED_TOAST } from '@/lib/remote-spawn-admission';
import { remoteSpawnRetryableToast } from '@/lib/remote-submit-outcome';

import { useRemoteSpawnDispatch } from './use-remote-spawn-dispatch';

const spawnMock = vi.hoisted(() =>
  vi.fn(async (): Promise<CreateSessionOutcome> => {
    await Promise.resolve();
    return {
      status: 'ready' as const,
      sessionID: 'ses_12345678901234567890123456' as KiloSessionId,
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
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: routerReplace }),
}));

vi.mock('sonner-native', () => ({
  toast: { error: toastErrorMock },
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
const filesPayload: SharePayload = {
  text: '',
  files: [
    {
      name: 'report.pdf',
      uri: 'file:///tmp/report.pdf',
      mimeType: 'application/pdf',
      size: 1024,
    },
  ],
  failedFiles: [],
};

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
  onSpawnAdmitted?: () => void;
  onSpawnFailed?: () => void;
  runOnInstance?: InstancePickerInstance | null;
  setRunOnInstance?: (next: InstancePickerInstance | null) => void;
  refetchInstances?: () => Promise<{ data: { instances: InstancePickerInstance[] } | undefined }>;
  instanceList?: InstancePickerInstance[];
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

  // `runOnInstance` is parent state in the real route: `setRunOnInstance`
  // re-renders the hook with the new value so the `runOnInstanceRef` effect
  // sees it. Mirror that here; otherwise the async tail's remap would leave
  // the ref on the stale press-time id and the reset guard (which reads the
  // ref) could never be exercised by a remap test.
  let currentRunOnInstance: InstancePickerInstance | null =
    args.runOnInstance === undefined ? INSTANCE : args.runOnInstance;

  const render = () => {
    hookIndex = 0;
    refIndex = 0;
    const previousDispatcher =
      reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
    reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher;
    try {
      const mountDispatch = useRemoteSpawnDispatch;
      return mountDispatch({
        organizationId: args.organizationId,
        mode: args.mode,
        selection: args.selection,
        runOnInstance: currentRunOnInstance,
        setRunOnInstance: next => {
          args.setRunOnInstance?.(next);
          if (next !== currentRunOnInstance) {
            currentRunOnInstance = next;
            render();
          }
        },
        refetchInstances:
          args.refetchInstances ??
          // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
          (() => Promise.resolve({ data: { instances: [INSTANCE] } })),
        instanceList: args.instanceList ?? [INSTANCE],
        getSubmitPayload: args.getSubmitPayload,
        onSpawnAdmitted: args.onSpawnAdmitted,
        onSpawnFailed: args.onSpawnFailed,
      });
    } finally {
      reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H =
        previousDispatcher;
    }
  };

  return render();
}

describe('useRemoteSpawnDispatch spawn input chain', () => {
  beforeEach(() => {
    spawnMock.mockClear();
    useRemoteInstanceSpawnMock.mockClear();
    routerReplace.mockClear();
    toastErrorMock.mockClear();
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
      { operationKey: expect.any(String) },
    ]);
  });

  it('onStart without mode yields org-only input', async () => {
    const { onStart } = runHook({
      organizationId: 'org-xyz',
    });

    expect(await captureSpawnCall(onStart)).toEqual([
      'conn-abc',
      { orgId: 'org-xyz' },
      { operationKey: expect.any(String) },
    ]);
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
      { operationKey: expect.any(String) },
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
      { operationKey: expect.any(String) },
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
      { operationKey: expect.any(String) },
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
      { operationKey: expect.any(String) },
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

  it('ready path carries the chosen custom mode so the auto-send keeps it', async () => {
    const { onStart } = runHook({
      organizationId: 'org-xyz',
      mode: 'reviewer',
      getSubmitPayload: () => samplePayload,
    });

    await runStartAndWaitForReplace(onStart);

    const calledWith = routerReplace.mock.calls[0]?.[0] as string | undefined;
    expect(calledWith).toContain('autoSend=1');
    expect(calledWith).toContain('mode=reviewer');
  });

  it('ready path omits mode when the spawn had none', async () => {
    const { onStart } = runHook({
      organizationId: 'org-xyz',
      getSubmitPayload: () => samplePayload,
    });

    await runStartAndWaitForReplace(onStart);

    const calledWith = routerReplace.mock.calls[0]?.[0] as string | undefined;
    expect(calledWith).not.toContain('mode=');
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

  it('calls the admitted callback after admission allows the payload', async () => {
    const onSpawnAdmitted = vi.fn();
    const { onStart } = runHook({
      organizationId: 'org-xyz',
      getSubmitPayload: () => samplePayload,
      onSpawnAdmitted: () => {
        onSpawnAdmitted();
      },
    });

    await captureSpawnCall(onStart);
    expect(onSpawnAdmitted).toHaveBeenCalledTimes(1);
  });

  it('does not call the admitted callback when admission denies files', () => {
    const onSpawnAdmitted = vi.fn();
    const { onStart } = runHook({
      organizationId: 'org-xyz',
      getSubmitPayload: () => filesPayload,
      onSpawnAdmitted: () => {
        onSpawnAdmitted();
      },
    });

    onStart();
    expect(onSpawnAdmitted).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(REMOTE_SPAWN_FILES_NOT_SUPPORTED_TOAST);
  });

  it('does not call the admitted callback without a target instance', () => {
    const onSpawnAdmitted = vi.fn();
    const { onStart } = runHook({
      organizationId: 'org-xyz',
      runOnInstance: null,
      onSpawnAdmitted: () => {
        onSpawnAdmitted();
      },
    });

    onStart();
    expect(onSpawnAdmitted).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('useRemoteSpawnDispatch live-instance remap', () => {
  const LIVE_INSTANCE: InstancePickerInstance = {
    connectionId: 'conn-live',
    name: 'laptop',
    projectName: 'kilo',
  };

  beforeEach(() => {
    spawnMock.mockClear();
    useRemoteInstanceSpawnMock.mockClear();
    routerReplace.mockClear();
    toastErrorMock.mockClear();
    __resetSharePayloadStoreForTests();
  });

  it('spawns with the same connectionId when the refetched list still has it', async () => {
    const { onStart } = runHook({
      organizationId: 'org-xyz',
      // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
      refetchInstances: () => Promise.resolve({ data: { instances: [INSTANCE] } }),
    });

    expect(await captureSpawnCall(onStart)).toEqual([
      'conn-abc',
      { orgId: 'org-xyz' },
      { operationKey: expect.any(String) },
    ]);
  });

  it('remaps to the live connectionId when the id changed but name + project match', async () => {
    const setRunOnInstanceMock = vi.fn();
    const { onStart } = runHook({
      organizationId: 'org-xyz',
      setRunOnInstance: next => {
        setRunOnInstanceMock(next);
      },
      // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
      refetchInstances: () => Promise.resolve({ data: { instances: [LIVE_INSTANCE] } }),
    });

    expect(await captureSpawnCall(onStart)).toEqual([
      'conn-live',
      { orgId: 'org-xyz' },
      { operationKey: expect.any(String) },
    ]);
    expect(setRunOnInstanceMock).toHaveBeenCalledWith(LIVE_INSTANCE);
  });

  it('falls back to the last-known instanceList when the refetch throws', async () => {
    const { onStart } = runHook({
      organizationId: 'org-xyz',
      // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
      refetchInstances: () => Promise.reject(new Error('network down')),
      instanceList: [INSTANCE],
    });

    expect(await captureSpawnCall(onStart)).toEqual([
      'conn-abc',
      { orgId: 'org-xyz' },
      { operationKey: expect.any(String) },
    ]);
  });

  it('keeps the live selection when a remap is followed by a failing post-spawn refetch', async () => {
    const setRunOnInstanceMock = vi.fn();
    // First (pre-spawn) refetch resolves the live row so the id remaps; the
    // second (post-spawn) refetch fails.
    const refetchInstancesMock = vi
      .fn()
      .mockResolvedValueOnce({ data: { instances: [LIVE_INSTANCE] } })
      .mockRejectedValueOnce(new Error('network down'));
    spawnMock.mockResolvedValueOnce({
      status: 'retryable',
      reason: 'transport failure',
      cause: new Error('socket gone'),
    });

    const { onStart } = runHook({
      organizationId: 'org-xyz',
      setRunOnInstance: next => {
        setRunOnInstanceMock(next);
      },
      refetchInstances: refetchInstancesMock,
      instanceList: [INSTANCE],
    });

    onStart();
    await vi.waitFor(() => {
      expect(refetchInstancesMock).toHaveBeenCalledTimes(2);
    });
    // Flush the rejected-refetch continuation (outcome classification and the
    // reset guard) before asserting the selection did not move to null.
    await new Promise<void>(resolve => {
      setTimeout(resolve, 0);
    });

    // The remap applied the live row...
    expect(setRunOnInstanceMock).toHaveBeenCalledWith(LIVE_INSTANCE);
    // ...and the failing refetch must not reset the selection to Cloud Agent.
    expect(setRunOnInstanceMock).toHaveBeenCalledTimes(1);
    expect(setRunOnInstanceMock).not.toHaveBeenCalledWith(null);
  });

  it('toasts the retryable copy and calls onSpawnFailed when no live instance resolves', async () => {
    const onSpawnFailedMock = vi.fn();
    const setRunOnInstanceMock = vi.fn();
    const { onStart } = runHook({
      organizationId: 'org-xyz',
      setRunOnInstance: next => {
        setRunOnInstanceMock(next);
      },
      // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
      refetchInstances: () => Promise.resolve({ data: { instances: [] } }),
      onSpawnFailed: () => {
        onSpawnFailedMock();
      },
    });

    onStart();
    await vi.waitFor(() => {
      expect(onSpawnFailedMock).toHaveBeenCalledTimes(1);
    });
    expect(toastErrorMock).toHaveBeenCalledWith(remoteSpawnRetryableToast());
    expect(spawnMock).not.toHaveBeenCalled();
    expect(setRunOnInstanceMock).not.toHaveBeenCalled();
  });
});
