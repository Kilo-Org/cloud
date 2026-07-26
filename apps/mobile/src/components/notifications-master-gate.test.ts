import { describe, expect, it } from 'vitest';

import { deriveMasterGateLeadingPresentation } from './notifications-master-gate';

describe('deriveMasterGateLeadingPresentation (unsettled gate must not assert off)', () => {
  it('is neutral while permission is loading even if notificationsEnabled is false', () => {
    expect(
      deriveMasterGateLeadingPresentation({
        permissionLoading: true,
        permissionError: false,
        gateSettled: false,
        notificationsEnabled: false,
      })
    ).toBe('neutral');
  });

  it('is neutral while token queries settle after permission loaded without error', () => {
    expect(
      deriveMasterGateLeadingPresentation({
        permissionLoading: false,
        permissionError: false,
        gateSettled: false,
        notificationsEnabled: false,
      })
    ).toBe('neutral');
  });

  it('is on when the gate is settled and notifications are fully enabled', () => {
    expect(
      deriveMasterGateLeadingPresentation({
        permissionLoading: false,
        permissionError: false,
        gateSettled: true,
        notificationsEnabled: true,
      })
    ).toBe('on');
  });

  it('is off when the gate is settled and notifications are disabled', () => {
    expect(
      deriveMasterGateLeadingPresentation({
        permissionLoading: false,
        permissionError: false,
        gateSettled: true,
        notificationsEnabled: false,
      })
    ).toBe('off');
  });

  it('keeps the off presentation on permission error (gate settled via denied short-circuit)', () => {
    expect(
      deriveMasterGateLeadingPresentation({
        permissionLoading: false,
        permissionError: true,
        gateSettled: true,
        notificationsEnabled: false,
      })
    ).toBe('off');
  });
});
