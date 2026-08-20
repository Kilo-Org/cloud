import { describe, expect, test } from '@jest/globals';
import { hasInviteSeatCapacity, INVITE_SUCCESS_MESSAGE } from './InviteMemberDialog';

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

describe('INVITE_SUCCESS_MESSAGE', () => {
  test('says the invite was created, not sent', () => {
    expect(INVITE_SUCCESS_MESSAGE).toBe('Invite created');
    expect(INVITE_SUCCESS_MESSAGE.toLowerCase()).not.toContain('sent');
  });
});
