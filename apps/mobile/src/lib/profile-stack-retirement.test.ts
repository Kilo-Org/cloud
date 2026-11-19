import { beforeEach, describe, expect, it } from 'vitest';

import {
  notePendingProfileRetirement,
  PROFILE_RETIREMENT_TTL_MS,
  resetPendingProfileRetirementsForTests,
  takeRetirableProfileRoutes,
} from './profile-stack-retirement';

const SECTION = 'profiles/[profileId]/instructions';
const LIST = 'profiles/index';
const OVERVIEW = 'profiles/[profileId]/index';

const route = (key: string, name: string): { key: string; name: string } => ({ key, name });

const NOW = 1_000;

beforeEach(() => {
  resetPendingProfileRetirementsForTests();
});

describe('takeRetirableProfileRoutes', () => {
  it('retires the original once its rebuilt copy is the focused route', () => {
    notePendingProfileRetirement({ key: 'orig', selfName: SECTION, now: NOW });
    const routes = [
      route('root', 'index'),
      route('orig', SECTION),
      route('list', LIST),
      route('overview', OVERVIEW),
      route('rebuilt', SECTION),
    ];

    const next = takeRetirableProfileRoutes({ routes, index: 4, now: NOW });

    expect(next?.routes.map(entry => entry.key)).toEqual([
      'root',
      'list',
      'overview',
      'rebuilt',
    ]);
    expect(next?.index).toBe(3);
  });

  it('keeps the original while another screen is the focused route', () => {
    notePendingProfileRetirement({ key: 'orig', selfName: SECTION, now: NOW });
    const routes = [route('orig', SECTION), route('list', LIST)];

    expect(takeRetirableProfileRoutes({ routes, index: 1, now: NOW })).toBeNull();
  });

  it('keeps the original while it is still the focused route', () => {
    notePendingProfileRetirement({ key: 'orig', selfName: SECTION, now: NOW });

    expect(
      takeRetirableProfileRoutes({
        routes: [route('root', 'index'), route('orig', SECTION)],
        index: 1,
        now: NOW,
      })
    ).toBeNull();
  });

  it('never retires a different section that sits on top', () => {
    // The focused route is a rebuilt copy of ANOTHER profile screen: the
    // original being tracked must stay until its own rebuilt copy lands.
    notePendingProfileRetirement({ key: 'orig', selfName: SECTION, now: NOW });
    const routes = [
      route('orig', SECTION),
      route('skills-rebuilt', 'profiles/[profileId]/skills'),
    ];

    expect(takeRetirableProfileRoutes({ routes, index: 1, now: NOW })).toBeNull();
  });

  it('forgets an original that left the stack some other way', () => {
    notePendingProfileRetirement({ key: 'orig', selfName: SECTION, now: NOW });
    const gone = [route('root', 'index'), route('rebuilt', SECTION)];

    expect(takeRetirableProfileRoutes({ routes: gone, index: 1, now: NOW })).toBeNull();
    // Recorded once, so a second look does not resurrect a removal either.
    expect(takeRetirableProfileRoutes({ routes: gone, index: 1, now: NOW })).toBeNull();
  });

  it('drops a removal the navigator never confirmed', () => {
    notePendingProfileRetirement({ key: 'orig', selfName: SECTION, now: NOW });
    const routes = [route('orig', SECTION), route('rebuilt', SECTION)];

    expect(
      takeRetirableProfileRoutes({
        routes,
        index: 1,
        now: NOW + PROFILE_RETIREMENT_TTL_MS,
      })
    ).toBeNull();
  });

  it('retires nothing when no removal is pending', () => {
    expect(
      takeRetirableProfileRoutes({
        routes: [route('a', SECTION), route('b', SECTION)],
        index: 1,
        now: NOW,
      })
    ).toBeNull();
  });
});