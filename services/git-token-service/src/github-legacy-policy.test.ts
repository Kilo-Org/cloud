import { describe, expect, it } from 'vitest';
import {
  decodePathnameIteratively,
  parseGitHubCapabilityRequest,
  validateLegacyGitHubRequest,
} from './github-legacy-policy.js';

const repository = { owner: 'acme', repo: 'repo' };

describe('frozen legacy GitHub request policy', () => {
  it.each([
    [
      'GET',
      'https://uploads.github.com/user-attachments/assets?repository_id=1145038391',
      'invalid_upstream_request',
    ],
    [
      'POST',
      'https://uploads.github.com/user-attachments/assets?content_type=image%2Fpng&name=screenshot.png',
      'invalid_upstream_request',
    ],
    [
      'POST',
      'https://uploads.github.com/user-attachments/assets?repository_id=1145038391&repository_id=1145038391',
      'invalid_upstream_request',
    ],
    [
      'POST',
      'https://uploads.github.com/user-attachments/assets?repository_id=1145038391&name=x;repository_id=42',
      'invalid_upstream_request',
    ],
    [
      'POST',
      'https://uploads.github.com/user-attachments/assets?repository_id=0',
      'invalid_upstream_request',
    ],
    [
      'POST',
      'https://uploads.github.com/user-attachments/assets?repository_id=01',
      'invalid_upstream_request',
    ],
    [
      'POST',
      'https://uploads.github.com/user-attachments/assets?repository_id=-1',
      'invalid_upstream_request',
    ],
    [
      'POST',
      'https://uploads.github.com/user-attachments/assets?repository_id=1.0',
      'invalid_upstream_request',
    ],
    [
      'POST',
      'https://uploads.github.com/user-attachments/assets?repository_id=1e3',
      'invalid_upstream_request',
    ],
    [
      'POST',
      'https://uploads.github.com/user-attachments/assets?repository_id=9007199254740992',
      'invalid_upstream_request',
    ],
    [
      'POST',
      'https://uploads.github.com/user-attachments/assets/extra?repository_id=1145038391',
      'repository_mismatch',
    ],
    [
      'POST',
      'https://uploads.github.com/user-attachments?repository_id=1145038391',
      'repository_mismatch',
    ],
    [
      'POST',
      'https://api.github.com/user-attachments/assets?repository_id=1145038391',
      'repository_mismatch',
    ],
    [
      'POST',
      'https://uploads.github.com.evil.example/user-attachments/assets?repository_id=1145038391',
      'upstream_host_not_allowed',
    ],
  ])('rejects attachment shape %s %s', (method, url, failure) => {
    expect(validateLegacyGitHubRequest(method, url, repository)).toEqual({ failure });
  });
  it.each([
    ['GET', 'https://api.github.com/repos/acme/other/pulls/42', 'repository_mismatch'],
    ['GET', 'https://api.github.com/user/repos', 'repository_mismatch'],
    ['GET', 'https://api.github.com/graphql', 'invalid_upstream_request'],
    ['OPTIONS', 'https://api.github.com/repos/acme/repo/pulls/42', 'invalid_upstream_request'],
    [
      'POST',
      'https://uploads.github.com/repos/acme/other/releases/1/assets?name=asset.zip',
      'repository_mismatch',
    ],
    ['GET', 'https://npm.pkg.github.com/@other%2fdesign', 'repository_mismatch'],
    ['POST', 'https://npm.pkg.github.com/@acme%2fdesign', 'invalid_upstream_request'],
    ['GET', 'https://github.com/acme/other/issues', 'repository_mismatch'],
    ['GET', 'https://github.com/acme/other.git/archive/main.tar.gz', 'repository_mismatch'],
    ['GET', 'https://api.github.com/repos/acme/repo/files/..%2f..%2fother', 'invalid_upstream_url'],
    [
      'DELETE',
      'https://api.github.com/repos/acme/other/issues/42/comments/1',
      'repository_mismatch',
    ],
    ['GET', 'https://github.com/acme/repo2/archive/main.tar.gz', 'repository_mismatch'],
  ])('retains the repository boundary for %s %s', (method, url, failure) => {
    expect(validateLegacyGitHubRequest(method, url, repository)).toEqual({ failure });
  });
  it.each([
    ['GET', 'https://api.github.com/repos/acme/repo'],
    ['HEAD', 'https://api.github.com/user'],
    ['POST', 'https://api.github.com/graphql'],
    ['PUT', 'https://api.github.com/repos/acme/repo/pulls/42/merge'],
    ['DELETE', 'https://api.github.com/repos/acme/repo/labels/bug'],
    ['POST', 'https://uploads.github.com/repos/acme/repo/releases/1/assets?name=asset.zip'],
    ['GET', 'https://npm.pkg.github.com/@acme%2fdesign'],
    ['HEAD', 'https://npm.pkg.github.com/@acme/design'],
    ['GET', 'https://npm.pkg.github.com/download/@acme/design/1/asset'],
    ['GET', 'https://github.com/acme/repo/info/refs?service=git-upload-pack'],
    ['GET', 'https://github.com/acme/repo.git/info/refs?service=git-receive-pack'],
    ['POST', 'https://github.com/acme/repo.git/git-receive-pack'],
    ['POST', 'https://github.com/acme/repo.git/git-upload-pack'],
    ['POST', 'https://github.com/acme/repo.git/info/lfs/objects/batch'],
    ['GET', 'https://github.com/acme/repo.git/info/lfs/locks?cursor=next'],
    ['POST', 'https://github.com/acme/repo.git/info/lfs/locks'],
    ['POST', 'https://github.com/acme/repo.git/info/lfs/locks/verify'],
    ['POST', 'https://github.com/acme/repo.git/info/lfs/locks/42/unlock'],
  ])('preserves the recorded credential for %s %s', (method, url) => {
    expect(validateLegacyGitHubRequest(method, url, repository)).toEqual({
      failure: null,
      credential: 'pinned',
    });
  });
  it('requires a user credential and authoritative repository ID for an attachment', () => {
    const url = 'https://uploads.github.com/user-attachments/assets?repository_id=1145038391';
    expect(validateLegacyGitHubRequest('POST', url, repository)).toEqual({
      failure: null,
      credential: 'user',
      repositoryId: 1145038391,
    });
    expect(
      validateLegacyGitHubRequest('POST', url, { ...repository, permissionScope: 'repository' })
    ).toEqual({ failure: 'invalid_upstream_request' });
  });
  it.each([
    ['GET', 'https://github.com/public/other.git/info/refs?service=git-upload-pack'],
    ['POST', 'https://github.com/public/other.git/git-upload-pack'],
    ['GET', 'https://github.com/public/other.git/info/lfs/locks'],
  ])('keeps foreign Git requests anonymous for %s %s', (method, url) => {
    expect(validateLegacyGitHubRequest(method, url, repository)).toEqual({
      failure: null,
      credential: 'none',
    });
  });
  it.each([
    ['not a URL', 'invalid_upstream_url'],
    ['http://api.github.com/repos/acme/repo', 'invalid_upstream_url'],
    ['https://user:password@api.github.com/repos/acme/repo', 'invalid_upstream_url'],
    ['https://api.github.com/repos/acme/repo#fragment', 'invalid_upstream_url'],
    ['https://api.github.com:444/repos/acme/repo', 'upstream_host_not_allowed'],
    ['https://api.github.com/repos/acme/repo/%GG', 'invalid_upstream_url'],
    ['https://api.github.com/repos/acme/repo/%252e%252e%252fother', 'invalid_upstream_url'],
    ['https://api.github.com/repos/acme/repo/%5cother', 'invalid_upstream_url'],
    ['https://api.github.com/repos/acme/repo/%2525252fother', 'invalid_upstream_url'],
  ])('rejects malformed transport %s', (url, failure) => {
    expect(validateLegacyGitHubRequest('GET', url, repository)).toEqual({ failure });
  });
  it('canonicalizes the method and decoded repository path', () => {
    const parsed = parseGitHubCapabilityRequest(
      'post',
      'https://api.github.com/repos/Acme%252fRepo/pulls'
    );
    expect(parsed.failure).toBeNull();
    expect(parsed.request).toMatchObject({ method: 'POST', path: '/repos/acme/repo/pulls' });
    expect(decodePathnameIteratively('/acme%252frepo')).toBe('/acme/repo');
    expect(decodePathnameIteratively('/acme%2525252frepo')).toBeNull();
    expect(decodePathnameIteratively('/%GG')).toBeNull();
  });
});
