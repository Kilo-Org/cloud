/* eslint-disable max-lines -- spawn input-chain suite pins key reuse/rotation in one coherent run. */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type InstancePickerInstance } from '@/lib/picker-bridge';
import {
  __resetSharePayloadStoreForTests,
  peekSharePayload,
  type SharePayload,
} from '@/lib/share-payload';
import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { UserWebCommandError } from '@kilocode/cloud-agent-sdk/user-web-connection';
import {
  buildCreateRemoteSessionInput,
  type CreateSessionOutcome,
} from '@/lib/hooks/remote-instance-spawn-classifier';

import {
  RemoteSpawnInheritanceProvider,
  useRemoteSpawnDispatch,
} from './use-remote-spawn-dispatch';

const spawnMock = vi.hoisted(() =>
  vi.fn(
    async (
      _connectionId: string,
      _opts?: unknown,
      _options?: unknown
    ): Promise<CreateSessionOutcome> => {
      await Promise.resolve();
      return {
        status: 'ready',
        sessionID: 'ses_12345678901234567890123456' as KiloSessionId,
      };
    }
  )
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

vi.mock('expo-crypto', () => {
  let n = 0;
  return {
    randomUUID: () => {
      n += 1;
      return `uuid-${n}`;
    },
  };
});

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
  useContext: <T>(context: React.Context<T>) => T;
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
 * Minimal React hook runner. Mirrors the fake-dispatcher pattern in
 * `use-interaction-handlers.test.ts` so we can exercise
 * `useRemoteSpawnDispatch` without pulling react-native into vitest.
 */
function runHookWithProvider(args: {
  organizationId: string | undefined;
  mode?: string;
  model?: string;
  variant?: string;
  /** When false, omit the Provider — inheritance must not leak fields. */
  withProvider?: boolean;
  providerMode?: string;
  providerModel?: string;
  providerVariant?: string;
  getSubmitPayload?: () => SharePayload | null;
}) {
  const reactInternals = React as typeof React & ReactInternals;
  const hookState: unknown[] = [];
  const refs: { current: unknown }[] = [];
  let hookIndex = 0;
  let refIndex = 0;
  let contextValue: { mode?: string; model?: string; variant?: string } = {};

  const dispatcher: HookDispatcher = {
    useCallback: hookCallback => {
      hookIndex += 1;
      return hookCallback;
    },
    useContext: context => {
      hookIndex += 1;
      void context;
      return contextValue as never;
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
      if (hookState[stateIndex] === undefined) {
        hookState[stateIndex] = initialValue;
      }
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

  if (args.withProvider !== false) {
    contextValue = {
      mode: args.providerMode,
      model: args.providerModel,
      variant: args.providerVariant,
    };
  }

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
      model: args.model,
      variant: args.variant,
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

  it('onStart builds agent/model/variant/orgId from inheritance provider fields', async () => {
    const { onStart } = runHookWithProvider({
      organizationId: 'org-xyz',
      withProvider: true,
      providerMode: 'plan',
      providerModel: 'kilo-auto/efficient',
      providerVariant: 'medium',
    });

    onStart();
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalled();
    });

    expect(spawnMock).toHaveBeenCalledWith(
      'conn-abc',
      {
        agent: 'plan',
        model: { providerID: 'kilo', modelID: 'kilo-auto/efficient', variant: 'medium' },
        orgId: 'org-xyz',
      },
      { operationKey: expect.any(String) }
    );
  });

  it('onStart without inheritance yields org-only input — empty context regression', async () => {
    const { onStart } = runHookWithProvider({
      organizationId: 'org-xyz',
      withProvider: false,
    });

    onStart();
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalled();
    });

    expect(spawnMock).toHaveBeenCalledWith(
      'conn-abc',
      { orgId: 'org-xyz' },
      { operationKey: expect.any(String) }
    );
  });

  it('explicit mode/model/variant args win over empty context', async () => {
    const { onStart } = runHookWithProvider({
      organizationId: undefined,
      withProvider: false,
      mode: 'code',
      model: 'anthropic/claude-sonnet-4',
      variant: 'high',
    });

    onStart();
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalled();
    });

    expect(spawnMock).toHaveBeenCalledWith(
      'conn-abc',
      buildCreateRemoteSessionInput({
        mode: 'code',
        model: 'anthropic/claude-sonnet-4',
        variant: 'high',
      }),
      { operationKey: expect.any(String) }
    );
  });

  it('org route passes the route org into useRemoteInstanceSpawn (not inherit)', () => {
    runHookWithProvider({ organizationId: 'org-route-1', withProvider: false });
    expect(useRemoteInstanceSpawnMock).toHaveBeenCalledWith('org-route-1');
  });

  it('personal route (no param) passes null so context org cannot win', () => {
    runHookWithProvider({ organizationId: undefined, withProvider: false });
    expect(useRemoteInstanceSpawnMock).toHaveBeenCalledWith(null);
  });

  it('personal-route onStart omits orgId even when only mode/model are set', async () => {
    const { onStart } = runHookWithProvider({
      organizationId: undefined,
      withProvider: false,
      mode: 'code',
      model: 'kilo-auto/efficient',
    });

    onStart();
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalled();
    });

    expect(spawnMock).toHaveBeenCalledWith(
      'conn-abc',
      {
        agent: 'code',
        model: { providerID: 'kilo', modelID: 'kilo-auto/efficient' },
      },
      { operationKey: expect.any(String) }
    );
  });

  it('ready path stages the press-time payload and navigates with shareId + autoSend', async () => {
    const { onStart } = runHookWithProvider({
      organizationId: 'org-xyz',
      withProvider: false,
      getSubmitPayload: () => samplePayload,
    });

    onStart();
    await vi.waitFor(() => {
      expect(routerReplace).toHaveBeenCalled();
    });

    const calledWith = routerReplace.mock.calls[0]?.[0] as string;
    expect(typeof calledWith).toBe('string');
    expect(calledWith).toContain('spawned=1');
    expect(calledWith).toMatch(/shareId=uuid-\d+/);
    expect(calledWith).toContain('autoSend=1');
    expect(calledWith).toContain('ses_12345678901234567890123456');

    const shareIdMatch = /shareId=([^&]+)/.exec(calledWith);
    expect(shareIdMatch).not.toBeNull();
    const stored = peekSharePayload(decodeURIComponent(shareIdMatch?.[1] ?? ''));
    expect(stored).not.toBeNull();
    expect(stored?.text).toBe('hello');
  });

  it('ready path navigates without share params when press-time payload is null', async () => {
    const { onStart } = runHookWithProvider({
      organizationId: 'org-xyz',
      withProvider: false,
      getSubmitPayload: () => null,
    });

    onStart();
    await vi.waitFor(() => {
      expect(routerReplace).toHaveBeenCalled();
    });

    const calledWith = routerReplace.mock.calls[0]?.[0] as string;
    expect(typeof calledWith).toBe('string');
    expect(calledWith).toContain('spawned=1');
    expect(calledWith).toContain('ses_12345678901234567890123456');
    expect(calledWith).not.toContain('shareId=');
    expect(calledWith).not.toContain('autoSend=');
  });

  it('ready path navigates without share params when getSubmitPayload is omitted', async () => {
    const { onStart } = runHookWithProvider({
      organizationId: 'org-xyz',
      withProvider: false,
    });

    onStart();
    await vi.waitFor(() => {
      expect(routerReplace).toHaveBeenCalled();
    });

    const calledWith = routerReplace.mock.calls[0]?.[0] as string;
    expect(typeof calledWith).toBe('string');
    expect(calledWith).toContain('spawned=1');
    expect(calledWith).not.toContain('shareId=');
    expect(calledWith).not.toContain('autoSend=');
  });

  it('reuses the same operationKey across retryable spawn outcomes', async () => {
    const retryable = {
      status: 'retryable' as const,
      reason: 'Connection destroyed',
      cause: new Error('Connection destroyed'),
    };
    spawnMock.mockResolvedValueOnce(retryable).mockResolvedValueOnce(retryable);
    const { onStart } = runHookWithProvider({ organizationId: 'org-xyz', withProvider: false });

    onStart();
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
    onStart();
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    const first = spawnMock.mock.calls[0]?.[2] as { operationKey?: string } | undefined;
    const second = spawnMock.mock.calls[1]?.[2] as { operationKey?: string } | undefined;
    expect(first?.operationKey).toBeDefined();
    expect(second?.operationKey).toBe(first?.operationKey);
  });

  it('keeps the same operationKey for a COMMAND_ALREADY_PENDING in-flight dedupe', async () => {
    // The relay rejects a same-key duplicate while the command is in flight
    // with this structured error. The classifier maps it to `retryable`, so
    // the dispatch must KEEP the key: a rotation would mint a new mutation
    // identity and let the relay dispatch a second command instead of
    // replaying the durable terminal result under the same identity.
    const alreadyPending = {
      status: 'retryable' as const,
      reason: 'Command is already in flight',
      cause: new UserWebCommandError({
        code: 'COMMAND_ALREADY_PENDING',
        message: 'Command is already in flight',
      }),
    };
    spawnMock.mockResolvedValueOnce(alreadyPending).mockResolvedValueOnce(alreadyPending);
    const { onStart } = runHookWithProvider({ organizationId: 'org-xyz', withProvider: false });

    onStart();
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
    onStart();
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    const first = spawnMock.mock.calls[0]?.[2] as { operationKey?: string } | undefined;
    const second = spawnMock.mock.calls[1]?.[2] as { operationKey?: string } | undefined;
    expect(first?.operationKey).toBeDefined();
    expect(second?.operationKey).toBe(first?.operationKey);
  });

  it('rotates the operationKey after a ready outcome', async () => {
    const retryable = {
      status: 'retryable' as const,
      reason: 'Connection destroyed',
      cause: new Error('Connection destroyed'),
    };
    spawnMock
      .mockResolvedValueOnce(retryable)
      .mockResolvedValueOnce({
        status: 'ready',
        sessionID: 'ses_12345678901234567890123456' as KiloSessionId,
      })
      .mockResolvedValueOnce(retryable);
    const { onStart } = runHookWithProvider({ organizationId: 'org-xyz', withProvider: false });

    onStart();
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
    onStart();
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });
    onStart();
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(3);
    });

    const keys = spawnMock.mock.calls.map(
      call => (call[2] as { operationKey?: string } | undefined)?.operationKey
    );
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('rotates the operationKey after a nonRetryable outcome', async () => {
    const nonRetryable = {
      status: 'nonRetryable' as const,
      reason: 'CLI_UPGRADE_REQUIRED',
      cause: new Error('CLI_UPGRADE_REQUIRED'),
    };
    spawnMock.mockResolvedValueOnce(nonRetryable).mockResolvedValueOnce(nonRetryable);
    const { onStart } = runHookWithProvider({ organizationId: 'org-xyz', withProvider: false });

    onStart();
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
    onStart();
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    const first = spawnMock.mock.calls[0]?.[2] as { operationKey?: string } | undefined;
    const second = spawnMock.mock.calls[1]?.[2] as { operationKey?: string } | undefined;
    expect(second?.operationKey).not.toBe(first?.operationKey);
  });
});

// Smoke: Provider is a real React context provider (not a no-op export).
describe('RemoteSpawnInheritanceProvider', () => {
  it('exposes a Provider component', () => {
    expect(typeof RemoteSpawnInheritanceProvider).toBe('function');
  });
});
