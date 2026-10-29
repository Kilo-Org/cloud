import { describe, expect, it } from '@jest/globals';
import type { EnvironmentSummary } from '@kilocode/cloud-agent-profile';
import {
  additionalRepositories,
  buildRequestedEnvironment,
  environmentBlocksStart,
  selectEnvironment,
  selectedEnvironment,
} from './environment-selection';

const BASE = {
  name: 'Environment',
  createdAt: '2026-10-21T00:00:00.000Z',
  updatedAt: '2026-10-21T00:00:00.000Z',
  plainVarCount: 0,
  secretCount: 0,
  commandCount: 0,
  sandboxAllocation: null,
  configurationRevision: 1,
};

function v1(id: string, repoFullName = 'acme/web'): EnvironmentSummary {
  return {
    ...BASE,
    id,
    platform: 'github',
    repoFullName,
    gitlabCloneUrl: null,
    bitbucketWorkspaceUuid: null,
    bitbucketRepositoryUuid: null,
  };
}

function v2(id: string, ...names: string[]): EnvironmentSummary {
  return {
    ...BASE,
    id,
    repositories: names.map(repoFullName => ({ platform: 'github' as const, repoFullName })),
  };
}

const launch = { platform: 'github', fullName: 'Acme/Web' } as const;

describe('selectEnvironment', () => {
  it('is loading while the matches load, unknown after a failed load, and none for none', () => {
    expect(selectEnvironment(undefined, null, true)).toEqual({ status: 'loading' });
    expect(selectEnvironment(undefined, null, false)).toEqual({ status: 'unknown' });
    expect(selectEnvironment([], null, false)).toEqual({ status: 'none' });
  });

  it('needs no choice for one match', () => {
    const only = v1('a');
    expect(selectEnvironment([only], null, false)).toEqual({
      status: 'selected',
      environment: only,
      chosen: false,
    });
    // A stale choice from another repository does not matter.
    expect(selectEnvironment([only], 'other', false)).toMatchObject({
      status: 'selected',
      chosen: false,
    });
  });

  it('asks the user to choose among several matches', () => {
    const matches = [v1('a'), v2('b', 'acme/web', 'acme/api')];
    expect(selectEnvironment(matches, null, false)).toEqual({
      status: 'choose',
      environments: matches,
    });
    expect(selectEnvironment(matches, 'gone', false)).toMatchObject({ status: 'choose' });
    expect(selectEnvironment(matches, 'b', false)).toEqual({
      status: 'selected',
      environment: matches[1],
      chosen: true,
    });
  });

  it('exposes no environment while unknown or not yet chosen', () => {
    const matches = [v1('a'), v1('b')];
    expect(selectedEnvironment(selectEnvironment(undefined, null, false))).toBeUndefined();
    expect(selectedEnvironment(selectEnvironment(matches, null, false))).toBeUndefined();
    expect(selectedEnvironment(selectEnvironment([], null, false))).toBeNull();
    expect(selectedEnvironment(selectEnvironment(matches, 'b', false))).toBe(matches[1]);
  });
});

describe('buildRequestedEnvironment', () => {
  const environment = v2('b', 'acme/web', 'acme/api', 'acme/docs');
  const selected = (chosen: boolean) => ({ status: 'selected', environment, chosen }) as const;

  it('sends nothing for a single match without branches', () => {
    expect(buildRequestedEnvironment(selected(false), launch, {})).toBeUndefined();
    expect(buildRequestedEnvironment({ status: 'none' }, launch, {})).toBeUndefined();
    expect(
      buildRequestedEnvironment({ status: 'choose', environments: [environment] }, launch, {})
    ).toBeUndefined();
  });

  it('sends the id of a chosen environment', () => {
    expect(buildRequestedEnvironment(selected(true), launch, { 'acme/api': '  ' })).toEqual({
      id: 'b',
    });
  });

  it('sends a branch for each additional repository that has one, and never for the launch', () => {
    expect(
      buildRequestedEnvironment(selected(false), launch, {
        'acme/api': ' feature/api ',
        'acme/web': 'ignored',
        'acme/docs': '',
      })
    ).toEqual({ id: 'b', repositories: [{ repoFullName: 'acme/api', branch: 'feature/api' }] });
  });

  it('never sends branches for a V1 environment', () => {
    expect(
      buildRequestedEnvironment(
        { status: 'selected', environment: v1('a'), chosen: false },
        launch,
        { 'acme/web': 'x' }
      )
    ).toBeUndefined();
  });
});

describe('additionalRepositories', () => {
  it('lists the V2 members other than the launch repository', () => {
    expect(
      additionalRepositories(v2('b', 'acme/web', 'acme/api'), launch).map(m => m.repoFullName)
    ).toEqual(['acme/api']);
    expect(additionalRepositories(v1('a'), launch)).toEqual([]);
  });
});

describe('environmentBlocksStart', () => {
  it('waits while the matches load and while several need a choice', () => {
    expect(environmentBlocksStart(selectEnvironment(undefined, null, true))).toBe(true);
    expect(environmentBlocksStart(selectEnvironment([v1('a'), v1('b')], null, false))).toBe(true);
  });

  it('does not wait after a failed load, with no match, or with a usable environment', () => {
    expect(environmentBlocksStart(selectEnvironment(undefined, null, false))).toBe(false);
    expect(environmentBlocksStart(selectEnvironment([], null, false))).toBe(false);
    expect(environmentBlocksStart(selectEnvironment([v1('a')], null, false))).toBe(false);
    expect(environmentBlocksStart(selectEnvironment([v1('a'), v1('b')], 'b', false))).toBe(false);
  });
});
