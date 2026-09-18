import { describe, expect, it } from 'vitest';

import { type NewSessionRepository } from './new-session-repository-state';
import {
  type PrepareSessionRepositoryFields,
  resolveRepoFingerprint,
  setRepositoryField,
} from './prepare-session-repository';

// The two hooks that build a `prepareSession` body (create and clone) now share
// this module, so these cases pin the provider rules once: the retry
// fingerprint identity, and the "exactly one repository field" writer that both
// bodies use.

const GITHUB_ROW: NewSessionRepository = {
  platform: 'github',
  fullName: 'owner/repo',
  isPrivate: false,
};
const GITLAB_ROW: NewSessionRepository = {
  platform: 'gitlab',
  fullName: 'group/project',
  isPrivate: true,
};
const BITBUCKET_ROW: NewSessionRepository = {
  platform: 'bitbucket',
  fullName: 'workspace/repo',
  isPrivate: true,
  workspaceUuid: 'ws-1234',
  repositoryUuid: 'repo-5678',
};

// A minimal `prepareSession`-shaped body: the shared writer only ever touches
// the repository fields, so the key list proves what it did (and did not) write.
function newBody(): PrepareSessionRepositoryFields & { prompt: string } {
  return { prompt: 'hello' };
}

describe('resolveRepoFingerprint', () => {
  it('returns null for no repository', () => {
    expect(resolveRepoFingerprint(null)).toBeNull();
  });

  it('carries the platform and fullName for a GitHub row', () => {
    expect(resolveRepoFingerprint(GITHUB_ROW)).toEqual({
      platform: 'github',
      fullName: 'owner/repo',
    });
  });

  it('carries the platform and fullName for a GitLab row', () => {
    expect(resolveRepoFingerprint(GITLAB_ROW)).toEqual({
      platform: 'gitlab',
      fullName: 'group/project',
    });
  });

  it('carries the workspace and repository uuids for a Bitbucket row', () => {
    expect(resolveRepoFingerprint(BITBUCKET_ROW)).toEqual({
      platform: 'bitbucket',
      fullName: 'workspace/repo',
      workspaceUuid: 'ws-1234',
      repositoryUuid: 'repo-5678',
    });
  });

  it('normalizes missing Bitbucket uuids to null instead of dropping the keys', () => {
    expect(resolveRepoFingerprint({ ...BITBUCKET_ROW, workspaceUuid: undefined })).toEqual({
      platform: 'bitbucket',
      fullName: 'workspace/repo',
      workspaceUuid: null,
      repositoryUuid: 'repo-5678',
    });
  });
});

describe('setRepositoryField', () => {
  it('writes only the bare githubRepo for a GitHub row', () => {
    const body = newBody();

    expect(setRepositoryField(body, GITHUB_ROW)).toBe(true);

    // The bare `fullName`, never a `platform:fullName` picker key.
    expect(body).toEqual({ prompt: 'hello', githubRepo: 'owner/repo' });
  });

  it('writes only gitlabProject for a GitLab row', () => {
    const body = newBody();

    expect(setRepositoryField(body, GITLAB_ROW)).toBe(true);

    expect(body).toEqual({ prompt: 'hello', gitlabProject: 'group/project' });
  });

  it('writes only bitbucketRepo with both uuids for a Bitbucket row', () => {
    const body = newBody();

    expect(setRepositoryField(body, BITBUCKET_ROW)).toBe(true);

    expect(body).toEqual({
      prompt: 'hello',
      bitbucketRepo: {
        fullName: 'workspace/repo',
        workspaceUuid: 'ws-1234',
        repositoryUuid: 'repo-5678',
      },
    });
  });

  it('writes nothing for a Bitbucket row missing its uuids', () => {
    const body = newBody();

    expect(setRepositoryField(body, { ...BITBUCKET_ROW, workspaceUuid: undefined })).toBe(false);
    expect(Object.keys(body)).toEqual(['prompt']);
  });

  it('writes nothing for a Bitbucket row missing only the repository uuid', () => {
    const body = newBody();

    expect(setRepositoryField(body, { ...BITBUCKET_ROW, repositoryUuid: undefined })).toBe(false);
    expect(Object.keys(body)).toEqual(['prompt']);
  });

  it('writes nothing and reports false for no repository', () => {
    const body = newBody();

    expect(setRepositoryField(body, null)).toBe(false);
    expect(Object.keys(body)).toEqual(['prompt']);
  });
});
