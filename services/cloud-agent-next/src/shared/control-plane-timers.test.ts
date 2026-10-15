import { describe, expect, it } from 'vitest';
import {
  CONTROL_PLANE_TIMERS,
  resolveControlPlaneTimers,
  sandboxIdlePolicyForOrigins,
} from './control-plane-timers.js';

describe('control-plane idle timers', () => {
  it('preserves interactive timers by default', () => {
    expect(resolveControlPlaneTimers({})).toBe(CONTROL_PLANE_TIMERS);
    expect(CONTROL_PLANE_TIMERS.sandbox.idleMs).toBe(600_000);
    expect(CONTROL_PLANE_TIMERS.sandbox.providerLeaseMs).toBe(660_000);
    expect(CONTROL_PLANE_TIMERS.sandbox.reconnectMs).toBe(90_000);
  });

  it('has a separate unattended idle window without shortening recovery or provider leases', () => {
    expect(CONTROL_PLANE_TIMERS.sandbox.unattendedIdleMs).toBe(60_000);
    expect(CONTROL_PLANE_TIMERS.sandbox.unattendedIdleMs).toBeLessThan(
      CONTROL_PLANE_TIMERS.sandbox.reconnectMs
    );
  });

  it('scales unattended idle time with the development timer divisor', () => {
    const timers = resolveControlPlaneTimers({ CONTROL_PLANE_TIMER_DIVISOR: '10' });
    expect(timers.sandbox.unattendedIdleMs).toBe(6_000);
    expect(timers.sandbox.idleMs).toBe(60_000);
    expect(timers.sandbox.providerLeaseMs).toBe(120_000);
    expect(timers.sandbox.reconnectMs).toBe(9_000);
  });

  it.each(['0', '1', '-1', 'invalid'])('preserves production timers for divisor %s', divisor => {
    expect(resolveControlPlaneTimers({ CONTROL_PLANE_TIMER_DIVISOR: divisor })).toEqual(
      CONTROL_PLANE_TIMERS
    );
  });
});

describe('sandbox idle policy for route origins', () => {
  it('keeps the interactive window for a sandbox without routes', () => {
    expect(sandboxIdlePolicyForOrigins([])).toBe('interactive');
  });

  it('keeps the interactive window while any route is a web session', () => {
    expect(sandboxIdlePolicyForOrigins(['cloud-agent-web'])).toBe('interactive');
    expect(sandboxIdlePolicyForOrigins(['code-review', 'cloud-agent-web', null])).toBe(
      'interactive'
    );
  });

  it.each([
    [['code-review']],
    [['slack', 'github']],
    [['cli']],
    [['some-future-origin']],
    [[null]],
    [[undefined]],
    [[42]],
  ])('uses the unattended window for origins %j', origins => {
    expect(sandboxIdlePolicyForOrigins(origins)).toBe('unattended');
  });
});
