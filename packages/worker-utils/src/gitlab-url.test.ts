import { describe, expect, it } from 'vitest';
import { parseGitLabCloneUrl } from './gitlab-url.js';

describe('parseGitLabCloneUrl', () => {
  const urlWithCredentials = new URL('https://gitlab.example.com/acme/widgets.git');
  urlWithCredentials.username = 'user';
  urlWithCredentials.password = 'pass';

  it.each([
    [
      'https://gitlab.com/acme/widgets.git',
      undefined,
      {
        instanceOrigin: 'https://gitlab.com',
        instanceHost: 'gitlab.com',
        projectPath: 'acme/widgets',
      },
    ],
    [
      'https://gitlab.example.com:8443/gitlab/Acme/platform/widgets.git',
      'https://gitlab.example.com:8443/gitlab/',
      {
        instanceOrigin: 'https://gitlab.example.com:8443/gitlab',
        instanceHost: 'gitlab.example.com:8443',
        projectPath: 'Acme/platform/widgets',
      },
    ],
  ])('accepts canonical nested GitLab clone URL %s', (gitUrl, instanceUrl, expected) => {
    expect(parseGitLabCloneUrl(gitUrl, instanceUrl)).toEqual({ success: true, ...expected });
  });

  it.each([
    ['http://gitlab.com/acme/widgets.git', undefined],
    ['https://gitlab.example.com:8443/acme/widgets.git', 'https://gitlab.example.com:9443'],
    ['https://gitlab.example.com/acme/widgets.git', 'https://gitlab.example.com/gitlab'],
    ['https://gitlab.example.com/acme/widgets.git', 'https://other.example.com'],
    ['https://gitlab.example.com/acme//widgets.git', 'https://gitlab.example.com'],
    ['https://gitlab.example.com/acme/../widgets.git', 'https://gitlab.example.com'],
    ['https://gitlab.example.com/acme%2Fwidgets.git', 'https://gitlab.example.com'],
    [urlWithCredentials.toString(), 'https://gitlab.example.com'],
    ['https://gitlab.example.com/acme/widgets.git?token=secret', 'https://gitlab.example.com'],
  ])('rejects unsafe or unsupported clone URL %s', (gitUrl, instanceUrl) => {
    expect(parseGitLabCloneUrl(gitUrl, instanceUrl).success).toBe(false);
  });
});
