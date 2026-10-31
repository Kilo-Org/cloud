import { describe, expect, it } from 'vitest';

import {
  hasParentsToPush,
  isRebuiltProfileEntry,
  LIST_CHILD_PARENTS,
  missingProfileStackParents,
  openedFromQuery,
  OVERVIEW_PARENTS,
  parentsToPush,
  PROFILE_STACK_REBUILT_PARAM,
  profileExternalOpener,
  profileStackRepair,
  profileStackRepairScreenOptions,
  SECTION_PARENTS,
  withRebuiltParents,
} from './profile-route-stack';

const LIST = 'profile-management/index';
const OVERVIEW = 'profile-management/[profileId]/index';
const AGENTS = 'profile-management/[profileId]/agents';

const route = (name: string) => ({ name });

function missing(names: readonly string[], current: number, parents = SECTION_PARENTS) {
  return parentsToPush(
    parents,
    missingProfileStackParents({
      routes: names.map(name => route(name)),
      currentIndex: current,
      listRouteName: LIST,
      overviewRouteName: OVERVIEW,
    })
  );
}

describe('missingProfileStackParents', () => {
  it('asks for nothing when the list and the overview are beneath a section', () => {
    expect(missing(['(tabs)', 'agent-chat/new', LIST, OVERVIEW, AGENTS], 4)).toEqual({
      list: false,
      overview: false,
    });
    expect(hasParentsToPush(missing(['(tabs)', LIST, OVERVIEW, AGENTS], 3))).toBe(false);
  });

  it('asks for the list and the overview when a section arrived on its own', () => {
    expect(missing(['(tabs)', AGENTS], 1)).toEqual({ list: true, overview: true });
  });

  it('asks for the overview when a section sits directly on the list', () => {
    expect(missing(['(tabs)', LIST, AGENTS], 2)).toEqual({ list: false, overview: true });
  });

  it('asks for the list when the overview arrived over an unrelated screen', () => {
    expect(missing(['(tabs)', 'agent-chat/new', OVERVIEW], 2, OVERVIEW_PARENTS)).toEqual({
      list: true,
      overview: false,
    });
  });

  it('does not count the same screen higher in the stack as a parent', () => {
    // The overview sits ABOVE this section: it is a screen the reader moved on
    // from, not one beneath it.
    expect(missing([LIST, AGENTS, OVERVIEW], 1)).toEqual({ list: false, overview: true });
  });

  it('asks for the list under the create and repo-bindings screens', () => {
    expect(
      parentsToPush(
        LIST_CHILD_PARENTS,
        missingProfileStackParents({
          routes: ['(tabs)', 'profile-management/new'].map(name => route(name)),
          currentIndex: 1,
          listRouteName: LIST,
          overviewRouteName: OVERVIEW,
        })
      )
    ).toEqual({ list: true, overview: false });
  });
});

describe('parentsToPush', () => {
  it('never pushes a parent the screen does not need', () => {
    expect(parentsToPush(LIST_CHILD_PARENTS, { list: true, overview: true })).toEqual({
      list: true,
      overview: false,
    });
    expect(parentsToPush(OVERVIEW_PARENTS, { list: false, overview: true })).toEqual({
      list: false,
      overview: false,
    });
  });
});

describe('the rebuilt-entry marker', () => {
  it('marks the href it rebuilds, with or without a query', () => {
    expect(withRebuiltParents('/(app)/profile-management/profile-1')).toBe(
      `/(app)/profile-management/profile-1?${PROFILE_STACK_REBUILT_PARAM}=1`
    );
    expect(withRebuiltParents('/(app)/profile-management/profile-1?organizationId=org-1')).toBe(
      `/(app)/profile-management/profile-1?organizationId=org-1&${PROFILE_STACK_REBUILT_PARAM}=1`
    );
  });

  it('reads the marker off a route, including a repeated param', () => {
    expect(isRebuiltProfileEntry({ [PROFILE_STACK_REBUILT_PARAM]: '1' })).toBe(true);
    expect(isRebuiltProfileEntry({ [PROFILE_STACK_REBUILT_PARAM]: ['1'] })).toBe(true);
    expect(isRebuiltProfileEntry({ [PROFILE_STACK_REBUILT_PARAM]: '0' })).toBe(false);
    expect(isRebuiltProfileEntry({})).toBe(false);
  });

  it('turns the transition off only for a rebuilt push', () => {
    expect(profileStackRepairScreenOptions({ route: {} })).toEqual({});
    expect(
      profileStackRepairScreenOptions({ route: { params: { [PROFILE_STACK_REBUILT_PARAM]: '1' } } })
    ).toEqual({ animation: 'none' });
  });
});

describe('profileStackRepair', () => {
  const repair = (names: readonly string[], current: number, openedOutsideProfileTree = false) =>
    profileStackRepair({
      routes: names.map(name => route(name)),
      currentIndex: current,
      openedOutsideProfileTree,
      parents: SECTION_PARENTS,
      listRouteName: LIST,
      overviewRouteName: OVERVIEW,
    });

  it('builds both parents for a section that arrived on its own', () => {
    expect(repair(['(tabs)', AGENTS], 1)).toEqual({ list: true, overview: true });
  });

  it('asks for nothing when the parents are already beneath', () => {
    expect(repair(['(tabs)', LIST, OVERVIEW, AGENTS], 3)).toEqual({
      list: false,
      overview: false,
    });
  });

  it('leaves a screen an outside app screen opened on purpose alone', () => {
    expect(repair(['(tabs)', 'agent-chat/[session-id]', OVERVIEW], 2, true)).toEqual({
      list: false,
      overview: false,
    });
  });

  it('builds the parents of a link delivered over another app screen', () => {
    expect(repair(['(tabs)', 'agent-chat/new', AGENTS], 2)).toEqual({
      list: true,
      overview: true,
    });
  });
});

describe('profileExternalOpener', () => {
  it('reads the marker the outside openers write', () => {
    expect(profileExternalOpener({ openedFrom: 'session' })).toBe('session');
    expect(profileExternalOpener({ openedFrom: 'composer' })).toBe('composer');
  });

  it('reports no opener for a plain route or an unknown value', () => {
    expect(profileExternalOpener({ organizationId: 'org-1' })).toBeNull();
    expect(profileExternalOpener({ openedFrom: 'somewhere' })).toBeNull();
    expect(profileExternalOpener(undefined)).toBeNull();
  });

  it('writes the query fragment the path builders append', () => {
    expect(openedFromQuery('session')).toBe('openedFrom=session');
  });
});
