import { describe, expect, it } from 'vitest';

import { hasInviteSeatCapacity, inviteConsumesSeat } from './seat-capacity';

describe('inviteConsumesSeat', () => {
  it('counts every role but billing_manager', () => {
    expect(inviteConsumesSeat('owner')).toBe(true);
    expect(inviteConsumesSeat('admin')).toBe(true);
    expect(inviteConsumesSeat('member')).toBe(true);
    expect(inviteConsumesSeat('billing_manager')).toBe(false);
  });
});

describe('hasInviteSeatCapacity', () => {
  it('allows an invitation when the plan does not enforce seats', () => {
    expect(
      hasInviteSeatCapacity({
        plan: 'teams',
        requireSeats: false,
        usedSeats: 5,
        totalSeats: 5,
      })
    ).toBe(true);
  });

  it('never limits an enterprise plan', () => {
    expect(
      hasInviteSeatCapacity({
        plan: 'enterprise',
        requireSeats: true,
        usedSeats: 5,
        totalSeats: 5,
      })
    ).toBe(true);
  });

  it('allows a Teams invitation while a seat is free and blocks it at the limit', () => {
    expect(
      hasInviteSeatCapacity({
        plan: 'teams',
        requireSeats: true,
        usedSeats: 4,
        totalSeats: 5,
      })
    ).toBe(true);
    expect(
      hasInviteSeatCapacity({
        plan: 'teams',
        requireSeats: true,
        usedSeats: 5,
        totalSeats: 5,
      })
    ).toBe(false);
  });
});
