/* eslint-disable max-lines -- spawn-input chain, ready-path navigation, and admission-gating suites share this file */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type InstancePickerInstance } from '@/lib/picker-bridge';
import {
  __resetSharePayloadStoreForTests,
  peekSharePayload,
  type SharePayload,
} from '@/lib/share-payload';
import { buildCreateRemoteSessionInput } from '@/lib/hooks/remote-instance-spawn-classifier';

import {
  RemoteSpawnInheritanceProvider,
  useRemoteSpawnDispatch,
} from './use-remote-spawn-dispatch';
import { REMOTE_SPAWN_FILES_NOT_SUPPORTED_TOAST } from '@/lib/remote-spawn-admission';

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

/** Stub payload that admission denies on an instance without attachments. */
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
  /** Invoked by `onStart` only once a spawn attempt is admitted. */
  onSpawnAdmitted?: () => void;
  /** Override the selected instance (defaults to `INSTANCE`). */
  runOnInstance?: InstancePickerInstance | null;
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
      runOnInstance: args.runOnInstance === undefined ? INSTANCE : args.runOnInstance,
      // eslint-disable-next-line no-empty-function -- no-op setter for harness
      setRunOnInstance: (_next: InstancePickerInstance | null) => {},
      // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
      refetchInstances: () => Promise.resolve({ data: { instances: [INSTANCE] } }),
      instanceList: [INSTANCE],
      getSubmitPayload: args.getSubmitPayload,
      onSpawnAdmitted: args.onSpawnAdmitted,
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
    toastErrorMock.mockClear();
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

    expect(spawnMock).toHaveBeenCalledWith('conn-abc', {
      agent: 'plan',
      model: { providerID: 'kilo', modelID: 'kilo-auto/efficient', variant: 'medium' },
      orgId: 'org-xyz',
    });
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

    expect(spawnMock).toHaveBeenCalledWith('conn-abc', { orgId: 'org-xyz' });
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
      })
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

    expect(spawnMock).toHaveBeenCalledWith('conn-abc', {
      agent: 'code',
      model: { providerID: 'kilo', modelID: 'kilo-auto/efficient' },
    });
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
    const { onStart } = runHookWithProvider({
      organizationId: 'org-xyz',
      withProvider: false,
      getSubmitPayload: () => null,
    });

    onStart();
    await vi.waitFor(() => {
      expect(routerReplace).toHaveBeenCalled();
    });

    const calledWith = routerReplace.mock.calls[0]?.[0] as string | undefined;
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

    const calledWith = routerReplace.mock.calls[0]?.[0] as string | undefined;
    expect(typeof calledWith).toBe('string');
    expect(calledWith).toContain('spawned=1');
    expect(calledWith).not.toContain('shareId=');
    expect(calledWith).not.toContain('autoSend=');
  });

  it('arms the spawn-admitted callback only after admission allows the payload', async () => {
    const onSpawnAdmitted = vi.fn();
    const { onStart } = runHookWithProvider({
      organizationId: 'org-xyz',
      withProvider: false,
      getSubmitPayload: () => samplePayload,
      onSpawnAdmitted: () => {
        onSpawnAdmitted();
      },
    });

    onStart();
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalled();
    });

    expect(onSpawnAdmitted).toHaveBeenCalledTimes(1);
  });

  it('never arms the callback nor spawns when admission denies files on an incapable instance', () => {
    const onSpawnAdmitted = vi.fn();
    const { onStart } = runHookWithProvider({
      organizationId: 'org-xyz',
      withProvider: false,
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

  it('never arms the callback when no instance is selected (defensive guard)', () => {
    const onSpawnAdmitted = vi.fn();
    const { onStart } = runHookWithProvider({
      organizationId: 'org-xyz',
      withProvider: false,
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

// Smoke: Provider is a real React context provider (not a no-op export).
describe('RemoteSpawnInheritanceProvider', () => {
  it('exposes a Provider component', () => {
    expect(typeof RemoteSpawnInheritanceProvider).toBe('function');
  });
});
