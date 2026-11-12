import { describe, expect, it } from 'vitest';
import { githubAgentApiFacts } from './github-agent-api-telemetry.js';

describe('managed agent GitHub API telemetry', () => {
  it.each([
    ['https://api.github.com/graphql', 'POST', 'graphql'],
    ['https://api.github.com/repos/example/repository/check-runs', 'GET', 'rest_read'],
    ['https://api.github.com/repos/example/repository/issues/1/comments', 'POST', 'rest_write'],
    ['https://uploads.github.com/repos/example/repository/releases/1/assets', 'POST', 'upload'],
  ])(
    'records actual API class and quota headers without credentials or payloads',
    (url, method, endpointClass) => {
      const request = new Request(`${url}?private=synthetic-private-query`, {
        method,
        headers: {
          Authorization: 'Bearer synthetic-private-token',
          Cookie: 'synthetic-private-cookie',
        },
      });
      const response = new Response(null, {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1794500000',
          'x-ratelimit-used': '5000',
          'x-ratelimit-limit': '5000',
        },
      });
      const facts = githubAgentApiFacts(
        request,
        { installationId: 'synthetic-installation', appType: 'lite', source: 'installation' },
        response
      );
      expect(facts).toMatchObject({
        event: 'github_agent_api',
        reason: 'agent_request',
        endpointClass,
        method,
        status: 403,
        installationId: 'synthetic-installation',
        appType: 'lite',
        rateLimitRemaining: 0,
        rateLimitUsed: 5000,
        attribution: 'workspace_shared_capability',
      });
      expect(JSON.stringify(facts)).not.toContain('synthetic-private');
    }
  );

  it('does not count Git transport as a GitHub API request', () => {
    expect(
      githubAgentApiFacts(
        new Request('https://github.com/example/repository.git/git-upload-pack', {
          method: 'POST',
        }),
        {},
        new Response()
      )
    ).toBeNull();
  });
});
