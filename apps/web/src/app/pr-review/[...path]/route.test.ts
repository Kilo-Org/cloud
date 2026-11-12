import { describe, expect, it } from '@jest/globals';
import { NextRequest } from 'next/server';

import { GET } from './route';

function createRequest(pathname: string, search = ''): NextRequest {
  return new NextRequest(`http://localhost${pathname}${search}`);
}

async function callGet(pathname: string, search = ''): Promise<Response> {
  // Next decodes catch-all params before the handler runs, so `%2F` arrives as
  // `/` and the resolver must see that decoded value.
  const path = pathname
    .replace(/^\/pr-review\/?/, '')
    .split('/')
    .filter(Boolean)
    .map(segment => decodeURIComponent(segment));
  return GET(createRequest(pathname, search), { params: Promise.resolve({ path }) });
}

describe('GET /pr-review/[...path]', () => {
  it('redirects a GitHub review path to the pull request', async () => {
    const response = await callGet('/pr-review/octocat/hello-world/42');

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://github.com/octocat/hello-world/pull/42');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('redirects a GitLab review on the cloud instance', async () => {
    const response = await callGet('/pr-review/gitlab/group/sub/repo/9');

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://gitlab.com/group/sub/repo/-/merge_requests/9'
    );
  });

  it('serves a link instead of redirecting to a self-managed GitLab host', async () => {
    const response = await callGet(
      '/pr-review/gitlab/group/repo/9',
      '?instance=https%3A%2F%2Fgitlab.example.com'
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    const html = await response.text();
    expect(html).toContain('href="https://gitlab.example.com/group/repo/-/merge_requests/9"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it('redirects a Bitbucket review path', async () => {
    const response = await callGet('/pr-review/bitbucket/acme/api/42');

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://bitbucket.org/acme/api/pull-requests/42'
    );
  });

  it('returns 404 for a malformed path', async () => {
    const response = await callGet('/pr-review/octocat/hello-world');

    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
  });

  it('returns 404 for a hostile instance origin', async () => {
    const response = await callGet(
      '/pr-review/gitlab/group/repo/9',
      '?instance=https%3A%2F%2Fevil.com%2Fphish'
    );

    expect(response.status).toBe(404);
  });

  it('returns 404 for an unknown platform-shaped path', async () => {
    const response = await callGet('/pr-review/%2F%2Fevil.com/repo/1');

    expect(response.status).toBe(404);
  });
});
