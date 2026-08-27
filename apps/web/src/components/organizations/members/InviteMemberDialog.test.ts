import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, test } from '@jest/globals';
import {
  hasInviteSeatCapacity,
  INVITE_SUCCESS_MESSAGE,
  organizationMemberInvitedCaptureProperties,
} from './InviteMemberDialog';

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

describe('organizationMemberInvitedCaptureProperties', () => {
  test('returns only the role', () => {
    expect(organizationMemberInvitedCaptureProperties('member')).toEqual({ role: 'member' });
    expect(Object.keys(organizationMemberInvitedCaptureProperties('admin'))).toEqual(['role']);
    expect(organizationMemberInvitedCaptureProperties('member')).not.toHaveProperty(
      'organizationId'
    );
    expect(organizationMemberInvitedCaptureProperties('member')).not.toHaveProperty('email');
  });

  test('the dialog source uses the helper and never the old capture argument list', () => {
    const source = readFileSync(path.resolve(__dirname, './InviteMemberDialog.tsx'), 'utf8');
    expect(source).toContain('organizationMemberInvitedCaptureProperties');
    expect(source).not.toContain('organizationId, email, role');
  });
});
