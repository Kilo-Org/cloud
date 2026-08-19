import { describe, expect, test } from '@jest/globals';
import { invitedEmailStatusLabel } from './invited-email-status';

describe('invitedEmailStatusLabel', () => {
  test('maps pending and sending to Pending', () => {
    expect(invitedEmailStatusLabel('pending')).toBe('Pending');
    expect(invitedEmailStatusLabel('sending')).toBe('Pending');
  });

  test('maps failed to Email failed', () => {
    expect(invitedEmailStatusLabel('failed')).toBe('Email failed');
  });

  test('shows no badge for delivered', () => {
    expect(invitedEmailStatusLabel('delivered')).toBeNull();
  });

  test('shows no badge for a null status', () => {
    expect(invitedEmailStatusLabel(null)).toBeNull();
  });
});
