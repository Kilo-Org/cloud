import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  app: {
    currentState: 'active',
    addEventListener:
      vi.fn<(event: string, listener: (value: string) => void) => { remove: () => void }>(),
  },
  authenticate: vi.fn(),
}));
vi.mock('react-native', () => ({ AppState: state.app }));
vi.mock('expo-local-authentication', () => ({
  hasHardwareAsync: () => Promise.resolve(true),
  isEnrolledAsync: () => Promise.resolve(true),
  authenticateAsync: state.authenticate,
}));

// Reload the foreground-unlock singleton for each simulated app lifetime.
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.app.addEventListener.mockImplementation(() => ({ remove: vi.fn() }));
  state.app.currentState = 'active';
  state.authenticate.mockResolvedValue({ success: true });
});

function transition(value: string) {
  state.app.currentState = value;
  for (const [, listener] of [...state.app.addEventListener.mock.calls]) {
    listener(value);
  }
}

it('unlocks once for reconnects and other keys in the same foreground session', async () => {
  const { requireKeyAccess } = await import('./biometric');
  expect(await requireKeyAccess('first')).toBe(true);
  expect(await requireKeyAccess('reconnect')).toBe(true);
  expect(state.authenticate).toHaveBeenCalledTimes(1);
  transition('background');
  const retry = requireKeyAccess('background retry');
  await Promise.resolve();
  expect(state.authenticate).toHaveBeenCalledTimes(1);
  transition('active');
  expect(await requireKeyAccess('foreground reconnect')).toBe(true);
  expect(await retry).toBe(true);
  expect(await requireKeyAccess('another reconnect')).toBe(true);
  expect(state.authenticate).toHaveBeenCalledTimes(2);
});

it('shares an unlock between concurrent key uses', async () => {
  const { requireKeyAccess } = await import('./biometric');
  expect(await Promise.all([requireKeyAccess('a'), requireKeyAccess('b')])).toEqual([true, true]);
  expect(state.authenticate).toHaveBeenCalledTimes(1);
});

it('waits through background and inactive states and shares the foreground unlock', async () => {
  state.app.currentState = 'background';
  const { requireKeyAccess } = await import('./biometric');
  const first = requireKeyAccess('first');
  const second = requireKeyAccess('second');
  await Promise.resolve();
  expect(state.authenticate).not.toHaveBeenCalled();
  transition('inactive');
  await Promise.resolve();
  expect(state.authenticate).not.toHaveBeenCalled();
  transition('active');
  expect(await Promise.all([first, second])).toEqual([true, true]);
  expect(state.authenticate).toHaveBeenCalledOnce();
  expect(state.app.addEventListener.mock.results.slice(1)).toHaveLength(2);
  for (const result of state.app.addEventListener.mock.results.slice(1)) {
    expect(result.value.remove).toHaveBeenCalledOnce();
  }
});

it('does not carry an authentication result across backgrounding', async () => {
  const authentication = Promise.withResolvers<{ success: boolean }>();
  state.authenticate.mockReturnValue(authentication.promise);
  const { requireKeyAccess } = await import('./biometric');
  const pending = requireKeyAccess('first');
  await vi.waitFor(() => {
    expect(state.authenticate).toHaveBeenCalledTimes(1);
  });
  transition('background');
  transition('active');
  authentication.resolve({ success: true });
  expect(await pending).toBe(false);
  state.authenticate.mockResolvedValue({ success: true });
  expect(await requireKeyAccess('new foreground')).toBe(true);
  expect(state.authenticate).toHaveBeenCalledTimes(2);
});
