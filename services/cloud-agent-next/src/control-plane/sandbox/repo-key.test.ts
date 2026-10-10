import { describe, expect, it } from 'vitest';
import {
  computeRepoKey,
  repoSnapshotEligible,
  repoSnapshotEligibility,
  type RepoSnapshotGate,
} from './repo-key.js';
import { ISOLATED_CONTAINER_WORKSPACE_PATH } from '../../workspace.js';

const USER = 'user_123';
const ORG = 'org_123';
const REPO_URL = 'https://github.com/acme/widgets.git';

function gate(overrides: Partial<RepoSnapshotGate> = {}): RepoSnapshotGate {
  return {
    enrolledIds: undefined,
    userId: USER,
    orgId: ORG,
    ...overrides,
  };
}

const route = { repoUrl: REPO_URL, directory: ISOLATED_CONTAINER_WORKSPACE_PATH };

describe('repoSnapshotEligible', () => {
  it('enrolls a personal owner by user ID from the unified flag', () => {
    expect(repoSnapshotEligible(gate({ enrolledIds: USER, orgId: undefined }), route)).toBe(true);
  });

  it('enrolls an org owner by org ID from the unified flag', () => {
    expect(repoSnapshotEligible(gate({ enrolledIds: ORG }), route)).toBe(true);
  });

  it("enrolls everyone for the unified flag's wildcard", () => {
    expect(repoSnapshotEligible(gate({ enrolledIds: '*' }), route)).toBe(true);
    expect(repoSnapshotEligible(gate({ enrolledIds: '*', orgId: undefined }), route)).toBe(true);
  });

  it('does not enroll a non-matching user or org', () => {
    expect(repoSnapshotEligible(gate({ enrolledIds: 'user_other,org_other' }), route)).toBe(false);
    expect(
      repoSnapshotEligible(gate({ enrolledIds: 'user_other,org_other', orgId: undefined }), route)
    ).toBe(false);
  });

  it('requires a repository at the isolated constant path', () => {
    expect(repoSnapshotEligible(gate({ enrolledIds: '*' }), { ...route, repoUrl: undefined })).toBe(
      false
    );
    expect(
      repoSnapshotEligible(gate({ enrolledIds: '*' }), {
        ...route,
        directory: '/workspace/org/user/sessions/s1',
      })
    ).toBe(false);
  });

  it('excludes a route with setup commands and treats empty or absent the same', () => {
    const enrolled = gate({ enrolledIds: '*' });
    expect(repoSnapshotEligible(enrolled, { ...route, setupCommands: ['pnpm install'] })).toBe(
      false
    );
    expect(repoSnapshotEligible(enrolled, { ...route, setupCommands: [] })).toBe(true);
    expect(repoSnapshotEligible(enrolled, route)).toBe(true);
  });
});

describe('repoSnapshotEligibility', () => {
  it('names the gate that rejected the route', () => {
    expect(repoSnapshotEligibility(gate({ enrolledIds: 'user_other,org_other' }), route)).toEqual({
      eligible: false,
      reason: 'not_enrolled',
    });
    expect(
      repoSnapshotEligibility(gate({ enrolledIds: '*' }), { ...route, repoUrl: undefined })
    ).toEqual({ eligible: false, reason: 'no_repo_url' });
    expect(
      repoSnapshotEligibility(gate({ enrolledIds: '*' }), {
        ...route,
        directory: '/workspace/org/user/sessions/s1',
      })
    ).toEqual({ eligible: false, reason: 'directory_not_isolated' });
  });

  it('reports an enrolled route with a repository at the isolated path as eligible', () => {
    expect(repoSnapshotEligibility(gate({ enrolledIds: '*' }), route)).toEqual({ eligible: true });
  });
});

describe('computeRepoKey', () => {
  it('returns no key without a secret or a repository', async () => {
    expect(await computeRepoKey({ secret: null, userId: USER, ...route })).toBeNull();
    expect(
      await computeRepoKey({
        secret: 'secret',
        userId: USER,
        repoUrl: undefined,
        directory: route.directory,
      })
    ).toBeNull();
  });

  it('scopes the key to the user and the repository', async () => {
    const base = await computeRepoKey({ secret: 'secret', userId: USER, ...route });
    const otherUser = await computeRepoKey({ secret: 'secret', userId: 'user_other', ...route });
    const otherRepo = await computeRepoKey({
      secret: 'secret',
      userId: USER,
      ...route,
      repoUrl: 'https://github.com/acme/other.git',
    });
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(otherUser).not.toBe(base);
    expect(otherRepo).not.toBe(base);
  });
});
