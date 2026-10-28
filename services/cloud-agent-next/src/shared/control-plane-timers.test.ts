import { describe, expect, it } from 'vitest';
import { DEADLINE_MS } from '../sandbox-control/deadlines.js';
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

describe('control-plane preparation attempt budget', () => {
  it('outlasts every step of one preparation attempt in sequence', () => {
    const { sandbox, wrapper } = CONTROL_PLANE_TIMERS;
    // Environment snapshot starts use the wider repository startup bound.
    const createMs = Math.max(sandbox.providerCreateMs, DEADLINE_MS.repositoryStartup);
    const steps =
      // A transient create failure creates again inside the same attempt.
      createMs +
      sandbox.providerCreateRetryMs +
      createMs +
      sandbox.wrapperFirstConnectMs +
      sandbox.wrapperHelloMs +
      wrapper.restoreMs +
      wrapper.cloneMs +
      // Kilo runtime start and the Kilo session each retry once inside the
      // attempt, so each can consume two of its own bounds.
      2 * wrapper.kiloRuntimeStartMs +
      2 * wrapper.kiloSessionMs;

    expect(sandbox.routePreparationMs).toBeGreaterThanOrEqual(steps);
  });

  it('keeps the attempt budget real when the development divisor shrinks step timers', () => {
    const scaled = resolveControlPlaneTimers({ CONTROL_PLANE_TIMER_DIVISOR: '10' });

    expect(scaled.sandbox.routePreparationMs).toBe(CONTROL_PLANE_TIMERS.sandbox.routePreparationMs);
    expect(scaled.sandbox.routePreparationMs).toBeGreaterThanOrEqual(
      scaled.wrapper.cloneMs + scaled.wrapper.restoreMs
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

  it('keeps the interactive window for desktop routes', () => {
    expect(sandboxIdlePolicyForOrigins(['desktop'])).toBe('interactive');
    expect(sandboxIdlePolicyForOrigins(['scheduled', 'desktop'])).toBe('interactive');
  });

  it('keeps the interactive window for Agent Manager routes', () => {
    expect(sandboxIdlePolicyForOrigins(['agent-manager'])).toBe('interactive');
    expect(sandboxIdlePolicyForOrigins(['cloud-agent-web', 'agent-manager'])).toBe('interactive');
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
