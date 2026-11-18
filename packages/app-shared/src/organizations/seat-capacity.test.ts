import { describe, expect, it } from 'vitest';

import { hasInviteSeatCapacity, inviteConsumesSeat, seatCountReadout } from './seat-capacity';

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

describe('seatCountReadout', () => {
  const formatNumber = (value: number) => value.toLocaleString('en-US');

  it('writes the fraction for an enforced organization with bought seats', () => {
    expect(seatCountReadout({ seatsEnforced: true, used: 4, total: 10, formatNumber })).toBe(
      '4 / 10'
    );
  });

  it('holds a seat-enforcing organization with none bought at the used count', () => {
    expect(seatCountReadout({ seatsEnforced: true, used: 1, total: 0, formatNumber })).toBe('1');
  });

  it('holds an unenforced organization at the used count with a positive total', () => {
    expect(seatCountReadout({ seatsEnforced: false, used: 2, total: 5, formatNumber })).toBe('2');
  });
});
