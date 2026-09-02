import { describe, expect, it, vi } from 'vitest';
import {
  action,
  appState,
  expectState,
  finish,
  IOS_SUCCESSES,
  mount,
  native,
  state,
  storage,
  SUCCESS,
  transition,
  type Unlock,
} from '@/lib/app-unlock-context.test-helpers';

describe.each(['active', 'inactive', 'background'])('cold start in %s', initial => {
  it.each([null, 'disabled', 'enabled', 'invalid', new Error('read rejected')])(
    'restores %s safely',
    async raw => {
      appState.currentState = initial;
      const read = Promise.withResolvers<string | null>();
      const auth = Promise.withResolvers<unknown>();
      storage.getItemAsync.mockReturnValueOnce(read.promise);
      native.authenticateAsync.mockReturnValueOnce(auth.promise);
      await mount(raw instanceof Error ? 'disabled' : raw);
      expectState(false, 'preference-loading', true);
      await action();
      await action(true);
      await finish(read, raw);
      if (raw === 'invalid' || raw instanceof Error) {
        expectState(false, 'preference-error');
        await action(true);
        expectState(false, 'preference-error');
        storage.getItemAsync.mockResolvedValue('disabled');
        await action();
      } else if (raw === 'enabled') {
        expectState(true, 'locked', initial === 'active');
        await transition('active', 300_000);
        await action();
        await action(false);
        await finish(auth, SUCCESS);
      }
      expectState(raw === 'enabled', 'unlocked');
      expect(storage.getItemAsync).toHaveBeenCalledTimes(
        raw === 'invalid' || raw instanceof Error ? 2 : 1
      );
      expect(native.authenticateAsync).toHaveBeenCalledTimes(raw === 'enabled' ? 1 : 0);
    }
  );
});

it.each(IOS_SUCCESSES)('unlocks cold start with iOS success %j', async result => {
  const auth = Promise.withResolvers<unknown>();
  native.authenticateAsync.mockReturnValueOnce(auth.promise);
  await mount('enabled');
  expectState(true, 'locked', true);
  await finish(auth, result);
  expectState(true, 'unlocked');
  expect(state().outcome).toEqual({ status: 'success' });
});

type Outcome = NonNullable<Unlock['outcome']>;
const failures: Record<string, Outcome> = {
  user_cancel: { status: 'cancelled' },
  app_cancel: { status: 'cancelled' },
  system_cancel: { status: 'cancelled' },
  user_fallback: { status: 'cancelled' },
  authentication_failed: { status: 'failed' },
  no_space: { status: 'failed' },
  timeout: { status: 'failed' },
  unable_to_process: { status: 'failed' },
  unknown: { status: 'failed' },
  invalid_context: { status: 'failed' },
  missing_usage_description: { status: 'failed' },
  lockout: { status: 'lockout' },
  not_enrolled: { status: 'setup-required', reason: 'not-enrolled' },
  not_available: { status: 'setup-required', reason: 'not-available' },
  passcode_not_set: { status: 'setup-required', reason: 'passcode-not-set' },
};
const failureCases: [unknown, Outcome][] = [
  ...Object.entries(failures).map<[unknown, Outcome]>(([error, outcome]) => [
    { success: false, error },
    outcome,
  ]),
  ...[
    null,
    {},
    { success: 'true' },
    { success: true, error: 'unknown' },
    { success: true, error: 'authentication_failed', warning: null },
    { success: true, error: 'user_cancel', warning: null },
    { success: false, error: null, warning: null },
    { success: true, error: null, warning: 42 },
    new Error('native rejected'),
  ].map<[unknown, Outcome]>(result => [result, { status: 'failed' }]),
];
describe.each(['shell', 'enable', 'disable'])('%s failures', purpose => {
  it.each(failureCases)('preserves state after %j', async (result, outcome) => {
    if (purpose === 'disable') {
      native.authenticateAsync.mockResolvedValueOnce(SUCCESS);
    }
    if (result instanceof Error) {
      native.authenticateAsync.mockRejectedValueOnce(result);
    } else {
      native.authenticateAsync.mockResolvedValueOnce(result);
    }
    await mount(purpose === 'enable' ? 'disabled' : 'enabled');
    if (purpose !== 'shell') {
      await action(purpose === 'enable');
    }
    expectState(purpose !== 'enable', purpose === 'shell' ? 'locked' : 'unlocked');
    expect(state().outcome).toEqual(outcome);
    expect(storage.value).toBe(purpose === 'enable' ? 'disabled' : 'enabled');
    await action(purpose === 'shell' ? undefined : purpose === 'enable');
    expectState(purpose !== 'disable', 'unlocked');
  });
});
describe.each([false, true])('capabilities with saved enabled=%s', enabled => {
  it.each([
    [[false, false, 0], 'missing-hardware'],
    [[true, false, 0], 'not-enrolled'],
    [[true, true, 0], 'not-available'],
    [[false, false, 1], null],
    [[true, false, 1], null],
    [[true, true, 2], null],
    [[true, true, 3], null],
  ] as const)('checks %j with reason %s', async ([hardware, enrolled, level], reason) => {
    native.hasHardwareAsync.mockResolvedValue(hardware);
    native.isEnrolledAsync.mockResolvedValue(enrolled);
    native.getEnrolledLevelAsync.mockResolvedValue(level);
    await mount(enabled ? 'enabled' : 'disabled');
    if (!enabled) {
      await action(true);
    }
    expectState(enabled || !reason, enabled && reason ? 'locked' : 'unlocked');
    expect(state().outcome).toEqual(
      reason ? { status: 'setup-required', reason } : { status: 'success' }
    );
    if (reason) {
      expect(storage.value).toBe(enabled ? 'enabled' : 'disabled');
      expect(native.authenticateAsync).not.toHaveBeenCalled();
      native.getEnrolledLevelAsync.mockResolvedValue(1);
      await action(enabled ? undefined : true);
      expectState(true, 'unlocked');
    }
    expect(native.authenticateAsync).toHaveBeenCalledWith({
      promptMessage: 'Unlock Kilo',
      disableDeviceFallback: false,
    });
  });
});
it.each(['hasHardwareAsync', 'isEnrolledAsync', 'getEnrolledLevelAsync'] as const)(
  'catches %s rejection',
  async method => {
    native[method].mockRejectedValue(new Error('native unavailable'));
    await mount();
    await action(true);
    expectState(false, 'unlocked');
    expect(state().outcome).toEqual({ status: 'failed' });
  }
);
it.each([
  ['enabled', 299_999, false],
  ['enabled', 300_000, true],
  ['enabled', 300_001, true],
  ['disabled', 300_000, false],
  [null, 300_000, false],
] as const)('background boundary: %s, %s ms', async (raw, elapsed, locks) => {
  await mount(raw);
  native.authenticateAsync.mockResolvedValueOnce({ success: false, error: 'user_cancel' });
  await transition('background');
  await transition('background', 100_000);
  await transition('inactive', elapsed - 100_000);
  await transition('active');
  expectState(raw === 'enabled', locks ? 'locked' : 'unlocked');
  expect(native.authenticateAsync).toHaveBeenCalledTimes(Number(raw === 'enabled') + Number(locks));
  await transition('inactive');
  await transition('active', 900_000);
  expectState(raw === 'enabled', locks ? 'locked' : 'unlocked');
  if (raw !== 'enabled') {
    native.authenticateAsync.mockReset().mockResolvedValue(SUCCESS);
    await action(true);
    await transition('active');
    expectState(true, 'unlocked');
  }
});

describe.each(['shell', 'disable'])('overlapping %s authentication', purpose => {
  describe.each([false, true])('native result first=%s', nativeFirst => {
    it.each([
      SUCCESS,
      { success: false, error: 'user_cancel' },
      { success: false, error: 'authentication_failed' },
    ])('handles %j without another prompt', async result => {
      const auth = Promise.withResolvers<unknown>();
      if (purpose === 'disable') {
        native.authenticateAsync.mockResolvedValueOnce(SUCCESS);
      }
      native.authenticateAsync.mockReturnValueOnce(auth.promise);
      storage.setItemAsync.mockRejectedValueOnce(new Error('write rejected'));
      await mount('enabled');
      if (purpose === 'disable') {
        await action(false);
      }
      await transition('background');
      await transition('inactive', 300_000);
      if (!nativeFirst) {
        await transition('active');
        expectState(true, 'locked', true);
      }
      await finish(auth, result);
      await transition('active');
      expectState(true, result.success ? 'unlocked' : 'locked');
      expect(native.authenticateAsync).toHaveBeenCalledTimes(purpose === 'disable' ? 2 : 1);
      native.authenticateAsync.mockReturnValueOnce(Promise.withResolvers().promise);
      await transition('background');
      await transition('active', 300_000);
      expectState(true, 'locked', true);
    });
  });
});
describe.each([false, true])('background during persistence=%s', background => {
  describe.each([false, true])('setEnabled(%s)', next => {
    it.each(
      [false, true].flatMap(rejected =>
        [SUCCESS, ...IOS_SUCCESSES].map(result => [rejected, result] as const)
      )
    )('waits for storage; rejected=%s, native=%j', async (rejected, result) => {
      await mount(next ? 'disabled' : 'enabled');
      const auth = Promise.withResolvers<unknown>();
      const save = Promise.withResolvers<undefined>();
      native.authenticateAsync.mockReturnValueOnce(auth.promise);
      storage.setItemAsync.mockImplementationOnce(async (_key, value) => {
        await save.promise;
        storage.value = value;
      });
      await action(next);
      expectState(!next, 'unlocked', true);
      expect(state().phase).toBe('authenticating');
      await action(next);
      await action();
      if (background) {
        await transition('background');
        await transition('inactive', 300_000);
      }
      await finish(auth, result);
      await transition('active');
      expectState(!next, 'unlocked', true);
      expect(state().phase).toBe('saving');
      expect(storage.value).toBe(next ? 'disabled' : 'enabled');
      if (background) {
        await transition('background');
        await transition('active', 300_000);
        expectState(!next, next ? 'unlocked' : 'locked', true);
      }
      await action(!next);
      await action();
      await finish(save, rejected ? new Error('write rejected') : undefined);
      const saved = rejected ? !next : next;
      const locked = background && !next && rejected;
      expectState(saved, locked ? 'locked' : 'unlocked');
      expect(state().outcome?.status).toBe(rejected ? 'save-failed' : 'success');
      expect(storage.value).toBe(saved ? 'enabled' : 'disabled');
      expect(native.authenticateAsync).toHaveBeenCalledTimes(next ? 1 : 2);
      expect(storage.setItemAsync).toHaveBeenCalledTimes(1);
      if (locked) {
        await action();
        expectState(true, 'unlocked');
      }
    });
  });
});
it('catches an absent native module', async () => {
  vi.doMock('expo-local-authentication', () => {
    throw new Error('native module missing');
  });
  try {
    await mount('enabled');
    expectState(true, 'locked');
    expect(state().outcome).toEqual({ status: 'failed' });
  } finally {
    vi.doMock('expo-local-authentication', () => native);
  }
});
