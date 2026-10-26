/* eslint-disable max-lines -- spawn-input, navigation, and admission suites share the hook harness. */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type KiloSessionId, type ModelSelection } from '@kilocode/cloud-agent-sdk';
import { CommandDeliveredError } from '@kilocode/cloud-agent-sdk/user-web-connection';

import { i18n } from '@/i18n';
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
import { remoteSpawnFilesNotSupportedToast } from '@/lib/remote-spawn-admission';
import { remoteSpawnRetryableToast } from '@/lib/remote-submit-outcome';

import {
  REMOTE_SPAWN_START_DEADLINE_MS,
  useRemoteSpawnDispatch,
} from './use-remote-spawn-dispatch';

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

// `useStackSafeReplace` owns the push + post-transition stack cleanup that keeps
// Android Fabric alive (KILO-APP-25); its own mechanics are covered in
// src/lib/navigation/stack-safe-replace.mounted.test.tsx. Here it stands in for
// the navigation call so these assertions stay about the destination href.
vi.mock('@/lib/navigation/stack-safe-replace', () => ({
  useStackSafeReplace: () => ({ replace: routerReplace }),
}));

vi.mock('sonner-native', () => ({
  toast: { error: toastErrorMock },
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'share-id-fixed' }));

const expoFileSystemMock = vi.hoisted(() => {
  const files = new Map<string, string>();
  const File = vi.fn(function FileMock(_base: unknown, ...rest: unknown[]) {
    const uri =
      rest.length > 0 ? `${(_base as { uri: string }).uri}/${String(rest[0])}` : String(_base);
    return {
      uri,
      get exists() {
        return files.has(uri);
      },
      writeSync(content: string) {
        files.set(uri, content);
      },
      textSync() {
        return files.get(uri) ?? '';
      },
      delete() {
        files.delete(uri);
      },
    };
  });
  return {
    File,
    Paths: { cache: { uri: 'file:///cache' } },
  };
});

vi.mock('expo-file-system', () => ({
  File: expoFileSystemMock.File,
  Paths: expoFileSystemMock.Paths,
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
  kind: 'cli',
  startedAt: null,
  gitBranch: null,
};

/** Stub spawned session id for the watchdog's late-success case. */
const SESSION_ID = 'ses_12345678901234567890123456' as KiloSessionId;

/**
 * A spawn promise the test resolves by hand, for the watchdog's
 * still-in-flight-at-deadline case.
 */
function withDeferredOutcome(): {
  promise: Promise<CreateSessionOutcome>;
  resolve: (outcome: CreateSessionOutcome) => void;
} {
  const settle = { resolve: undefined as ((outcome: CreateSessionOutcome) => void) | undefined };
  const promise = new Promise<CreateSessionOutcome>(resolve => {
    settle.resolve = resolve;
  });
  return {
    promise,
    resolve: outcome => {
      const resolve = settle.resolve;
      if (resolve !== undefined) {
        resolve(outcome);
      }
    },
  };
}

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
/**
 * The render closure of the most recent `runHook` mount, so
 * `rerenderLastHook` can re-run it for fresh state.
 */
let lastRunResult: (() => ReturnType<typeof useRemoteSpawnDispatch>) | null = null;

function runHook(args: {
  organizationId: string | undefined;
  mode?: string;
  selection?: ModelSelection;
  getSubmitPayload?: () => SharePayload | null;
  onSpawnAdmitted?: () => void;
  onSpawnFailed?: () => void;
  cloneFromKiloSessionId?: string | null;
  cloneUpToMessageId?: string | null;
  forkPrefillText?: string | null;
  onCloneImportFailure?: (key: string) => void;
  onSpawnReady?: () => void;
  onSpawnSucceeded?: (sessionId: string) => void;
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
        cloneFromKiloSessionId: args.cloneFromKiloSessionId,
        cloneUpToMessageId: args.cloneUpToMessageId,
        forkPrefillText: args.forkPrefillText,
        onCloneImportFailure: args.onCloneImportFailure,
        onSpawnReady: args.onSpawnReady,
        onSpawnSucceeded: args.onSpawnSucceeded,
      });
    } finally {
      reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H =
        previousDispatcher;
    }
  };

  const result = render();
  lastRunResult = () => render();
  return result;
}

/**
 * Re-renders the most recent `runHook` mount and returns the fresh hook
 * result, so a test can read state that an async tail updated after its
 * first render.
 */
function rerenderLastHook() {
  if (lastRunResult === null) {
    throw new Error('rerenderLastHook called before any runHook');
  }
  return lastRunResult();
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

  it('does not call the admitted callback when the instance reported attachments false', () => {
    const onSpawnAdmitted = vi.fn();
    const { onStart } = runHook({
      organizationId: 'org-xyz',
      getSubmitPayload: () => filesPayload,
      runOnInstance: { ...INSTANCE, capabilities: { attachments: false } },
      onSpawnAdmitted: () => {
        onSpawnAdmitted();
      },
    });

    onStart();
    expect(onSpawnAdmitted).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(rerenderLastHook().remoteSpawnFailure).toEqual({
      retryable: false,
      message: remoteSpawnFilesNotSupportedToast(),
    });
  });

  it('admits files when the instance capability is unknown (optimistic default)', async () => {
    const onSpawnAdmitted = vi.fn();
    const { onStart } = runHook({
      organizationId: 'org-xyz',
      getSubmitPayload: () => filesPayload,
      onSpawnAdmitted: () => {
        onSpawnAdmitted();
      },
    });

    await captureSpawnCall(onStart);
    expect(onSpawnAdmitted).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).not.toHaveBeenCalled();
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

  it('a clone source with a capable instance reaches the spawn input', async () => {
    const { onStart } = runHook({
      organizationId: 'org-xyz',
      mode: 'code',
      selection: { model: { providerID: 'anthropic', modelID: 'claude-x' } },
      cloneFromKiloSessionId: 'ses_source',
      runOnInstance: { ...INSTANCE, capabilities: { sessionClone: true } },
    });

    expect(await captureSpawnCall(onStart)).toEqual([
      'conn-abc',
      {
        agent: 'code',
        model: { providerID: 'anthropic', modelID: 'claude-x' },
        orgId: 'org-xyz',
        cloneFromKiloSessionId: 'ses_source',
      },
      { operationKey: expect.any(String) },
    ]);
  });

  it('does not spawn when a clone source is set but the instance reported sessionClone false', () => {
    const onCloneImportFailure = vi.fn();
    const onSpawnAdmitted = vi.fn();
    const { onStart } = runHook({
      organizationId: 'org-xyz',
      cloneFromKiloSessionId: 'ses_source',
      runOnInstance: { ...INSTANCE, capabilities: { sessionClone: false } },
      onSpawnAdmitted: () => {
        onSpawnAdmitted();
      },
      onCloneImportFailure: key => {
        onCloneImportFailure(key);
      },
    });

    onStart();
    expect(onCloneImportFailure).toHaveBeenCalledWith('agentChat.newSession.cliCannotContinue');
    expect(onSpawnAdmitted).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not spawn when the refreshed instance reports attachments false', async () => {
    const onSpawnAdmitted = vi.fn();
    const onSpawnFailed = vi.fn();
    // The refreshed list holds the same host on a new connectionId, this time
    // reporting an explicit refusal of the file payload.
    const liveInstances = [
      { ...INSTANCE, connectionId: 'conn-live', capabilities: { attachments: false } },
    ];
    const { onStart } = runHook({
      organizationId: 'org-xyz',
      getSubmitPayload: () => filesPayload,
      // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
      refetchInstances: () => Promise.resolve({ data: { instances: liveInstances } }),
      onSpawnAdmitted: () => {
        onSpawnAdmitted();
      },
      onSpawnFailed: () => {
        onSpawnFailed();
      },
    });

    onStart();
    await vi.waitFor(() => {
      expect(rerenderLastHook().remoteSpawnFailure).toEqual({
        retryable: false,
        message: remoteSpawnFilesNotSupportedToast(),
      });
    });
    // The press-time row admitted the file payload because its capability was
    // unknown, so the refreshed row's explicit refusal has to stop the spawn
    // that was already admitted and re-arm the abandon guard.
    expect(onSpawnAdmitted).toHaveBeenCalledTimes(1);
    expect(onSpawnFailed).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not spawn when the refreshed instance reports sessionClone false', async () => {
    const onCloneImportFailure = vi.fn();
    const onSpawnFailed = vi.fn();
    // The refreshed list holds the same host on a new connectionId, this time
    // reporting an explicit refusal of the clone source.
    const liveInstances = [
      { ...INSTANCE, connectionId: 'conn-live', capabilities: { sessionClone: false } },
    ];
    const { onStart } = runHook({
      organizationId: 'org-xyz',
      cloneFromKiloSessionId: 'ses_source',
      // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
      refetchInstances: () => Promise.resolve({ data: { instances: liveInstances } }),
      onCloneImportFailure: key => {
        onCloneImportFailure(key);
      },
      onSpawnFailed: () => {
        onSpawnFailed();
      },
    });

    onStart();
    await vi.waitFor(() => {
      expect(onCloneImportFailure).toHaveBeenCalledWith('agentChat.newSession.cliCannotContinue');
    });
    expect(onSpawnFailed).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('spawns a clone when the instance capability is unknown (optimistic default)', async () => {
    const { onStart } = runHook({
      organizationId: 'org-xyz',
      mode: 'code',
      selection: { model: { providerID: 'anthropic', modelID: 'claude-x' } },
      cloneFromKiloSessionId: 'ses_source',
      runOnInstance: INSTANCE,
    });

    expect(await captureSpawnCall(onStart)).toEqual([
      'conn-abc',
      {
        agent: 'code',
        model: { providerID: 'anthropic', modelID: 'claude-x' },
        orgId: 'org-xyz',
        cloneFromKiloSessionId: 'ses_source',
      },
      { operationKey: expect.any(String) },
    ]);
  });

  it('a clone entry navigates with no shareId (payload is null)', async () => {
    const { onStart } = runHook({
      organizationId: 'org-xyz',
      cloneFromKiloSessionId: 'ses_source',
      runOnInstance: { ...INSTANCE, capabilities: { sessionClone: true } },
      getSubmitPayload: () => null,
    });

    await runStartAndWaitForReplace(onStart);

    const calledWith = routerReplace.mock.calls[0]?.[0] as string | undefined;
    expect(typeof calledWith).toBe('string');
    expect(calledWith).toContain('spawned=1&cloned=1');
    expect(calledWith).toContain('ses_12345678901234567890123456');
    expect(calledWith).not.toContain('shareId=');
    expect(calledWith).not.toContain('autoSend=');
  });

  it('a delivered clone/import CommandDeliveredError calls onCloneImportFailure with the mapped key', async () => {
    spawnMock.mockResolvedValueOnce({
      status: 'nonRetryable',
      reason: 'cloud session not found',
      cause: new CommandDeliveredError('cloud session not found'),
    });
    const onCloneImportFailure = vi.fn();
    const { onStart } = runHook({
      organizationId: 'org-xyz',
      cloneFromKiloSessionId: 'ses_source',
      runOnInstance: { ...INSTANCE, capabilities: { sessionClone: true } },
      onCloneImportFailure: key => {
        onCloneImportFailure(key);
      },
    });

    onStart();
    await vi.waitFor(() => {
      expect(onCloneImportFailure).toHaveBeenCalledWith('common.notFound');
    });
    // The inline reason, never the generic spawn toast.
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('a retryable clone error renders the inline retryable failure and keeps the form enabled for a retry', async () => {
    spawnMock.mockResolvedValueOnce({
      status: 'retryable',
      reason: 'transport failure',
      cause: new Error('socket gone'),
    });
    const onCloneImportFailure = vi.fn();
    const setRunOnInstance = vi.fn();
    const { onStart } = runHook({
      organizationId: 'org-xyz',
      cloneFromKiloSessionId: 'ses_source',
      runOnInstance: { ...INSTANCE, capabilities: { sessionClone: true } },
      onCloneImportFailure: key => {
        onCloneImportFailure(key);
      },
      setRunOnInstance: next => {
        setRunOnInstance(next);
      },
    });

    onStart();
    await vi.waitFor(() => {
      expect(rerenderLastHook().remoteSpawnFailure).toEqual({
        retryable: true,
        message: i18n.t('agentChat.session.cloneFailedRetry'),
      });
    });
    // The clone retry surfaces no inline reason and never resets the selection
    // to Cloud Agent, so Start stays enabled for the retry.
    expect(onCloneImportFailure).not.toHaveBeenCalled();
    expect(setRunOnInstance).not.toHaveBeenCalled();
  });

  describe('fork cut', () => {
    const CUT = 'msg_018f1e2d3c4bAbCdEfGhIjKlMn';
    const FORK_CAPABLE: InstancePickerInstance = {
      ...INSTANCE,
      capabilities: { sessionClone: true, sessionCloneAtMessage: true },
    };
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    const refetchCapable = () => Promise.resolve({ data: { instances: [FORK_CAPABLE] } });

    it('sends the cut on create_session when the CLI advertises sessionCloneAtMessage', async () => {
      const { onStart } = runHook({
        organizationId: 'org-xyz',
        cloneFromKiloSessionId: 'ses_source',
        cloneUpToMessageId: CUT,
        runOnInstance: FORK_CAPABLE,
        refetchInstances: refetchCapable,
      });

      expect(await captureSpawnCall(onStart)).toEqual([
        'conn-abc',
        { orgId: 'org-xyz', cloneFromKiloSessionId: 'ses_source', cloneUpToMessageId: CUT },
        { operationKey: expect.any(String) },
      ]);
    });

    it.each([
      { name: 'unknown', capabilities: undefined },
      { name: 'clone-only', capabilities: { sessionClone: true } },
      {
        name: 'explicitly refused',
        capabilities: { sessionClone: true, sessionCloneAtMessage: false },
      },
    ])('fails closed on a $name cut capability without spawning', ({ capabilities }) => {
      const onCloneImportFailure = vi.fn();
      const onSpawnAdmitted = vi.fn();
      const { onStart } = runHook({
        organizationId: 'org-xyz',
        cloneFromKiloSessionId: 'ses_source',
        cloneUpToMessageId: CUT,
        runOnInstance: { ...INSTANCE, ...(capabilities ? { capabilities } : {}) },
        onSpawnAdmitted: () => {
          onSpawnAdmitted();
        },
        onCloneImportFailure: key => {
          onCloneImportFailure(key);
        },
      });

      onStart();
      expect(onCloneImportFailure).toHaveBeenCalledWith('agentChat.newSession.cliCannotFork');
      expect(onSpawnAdmitted).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('fails closed when the refreshed instance no longer advertises the cut capability', async () => {
      const onCloneImportFailure = vi.fn();
      const onSpawnFailed = vi.fn();
      const { onStart } = runHook({
        organizationId: 'org-xyz',
        cloneFromKiloSessionId: 'ses_source',
        cloneUpToMessageId: CUT,
        runOnInstance: FORK_CAPABLE,
        onCloneImportFailure: key => {
          onCloneImportFailure(key);
        },
        onSpawnFailed: () => {
          onSpawnFailed();
        },
      });

      onStart();
      await vi.waitFor(() => {
        expect(onCloneImportFailure).toHaveBeenCalledWith('agentChat.newSession.cliCannotFork');
      });
      expect(onSpawnFailed).toHaveBeenCalledTimes(1);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('prefills the forked user message in the new composer without auto-send', async () => {
      const onSpawnSucceeded = vi.fn(() => {
        expect(routerReplace).not.toHaveBeenCalled();
      });
      const { onStart } = runHook({
        organizationId: 'org-xyz',
        mode: 'code',
        cloneFromKiloSessionId: 'ses_source',
        cloneUpToMessageId: CUT,
        forkPrefillText: 'Second question',
        runOnInstance: FORK_CAPABLE,
        refetchInstances: refetchCapable,
        getSubmitPayload: () => null,
        onSpawnSucceeded,
      });

      await runStartAndWaitForReplace(onStart);
      expect(onSpawnSucceeded).toHaveBeenCalledExactlyOnceWith('ses_12345678901234567890123456');

      const calledWith = routerReplace.mock.calls[0]?.[0] as string;
      expect(calledWith).toContain('spawned=1');
      expect(calledWith).toContain('shareId=share-id-fixed');
      expect(calledWith).not.toContain('autoSend=');
      expect(peekSharePayload('share-id-fixed')).toEqual({
        text: 'Second question',
        files: [],
        failedFiles: [],
      });
    });

    it('maps a delivered cut-not-found to the retryable not-saved-yet reason', async () => {
      spawnMock.mockResolvedValueOnce({
        status: 'nonRetryable',
        reason: 'cloud session cut not found',
        cause: new CommandDeliveredError('cloud session cut not found'),
      });
      const onCloneImportFailure = vi.fn();
      const { onStart } = runHook({
        organizationId: 'org-xyz',
        cloneFromKiloSessionId: 'ses_source',
        cloneUpToMessageId: CUT,
        runOnInstance: FORK_CAPABLE,
        refetchInstances: refetchCapable,
        onCloneImportFailure: key => {
          onCloneImportFailure(key);
        },
      });

      onStart();
      await vi.waitFor(() => {
        expect(onCloneImportFailure).toHaveBeenCalledWith('agentChat.newSession.forkCutNotSynced');
      });
      expect(toastErrorMock).not.toHaveBeenCalled();
    });
  });
});

describe('useRemoteSpawnDispatch live-instance remap', () => {
  const LIVE_INSTANCE: InstancePickerInstance = {
    connectionId: 'conn-live',
    name: 'laptop',
    projectName: 'kilo',
    kind: 'cli',
    startedAt: null,
    gitBranch: null,
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

  it('renders the retryable failure and calls onSpawnFailed when no live instance resolves', async () => {
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
    expect(rerenderLastHook().remoteSpawnFailure).toEqual({
      retryable: true,
      message: remoteSpawnRetryableToast(),
    });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(setRunOnInstanceMock).not.toHaveBeenCalled();
  });
});

describe('useRemoteSpawnDispatch stall watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockClear();
    useRemoteInstanceSpawnMock.mockClear();
    routerReplace.mockClear();
    toastErrorMock.mockClear();
    __resetSharePayloadStoreForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('releases the busy button and renders the retryable failure when the spawn outlives the budget', async () => {
    const deferred = withDeferredOutcome();
    // eslint-disable-next-line promise-function-async -- passthrough of an existing deferred promise, not a new async procedure
    spawnMock.mockImplementationOnce(() => deferred.promise);
    const { onStart } = runHook({ organizationId: 'org-xyz' });

    onStart();
    expect(rerenderLastHook().isSpawningRemote).toBe(true);
    await vi.advanceTimersByTimeAsync(REMOTE_SPAWN_START_DEADLINE_MS);
    const fresh = rerenderLastHook();
    expect(fresh.isSpawningRemote).toBe(false);
    expect(fresh.remoteSpawnFailure).toEqual({
      retryable: true,
      message: remoteSpawnRetryableToast(),
    });

    // A late success still navigates.
    deferred.resolve({ status: 'ready', sessionID: SESSION_ID });
    await vi.advanceTimersByTimeAsync(0);
    expect(routerReplace).toHaveBeenCalledTimes(1);
  });

  it('a settled failure releases the busy button before the watchdog fires', async () => {
    spawnMock.mockResolvedValueOnce({
      status: 'retryable',
      reason: 'transport failure',
      cause: new Error('socket gone'),
    });
    const { onStart } = runHook({ organizationId: 'org-xyz' });

    onStart();
    expect(rerenderLastHook().isSpawningRemote).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    const fresh = rerenderLastHook();
    expect(fresh.isSpawningRemote).toBe(false);
    expect(fresh.remoteSpawnFailure).toEqual({
      retryable: true,
      message: remoteSpawnRetryableToast(),
    });
    // The deadline never fires: no double report.
    await vi.advanceTimersByTimeAsync(REMOTE_SPAWN_START_DEADLINE_MS + 1);
    expect(rerenderLastHook().remoteSpawnFailure).toEqual({
      retryable: true,
      message: remoteSpawnRetryableToast(),
    });
  });

  it('a stalled attempt late tail cannot disarm a retry watchdog or busy window', async () => {
    const stalled = withDeferredOutcome();
    // eslint-disable-next-line promise-function-async -- passthrough of an existing deferred promise, not a new async procedure
    spawnMock.mockImplementationOnce(() => stalled.promise);
    const { onStart } = runHook({ organizationId: 'org-xyz' });

    onStart();
    await vi.advanceTimersByTimeAsync(REMOTE_SPAWN_START_DEADLINE_MS);
    expect(rerenderLastHook().isSpawningRemote).toBe(false);

    // Retry while the first attempt is still hanging: the new attempt arms
    // its own watchdog.
    const retried = withDeferredOutcome();
    // eslint-disable-next-line promise-function-async -- passthrough of an existing deferred promise, not a new async procedure
    spawnMock.mockImplementationOnce(() => retried.promise);
    onStart();
    expect(rerenderLastHook().isSpawningRemote).toBe(true);

    // The first attempt finally fails. Its tail must not reset the busy
    // window or publish its failure over the retry's in-flight state.
    stalled.resolve({
      status: 'retryable',
      reason: 'transport failure',
      cause: new Error('socket gone'),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(rerenderLastHook().isSpawningRemote).toBe(true);
    expect(rerenderLastHook().remoteSpawnFailure).toBeNull();

    // The retried attempt still holds its watchdog: past the budget it
    // releases the button (no indefinite busy).
    await vi.advanceTimersByTimeAsync(REMOTE_SPAWN_START_DEADLINE_MS);
    const fresh = rerenderLastHook();
    expect(fresh.isSpawningRemote).toBe(false);
    expect(fresh.remoteSpawnFailure).toEqual({
      retryable: true,
      message: remoteSpawnRetryableToast(),
    });
  });
});
