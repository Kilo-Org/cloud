import { describe, expect, it } from 'vitest';

import { gitlabInstanceMismatch } from './pr-review-connect-gate-view';

describe('gitlabInstanceMismatch', () => {
  const connected = 'https://gitlab.com';

  it('names both hosts when the merge request lives on another instance', () => {
    expect(
      gitlabInstanceMismatch({
        instanceHint: 'https://gitlab.example.com',
        connectedInstanceUrl: connected,
      })
    ).toEqual({ connectedHost: 'gitlab.com', requestedHost: 'gitlab.example.com' });
  });

  it('compares origins the way the server does — scheme, path and case are not the instance', () => {
    expect(
      gitlabInstanceMismatch({
        instanceHint: 'http://GitLab.Example.COM/group/sub/',
        connectedInstanceUrl: 'https://gitlab.example.com/',
      })
    ).toBeNull();
  });

  it('treats a different port as another instance', () => {
    expect(
      gitlabInstanceMismatch({
        instanceHint: 'https://gitlab.example.com:8443',
        connectedInstanceUrl: 'https://gitlab.example.com',
      })
    ).toEqual({ connectedHost: 'gitlab.example.com', requestedHost: 'gitlab.example.com:8443' });
  });

  it('has no mismatch to report when either side names no host', () => {
    // The route carries a hint only when the link named one; without it the
    // account's connected instance is the one the read would use.
    expect(
      gitlabInstanceMismatch({ instanceHint: undefined, connectedInstanceUrl: connected })
    ).toBeNull();
    expect(
      gitlabInstanceMismatch({
        instanceHint: 'https://gitlab.example.com',
        connectedInstanceUrl: undefined,
      })
    ).toBeNull();
  });

  it('reads the instance out of a stored self-managed URL', () => {
    expect(
      gitlabInstanceMismatch({
        instanceHint: 'https://gitlab.com/group/repo',
        connectedInstanceUrl: 'https://gitlab.acme.dev/gitlab',
      })
    ).toEqual({ connectedHost: 'gitlab.acme.dev', requestedHost: 'gitlab.com' });
  });
});
