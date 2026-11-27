import { afterEach, describe, expect, it, vi } from 'vitest';

import { skipProviderPush } from './push-gate';

// `undefined` leaves the switch out. A wrangler `vars` entry can carry a JSON
// boolean, which is not the string the switch names, so it is listed with the
// malformed values.
const OFF_SWITCHES: [string, unknown][] = [
  ['absent', undefined],
  ['empty', ''],
  ['false', 'false'],
  ['TRUE', 'TRUE'],
  ['padded', ' true'],
  ['1', '1'],
  ['a JSON boolean', true],
];

function gateEnv(workerEnv: string, pushSwitch: unknown): Parameters<typeof skipProviderPush>[0] {
  if (pushSwitch === undefined) return { WORKER_ENV: workerEnv };
  return { WORKER_ENV: workerEnv, NOTIFICATIONS_PUSH_ENABLED: pushSwitch as string };
}

describe('skipProviderPush', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(OFF_SWITCHES)('keeps staging push off when the switch is %s', (_label, pushSwitch) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(skipProviderPush(gateEnv('staging', pushSwitch), 'apns')).toBe(true);
    expect(log).toHaveBeenCalledWith('notifications_push_disabled', { surface: 'apns' });
  });

  it('opens staging push only for the exact string true', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(skipProviderPush(gateEnv('staging', 'true'), 'expo_push')).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it.each(['production', 'development'])('ignores the switch when WORKER_ENV is %s', workerEnv => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    for (const [, pushSwitch] of OFF_SWITCHES) {
      expect(skipProviderPush(gateEnv(workerEnv, pushSwitch), 'expo_receipts')).toBe(false);
    }
    expect(log).not.toHaveBeenCalled();
  });
});
