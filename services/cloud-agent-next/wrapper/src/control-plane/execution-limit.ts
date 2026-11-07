import type { ControlPlaneTimers } from '../../../src/shared/control-plane-timers.js';

export type NegotiatedControlPlaneTimers = {
  timers: ControlPlaneTimers;
  acknowledgeTurnCoverage(acknowledged: boolean): void;
};

/**
 * An older Worker still fails accepted messages on its own accepted-age backstop,
 * so only a welcome that acknowledges turn coverage may use the configured cap.
 */
export function createNegotiatedControlPlaneTimers(
  configured: ControlPlaneTimers
): NegotiatedControlPlaneTimers {
  const wrapper = {
    ...configured.wrapper,
    turnHardCapMs: configured.wrapper.legacyTurnHardCapMs,
  };
  return {
    timers: { ...configured, wrapper },
    acknowledgeTurnCoverage(acknowledged) {
      wrapper.turnHardCapMs = acknowledged
        ? configured.wrapper.turnHardCapMs
        : configured.wrapper.legacyTurnHardCapMs;
    },
  };
}
