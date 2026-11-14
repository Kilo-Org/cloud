import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  app: {
    currentState: 'active',
    addEventListener: vi.fn<(event: string, listener: (value: string) => void) => void>(),
  },
  authenticate: vi.fn(),
}));
vi.mock('react-native', () => ({ AppState: state.app }));
vi.mock('expo-local-authentication', () => ({
  hasHardwareAsync: () => Promise.resolve(true),
  isEnrolledAsync: () => Promise.resolve(true),
  authenticateAsync: state.authenticate,
}));

// Fresh modules model the foreground-unlock singleton after a runtime reload.
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.app.currentState = 'active';
  state.authenticate.mockResolvedValue({ success: true });
});

function transition(value: string) {
  state.app.currentState = value;
  state.app.addEventListener.mock.calls[0]?.[1](value);
}

it('unlocks once for reconnects and other keys in the same foreground session', async () => {
  const { requireKeyAccess } = await import('./biometric');
  expect(await requireKeyAccess('first')).toBe(true);
  expect(await requireKeyAccess('reconnect')).toBe(true);
  expect(state.authenticate).toHaveBeenCalledTimes(1);
  transition('background');
  expect(await requireKeyAccess('background retry')).toBe(false);
  transition('active');
  expect(await requireKeyAccess('foreground reconnect')).toBe(true);
  expect(await requireKeyAccess('another reconnect')).toBe(true);
  expect(state.authenticate).toHaveBeenCalledTimes(2);
});

it('shares an unlock between concurrent key uses', async () => {
  const { requireKeyAccess } = await import('./biometric');
  expect(await Promise.all([requireKeyAccess('a'), requireKeyAccess('b')])).toEqual([true, true]);
  expect(state.authenticate).toHaveBeenCalledTimes(1);
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
