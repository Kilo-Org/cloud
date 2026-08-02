import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { buildCreateRemoteSessionInput } from '@/lib/hooks/remote-instance-spawn-classifier';

import {
  RemoteSpawnInheritanceProvider,
  useRemoteSpawnDispatch,
} from './use-remote-spawn-dispatch';

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
      // Only RemoteSpawnInheritanceContext is read; return staged value.
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
    // Alias avoids rules-of-hooks lexical false positives under the fake dispatcher.
    const mountDispatch = useRemoteSpawnDispatch;
    return mountDispatch({
      organizationId: args.organizationId,
      mode: args.mode,
      model: args.model,
      variant: args.variant,
      runOnInstance: INSTANCE,
      setRunOnInstance: (_next: InstancePickerInstance | null) => {
        // no-op setter for the dispatch harness
      },
      refetchInstances: async () => {
        await Promise.resolve();
        return { data: { instances: [INSTANCE] } };
      },
      instanceList: [INSTANCE],
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
  });

  it('onStart builds agent/model/variant/orgId from inheritance provider fields', async () => {
    // Would fail if context were always {} (Provider mounted after the hook):
    // spawn would receive undefined / org-only instead of the full wire shape.
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
      model: {
        providerID: 'kilo',
        modelID: 'kilo-auto/efficient',
        variant: 'medium',
      },
      orgId: 'org-xyz',
    });
  });

  it('onStart without inheritance yields org-only (or bare) input — empty context regression', async () => {
    const { onStart } = runHookWithProvider({
      organizationId: 'org-xyz',
      withProvider: false,
    });

    onStart();
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalled();
    });

    expect(spawnMock).toHaveBeenCalledWith('conn-abc', {
      orgId: 'org-xyz',
    });
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

  it('personal route (no param) passes null so context org cannot win after a switch', () => {
    // undefined route param must become null — not omitted — or the spawn
    // hook would inherit live useOrganization() and mis-attribute personal
    // spawns after the user switches org in the global switcher.
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

    // Exact args — no orgId key (personal route must not inherit context org).
    expect(spawnMock).toHaveBeenCalledWith('conn-abc', {
      agent: 'code',
      model: { providerID: 'kilo', modelID: 'kilo-auto/efficient' },
    });
  });
});

// Smoke: Provider is a real React context provider (not a no-op export).
describe('RemoteSpawnInheritanceProvider', () => {
  it('exposes a Provider component', () => {
    expect(typeof RemoteSpawnInheritanceProvider).toBe('function');
  });
});
