import { describe, expect, test } from '@jest/globals';
import { hasInviteSeatCapacity } from './InviteMemberDialog';

describe('hasInviteSeatCapacity', () => {
  test('allows Teams invitations when seat requirements are disabled', () => {
    expect(
      hasInviteSeatCapacity({
        plan: 'teams',
        requireSeats: false,
        usedSeats: 1,
        totalSeats: 0,
      })
    ).toBe(true);
  });

  test('blocks Teams invitations when required seats are full', () => {
    expect(
      hasInviteSeatCapacity({
        plan: 'teams',
        requireSeats: true,
        usedSeats: 1,
        totalSeats: 1,
      })
    ).toBe(false);
  });
});
