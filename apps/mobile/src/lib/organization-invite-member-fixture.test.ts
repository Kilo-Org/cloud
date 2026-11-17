import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleOrganizationInviteMemberFixturePath } from './organization-invite-member-fixture';

const routing = vi.hoisted(() => ({
  dismissTo: vi.fn(),
  push: vi.fn(),
}));

vi.mock('expo-router', () => ({
  router: { dismissTo: routing.dismissTo, push: routing.push },
}));

beforeEach(() => {
  vi.useFakeTimers();
  routing.dismissTo.mockClear();
  routing.push.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('handleOrganizationInviteMemberFixturePath', () => {
  it('walks the hub, members and then the sheet, the way the reader does', () => {
    expect(
      handleOrganizationInviteMemberFixturePath('/dev/organization-invite-member-fixture')
    ).toBe(true);

    expect(routing.dismissTo).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/organization');
    expect(routing.push.mock.calls).toEqual([['/(app)/(tabs)/(3_profile)/organization/members']]);

    // The sheet is pushed once the members screen has presented.
    vi.advanceTimersByTime(400);
    expect(routing.push.mock.calls).toEqual([
      ['/(app)/(tabs)/(3_profile)/organization/members'],
      ['/(app)/(tabs)/(3_profile)/organization/invite-member'],
    ]);
  });

  it('accepts a trailing slash', () => {
    expect(
      handleOrganizationInviteMemberFixturePath('/dev/organization-invite-member-fixture/')
    ).toBe(true);
  });

  it('leaves every other link to the app router', () => {
    expect(handleOrganizationInviteMemberFixturePath('/dev/some-other-fixture')).toBe(false);
    expect(
      handleOrganizationInviteMemberFixturePath(
        '/(app)/(tabs)/(3_profile)/organization/invite-member'
      )
    ).toBe(false);
    expect(routing.push).not.toHaveBeenCalled();
  });
});
