import { describe, expect, it } from 'vitest';
import { getGitHubTaskArchive, githubTaskArchiveRedirect } from './github-task-archive.js';

const archive = { owner: 'acme', repository: 'repo', format: 'tar' as const };
describe('GitHub task archive URLs', () => {
  it.each(['tarball', 'zipball'])('recognizes the authenticated %s endpoint', format => {
    expect(
      getGitHubTaskArchive(
        new URL(`https://api.github.com/repos/Acme/Repo/${format}/refs/heads/main`)
      )
    ).toEqual({ ...archive, format: format === 'tarball' ? 'tar' : 'zip' });
  });
  it.each([
    'http://api.github.com/repos/acme/repo/tarball/main',
    'https://api.github.com.evil.example/repos/acme/repo/tarball/main',
    'https://user:password@api.github.com/repos/acme/repo/tarball/main',
    'https://api.github.com/repos/acme/repo/tarball/main?token=synthetic',
    'https://api.github.com/repos/acme/repo/tarball/main#fragment',
    'https://api.github.com/repos/acme/repo/contents/file',
  ])('rejects an unsupported archive endpoint %s', value => {
    expect(getGitHubTaskArchive(new URL(value))).toBeUndefined();
  });
  it.each(['tar.gz', 'legacy.tar.gz'])(
    'retains the exact selected tar repository for %s',
    format => {
      const value = `https://codeload.github.com/Acme/Repo/${format}/refs/heads/main`;
      expect(githubTaskArchiveRedirect(value, archive)?.href).toBe(new URL(value).href);
    }
  );
  it.each(['zip', 'legacy.zip'])('retains the selected zip format for %s', format => {
    expect(
      githubTaskArchiveRedirect(`https://codeload.github.com/acme/repo/${format}/main`, {
        ...archive,
        format: 'zip',
      })
    ).toBeDefined();
  });
  it.each([
    'https://codeload.github.com/other/repo/tar.gz/main',
    'https://codeload.github.com/acme/other/tar.gz/main',
    'https://codeload.github.com/acme/repo/zip/main',
    'https://codeload.github.com/acme/repo/tar.gz',
    'https://codeload.github.com/acme/repo/tar.gz/',
    'https://codeload.github.com/acme/repo/tar.gz/refs//main',
    'http://codeload.github.com/acme/repo/tar.gz/main',
    'https://codeload.github.com.evil.example/acme/repo/tar.gz/main',
    'https://codeload.github.com:444/acme/repo/tar.gz/main',
    'https://user:password@codeload.github.com/acme/repo/tar.gz/main',
    'https://codeload.github.com/acme/repo/tar.gz/main#fragment',
    'https://codeload.github.com/acme/repo/tar.gz/main with-space',
    'https://codeload.github.com/acme/repo/tar.gz/main\t',
    'https://codeload.github.com/acme/repo/tar.gz/main' + String.fromCharCode(92) + 'other',
    'x'.repeat(16_385),
    '/acme/repo/tar.gz/main',
  ])('rejects an unsafe or mismatched archive redirect %#', value => {
    expect(githubTaskArchiveRedirect(value, archive)).toBeUndefined();
  });
});
