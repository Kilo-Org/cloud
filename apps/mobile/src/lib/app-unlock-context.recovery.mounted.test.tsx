/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { expect, it, vi } from 'vitest';

// The recovery fixtures share the mounted provider environment (mocks, state
// hooks, transitions) with app-unlock-context.mounted.test.tsx, which sits at
// its max-lines budget.
import {
  expectState,
  finish,
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
