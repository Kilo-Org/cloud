import { describe, expect, it } from 'vitest';
import { callbackHeadRepoFullName } from './head-repository.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';

function metadataWithRepository(repository: unknown): SessionMetadata {
  return { repository } as SessionMetadata;
}

describe('callbackHeadRepoFullName', () => {
  it('reports the GitHub repository the session pushes to', () => {
    expect(
      callbackHeadRepoFullName(
        metadataWithRepository({ type: 'github', repo: 'maphew/kilo-cloud' })
      )
    ).toBe('maphew/kilo-cloud');
  });

  it('reports nothing for a session with no repository', () => {
    expect(callbackHeadRepoFullName(metadataWithRepository(undefined))).toBeUndefined();
    expect(callbackHeadRepoFullName(undefined)).toBeUndefined();
    expect(callbackHeadRepoFullName(null)).toBeUndefined();
  });

  it.each([
    { type: 'gitlab', url: 'https://gitlab.com/o/r.git' },
    { type: 'bitbucket', url: 'https://bitbucket.org/o/r.git' },
    { type: 'git', url: 'https://github.com/o/r.git' },
  ])('reports nothing for a non-GitHub repository (%o)', repository => {
    expect(callbackHeadRepoFullName(metadataWithRepository(repository))).toBeUndefined();
  });
});
