import { describe, expect, it } from 'bun:test';
import {
  CONTROL_PLANE_TIMERS,
  resolveControlPlaneTimers,
} from '../../../src/shared/control-plane-timers.js';
import { createNegotiatedControlPlaneTimers } from './execution-limit.js';

describe('negotiated execution timers', () => {
  it('starts at the legacy cap and upgrades only when acknowledged', () => {
    const negotiated = createNegotiatedControlPlaneTimers(CONTROL_PLANE_TIMERS);
    expect(negotiated.timers.wrapper.turnHardCapMs).toBe(7_200_000);

    negotiated.acknowledgeTurnCoverage(true);
    expect(negotiated.timers.wrapper.turnHardCapMs).toBe(43_200_000);
  });

  it('downgrades without mutating the configured timers', () => {
    const negotiated = createNegotiatedControlPlaneTimers(CONTROL_PLANE_TIMERS);
    negotiated.acknowledgeTurnCoverage(true);
    negotiated.acknowledgeTurnCoverage(false);

    expect(negotiated.timers.wrapper.turnHardCapMs).toBe(7_200_000);
    expect(CONTROL_PLANE_TIMERS.wrapper.turnHardCapMs).toBe(43_200_000);
    expect(CONTROL_PLANE_TIMERS.wrapper.legacyTurnHardCapMs).toBe(7_200_000);
  });

  it('scales the legacy cap with the configured timers', () => {
    const negotiated = createNegotiatedControlPlaneTimers(
      resolveControlPlaneTimers({ CONTROL_PLANE_TIMER_DIVISOR: '100' })
    );
    expect(negotiated.timers.wrapper.turnHardCapMs).toBe(72_000);

    negotiated.acknowledgeTurnCoverage(true);
    expect(negotiated.timers.wrapper.turnHardCapMs).toBe(432_000);
  });
});
