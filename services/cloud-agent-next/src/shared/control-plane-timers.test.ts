import { describe, expect, it } from 'vitest';
import { CONTROL_PLANE_TIMERS, resolveControlPlaneTimers } from './control-plane-timers.js';

describe('control-plane idle timers', () => {
  it('preserves interactive timers by default', () => {
    expect(resolveControlPlaneTimers({})).toBe(CONTROL_PLANE_TIMERS);
    expect(CONTROL_PLANE_TIMERS.sandbox.idleMs).toBe(600_000);
    expect(CONTROL_PLANE_TIMERS.sandbox.providerLeaseMs).toBe(660_000);
  });

  it('shortens only unattended idle time and its provider lease', () => {
    expect(resolveControlPlaneTimers({}, true)).toEqual({
      ...CONTROL_PLANE_TIMERS,
      sandbox: {
        ...CONTROL_PLANE_TIMERS.sandbox,
        idleMs: 60_000,
        providerLeaseMs: 120_000,
      },
    });
  });

  it('scales unattended idle time with the development timer divisor', () => {
    const timers = resolveControlPlaneTimers({ CONTROL_PLANE_TIMER_DIVISOR: '10' }, true);
    expect(timers.sandbox.idleMs).toBe(6_000);
    expect(timers.sandbox.providerLeaseMs).toBe(66_000);
  });

  it.each(['0', '-1', 'invalid'])('ignores invalid divisor %s for unattended timers', divisor => {
    expect(resolveControlPlaneTimers({ CONTROL_PLANE_TIMER_DIVISOR: divisor }, true)).toEqual(
      resolveControlPlaneTimers({}, true)
    );
  });
});
