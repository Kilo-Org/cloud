import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Static import: the route module is under test, and its `vi.mock`-ed
// dependencies register before this import resolves.
import ProfileOverviewRoute from '@/app/(app)/(tabs)/(3_profile)/profiles/[profileId]';
import { getProfileRouteNames, getProfilesRouteName } from '@/lib/profile-agent-navigation';

/**
 * The create hand-off pushes the overview and retires the form beneath it from
 * the form's own listener — which a covered screen never runs. The overview
 * owns the retire instead, and this suite pins the pair of route names it
 * judges: the create screen above it, and the profiles list beneath the form.
 */

const retireMock = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ profileId: 'profile-1' }),
}));

vi.mock('@/lib/navigation/retire-covered-source', () => ({
  useRetireCoveredSource: retireMock,
}));

// The route's other effects and the screen are not the subject: only the
// covered-source judgment is.
vi.mock('@/lib/hooks/use-leave-stale-profile-scope', () => ({
  useLeaveStaleProfileScope: () => false,
}));
vi.mock('@/lib/hooks/use-repair-profile-route-stack', () => ({
  useRepairProfileRouteStack: () => undefined,
}));
vi.mock('@/components/invalid-route-state', () => ({ InvalidRouteState: 'InvalidRouteState' }));
vi.mock('@/components/profiles/profile-overview-screen', () => ({
  ProfileOverviewScreen: 'ProfileOverviewScreen',
}));

beforeEach(() => {
  retireMock.mockReset();
});

describe('ProfileOverviewRoute retire-covered-source', () => {
  it('retires the create screen with the profiles list as its guard', () => {
    act(() => {
      TestRenderer.create(createElement(ProfileOverviewRoute));
    });

    expect(retireMock).toHaveBeenCalledTimes(1);
    expect(retireMock).toHaveBeenCalledWith('profiles/new', 'profiles/index');
  });

  it('names routes the Profile tab Stack registers', () => {
    act(() => {
      TestRenderer.create(createElement(ProfileOverviewRoute));
    });

    const [source, guardBelow] = retireMock.mock.calls[0] as [string, string];
    expect(getProfileRouteNames('profileTab')).toContain(source);
    expect(guardBelow).toBe(getProfilesRouteName('profileTab'));
  });
});
