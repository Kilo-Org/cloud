import { expect, it, vi } from 'vitest';

// The recovery fixtures share the mounted provider environment (mocks, state
// hooks, transitions) with app-unlock-context.mounted.test.tsx, which sits at
// its max-lines budget.
import {
  action,
  expectState,
  finish,
  flush,
  mount,
  native,
  settleReadRetries,
  state,
  storage,
  SUCCESS,
  transition,
} from '@/lib/app-unlock-context.test-helpers';

it('re-arms an exhausted-budget preference read on foreground recovery', async () => {
  // The keychain rejects every read at mount: the retry budget exhausts, the
  // provider fails open, and the device lock is off — but only until the
  // keychain recovers. The recovery re-reads silently: the app never shows
  // the preference-loading surface, and the re-armed return stays unlocked.
  await mount('disabled', true);
  expectState(false, 'unlocked');
  expect(native.authenticateAsync).not.toHaveBeenCalled();
  // The mount's own read spent the full budget: four attempts.
  expect(storage.getItemAsync).toHaveBeenCalledTimes(4);

  // A return while the keychain is still down re-reads (the full budget,
  // four attempts) and stays unlocked with no loading surface and no prompt.
  vi.useFakeTimers();
  await transition('background');
  await transition('active');
  await settleReadRetries();
  vi.useRealTimers();
  expect(storage.getItemAsync).toHaveBeenCalledTimes(8);
  expectState(false, 'unlocked', false);
  expect(state().phase).toBe('idle');
  expect(native.authenticateAsync).not.toHaveBeenCalled();

  // The keychain recovers: the next return re-arms the preference without
  // gating the in-progress return.
  storage.getItemAsync.mockResolvedValue('enabled');
  await transition('background');
  await transition('active');
  expectState(true, 'unlocked');
  expect(native.authenticateAsync).not.toHaveBeenCalled();

  // From then on normal semantics hold: a long return locks and prompts.
  await transition('background');
  const auth = Promise.withResolvers<unknown>();
  native.authenticateAsync.mockReturnValueOnce(auth.promise);
  await transition('active', 300_000);
  expectState(true, 'locked', true);
  await finish(auth, SUCCESS);
  expectState(true, 'unlocked');
});

it('does not re-read a deterministic invalid value on foreground recovery', async () => {
  // An invalid stored value cannot heal across foregrounds: a re-read would
  // return the same bytes, so the fail-open stands without spending reads.
  await mount('invalid');
  expectState(false, 'unlocked');
  await transition('background');
  await transition('active', 300_000);
  expectState(false, 'unlocked');
  expect(storage.getItemAsync).toHaveBeenCalledTimes(1);
});

it('clears a setting outcome but keeps a locked-scene outcome', async () => {
  // A failed enable attempt publishes its outcome with the setting purpose;
  // the screen that started it retires both on blur. The scope guard leaves a
  // locked-scene outcome (purpose 'unlock') untouched.
  native.authenticateAsync.mockResolvedValueOnce({ success: false, error: 'not_available' });
  await mount('disabled');
  await action(true);
  expect(state().purpose).toBe('setting');
  expect(state().outcome).toEqual({ status: 'setup-required', reason: 'not-available' });
  await flush(() => {
    state().clearSettingOutcome();
  });
  expect(state().purpose).toBeNull();
  expect(state().outcome).toBeNull();

  // An unlock purpose is never cleared by the screen-scoped call: the failed
  // attempt behind the lock keeps its feedback for the Retry surface. A fresh
  // provider with the preference enabled mounts locked and prompts once; the
  // mock's failure lands on that cold-start attempt.
  native.authenticateAsync.mockResolvedValueOnce({ success: false, error: 'lockout' });
  await mount('enabled', false);
  expect(state().purpose).toBe('unlock');
  expect(state().outcome).toEqual({ status: 'lockout' });
  await flush(() => {
    state().clearSettingOutcome();
  });
  expect(state().purpose).toBe('unlock');
  expect(state().outcome).toEqual({ status: 'lockout' });
});
