import { beforeEach, describe, expect, it, vi } from 'vitest';

import { profilePickerFixtureRoute } from './profile-picker-fixture';

const slot = vi.hoisted(() => ({ set: vi.fn() }));

vi.mock('@/lib/route-registry', () => ({
  UNFENCED_ROUTE_KEY: 'unscoped',
  profilePickerSlot: { set: slot.set },
}));

beforeEach(() => {
  slot.set.mockReset();
});

describe('profilePickerFixtureRoute', () => {
  it('opens the sheet in the personal scope when the link carries no query', () => {
    expect(profilePickerFixtureRoute('/dev/profile-picker-fixture')).toBe(
      '/(app)/agent-chat/profile-picker'
    );
    expect(slot.set).toHaveBeenCalledWith('unscoped', {
      organizationId: undefined,
      selectedOverrideProfileId: null,
      repoBindingProfileId: null,
      onSelect: expect.any(Function),
    });
  });

  it('opens the sheet in the organization scope the link names', () => {
    expect(profilePickerFixtureRoute('/dev/profile-picker-fixture?org=org-1')).toBe(
      '/(app)/agent-chat/profile-picker'
    );
    expect(slot.set.mock.calls[0]?.[1]).toMatchObject({ organizationId: 'org-1' });
  });

  it('leaves every other link to the app router', () => {
    expect(profilePickerFixtureRoute('/dev/model-picker-fixture/multiple-providers')).toBeNull();
    expect(profilePickerFixtureRoute('/agent-chat/profile-picker')).toBeNull();
    expect(slot.set).not.toHaveBeenCalled();
  });
});
