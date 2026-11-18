import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getItemAsync, setItemAsync, deleteItemAsync } = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock('expo-secure-store', () => ({ getItemAsync, setItemAsync, deleteItemAsync }));

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/react-native', () => ({ captureException }));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: toastError } }));

// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => {
    setImmediate(resolve);
  });
}

/** Holds a SecureStore read open until the test body releases it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let storedResolve: (() => void) | undefined = undefined;
  const promise = new Promise<void>(resolve => {
    storedResolve = resolve;
  });
  return {
    promise,
    resolve: () => {
      storedResolve?.();
    },
  };
}

describe('parseCollapsedConnectCtas', () => {
  it('defaults to nothing collapsed for a missing value (fresh install and unreadable read)', async () => {
    const { parseCollapsedConnectCtas } = await import('./use-collapsed-connect-ctas-preference');
    expect(parseCollapsedConnectCtas(null)).toEqual([]);
  });

  it('reads a stored platform list', async () => {
    const { parseCollapsedConnectCtas } = await import('./use-collapsed-connect-ctas-preference');
    expect(parseCollapsedConnectCtas('["github"]')).toEqual(['github']);
  });

  it('reads an empty stored list as nothing collapsed', async () => {
    const { parseCollapsedConnectCtas } = await import('./use-collapsed-connect-ctas-preference');
    expect(parseCollapsedConnectCtas('[]')).toEqual([]);
  });

  it('drops a malformed stored value', async () => {
    const { parseCollapsedConnectCtas } = await import('./use-collapsed-connect-ctas-preference');
    expect(parseCollapsedConnectCtas('not json')).toEqual([]);
  });

  it('drops a stored value that is not an array', async () => {
    const { parseCollapsedConnectCtas } = await import('./use-collapsed-connect-ctas-preference');
    expect(parseCollapsedConnectCtas('{"github":true}')).toEqual([]);
  });

  it('drops unknown platforms and de-duplicates the rest, keeping input order', async () => {
    const { parseCollapsedConnectCtas } = await import('./use-collapsed-connect-ctas-preference');
    expect(parseCollapsedConnectCtas('["gitlab","gitlab","sourcehut"]')).toEqual(['gitlab']);
  });
});

describe('collapsed-connect-ctas store', () => {
  beforeEach(() => {
    vi.resetModules();
    getItemAsync.mockReset();
    setItemAsync.mockReset();
    deleteItemAsync.mockReset();
    captureException.mockReset();
    toastError.mockReset();
  });

  it('persists each collapse and expand as the exact serialized list', async () => {
    getItemAsync.mockResolvedValue(null);
    const { setConnectCtaCollapsed } = await import('./use-collapsed-connect-ctas-preference');

    setConnectCtaCollapsed('github', true);
    await vi.waitFor(() => {
      expect(setItemAsync).toHaveBeenLastCalledWith('collapsed-connect-ctas', '["github"]');
    });

    setConnectCtaCollapsed('gitlab', true);
    await vi.waitFor(() => {
      expect(setItemAsync).toHaveBeenLastCalledWith(
        'collapsed-connect-ctas',
        '["github","gitlab"]'
      );
    });

    setConnectCtaCollapsed('github', false);
    await vi.waitFor(() => {
      expect(setItemAsync).toHaveBeenLastCalledWith('collapsed-connect-ctas', '["gitlab"]');
    });
  });

  it('merges a pending write with the persisted list the read returns', async () => {
    const readGate = deferred();
    getItemAsync.mockImplementation(async () => {
      await readGate.promise;
      return '["github"]';
    });
    // Importing the shipped module starts its disk read (store.preload()).
    const { setConnectCtaCollapsed } = await import('./use-collapsed-connect-ctas-preference');

    // The write races the initial disk read: both platforms must survive.
    setConnectCtaCollapsed('gitlab', true);
    readGate.resolve();

    await vi.waitFor(() => {
      expect(setItemAsync).toHaveBeenCalledWith('collapsed-connect-ctas', '["github","gitlab"]');
    });

    // The merged list holds gitlab, so this expand derives its result from the
    // persisted membership and writes it back. The empty default would have
    // skipped the write as a no-change.
    setConnectCtaCollapsed('gitlab', false);
    await vi.waitFor(() => {
      expect(setItemAsync).toHaveBeenLastCalledWith('collapsed-connect-ctas', '["github"]');
    });
  });

  it('keeps the last stored list and toasts Could not save setting when the write fails', async () => {
    getItemAsync.mockResolvedValue(null);
    setItemAsync.mockRejectedValue(new Error('disk full'));
    const { setConnectCtaCollapsed } = await import('./use-collapsed-connect-ctas-preference');

    setConnectCtaCollapsed('github', true);

    await vi.waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('Could not save setting');
    });
    expect(setItemAsync).toHaveBeenLastCalledWith('collapsed-connect-ctas', '["github"]');

    // The failed choice was dropped, so the platform is not collapsed: the next
    // request is the same membership the stored list already has and is skipped
    // instead of queueing a second write.
    setItemAsync.mockClear();
    setConnectCtaCollapsed('github', false);
    await flushMicrotasks();
    expect(setItemAsync).not.toHaveBeenCalled();
  });

  it('clearCollapsedConnectCtasPreference deletes the key', async () => {
    getItemAsync.mockResolvedValue(null);
    const { clearCollapsedConnectCtasPreference } =
      await import('./use-collapsed-connect-ctas-preference');

    clearCollapsedConnectCtasPreference();
    await flushMicrotasks();

    expect(deleteItemAsync).toHaveBeenCalledWith('collapsed-connect-ctas');
  });
});
