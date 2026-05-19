import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkPRStatus,
  resolveGitHubToken,
  type SCMContext,
  type PRStatusOutcome,
} from '../../src/dos/town/town-scm';
import type { TownConfig } from '../../src/types';

function mockSCMContext(overrides: Partial<SCMContext> = {}): SCMContext {
  return {
    env: {} as SCMContext['env'],
    townId: 'test-town',
    getTownConfig: async () => ({}) as TownConfig,
    ...overrides,
  };
}

describe('resolveGitHubToken', () => {
  it('returns ok:true with source when github_token is configured', async () => {
    const ctx = mockSCMContext({
      getTownConfig: async () => ({ git_auth: { github_token: 'ghp_abc123' } }) as TownConfig,
    });
    const result = await resolveGitHubToken(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toBe('ghp_abc123');
      expect(result.source).toBe('town.git_auth.github_token');
    }
  });

  it('prefers github_cli_pat over stored github_token', async () => {
    const ctx = mockSCMContext({
      getTownConfig: async () =>
        ({ git_auth: { github_token: 'ghp_stored' }, github_cli_pat: 'ghp_pat123' }) as TownConfig,
    });
    const result = await resolveGitHubToken(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toBe('ghp_pat123');
      expect(result.source).toBe('town.github_cli_pat');
    }
  });

  it('returns ok:false with resolution chain when no token is configured', async () => {
    const ctx = mockSCMContext({
      getTownConfig: async () => ({}) as TownConfig,
    });
    const result = await resolveGitHubToken(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tried).toContain('town.git_auth.github_token');
      expect(result.tried).toContain('town.github_cli_pat');
      expect(result.tried).toContain('platform integration (none configured)');
    }
  });

  it('includes platform integration source label in resolution chain', async () => {
    const ctx = mockSCMContext({
      platformIntegrationId: 'integration-123',
      env: { GIT_TOKEN_SERVICE: { getToken: async () => null } } as unknown as SCMContext['env'],
      getTownConfig: async () =>
        ({ git_auth: { platform_integration_id: 'integration-123' } }) as TownConfig,
    });
    const result = await resolveGitHubToken(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tried).toContain('town platform integration');
    }
  });

  it('uses rig platform integration label when town has no platform_integration_id', async () => {
    const ctx = mockSCMContext({
      platformIntegrationId: 'rig-integration-456',
      env: { GIT_TOKEN_SERVICE: { getToken: async () => null } } as unknown as SCMContext['env'],
      getTownConfig: async () => ({}) as TownConfig,
    });
    const result = await resolveGitHubToken(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tried).toContain('rig platform integration');
    }
  });

  it('includes GIT_TOKEN_SERVICE not bound annotation when integrationId set but service missing', async () => {
    const ctx = mockSCMContext({
      platformIntegrationId: 'integration-789',
      env: {} as SCMContext['env'],
      getTownConfig: async () =>
        ({ git_auth: { platform_integration_id: 'integration-789' } }) as TownConfig,
    });
    const result = await resolveGitHubToken(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tried).toContain('town platform integration (GIT_TOKEN_SERVICE not bound)');
    }
  });
});

describe('checkPRStatus', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns no_token error when no GitHub token is available', async () => {
    const ctx = mockSCMContext({
      getTownConfig: async () => ({}) as TownConfig,
    });
    const outcome = await checkPRStatus(ctx, 'https://github.com/owner/repo/pull/1');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe('no_token');
      expect(outcome.error.provider).toBe('github');
      if (outcome.error.kind === 'no_token') {
        expect(outcome.error.resolutionChain).toContain('town.git_auth.github_token');
        expect(outcome.error.resolutionChain).toContain('town.github_cli_pat');
      }
    }
  });

  it('returns http_error with transient:true for 5xx status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Server Error', { status: 503, statusText: 'Service Unavailable' })
    );
    const ctx = mockSCMContext({
      getTownConfig: async () => ({ git_auth: { github_token: 'ghp_test' } }) as TownConfig,
    });
    const outcome = await checkPRStatus(ctx, 'https://github.com/owner/repo/pull/1');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.error.kind === 'http_error') {
      expect(outcome.error.status).toBe(503);
      expect(outcome.error.transient).toBe(true);
      expect(outcome.error.provider).toBe('github');
    }
  });

  it('returns http_error with transient:true for 429 status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Rate Limited', { status: 429, statusText: 'Too Many Requests' })
    );
    const ctx = mockSCMContext({
      getTownConfig: async () => ({ git_auth: { github_token: 'ghp_test' } }) as TownConfig,
    });
    const outcome = await checkPRStatus(ctx, 'https://github.com/owner/repo/pull/1');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.error.kind === 'http_error') {
      expect(outcome.error.status).toBe(429);
      expect(outcome.error.transient).toBe(true);
    }
  });

  it('returns http_error with transient:false for 401 status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
    );
    const ctx = mockSCMContext({
      getTownConfig: async () => ({ git_auth: { github_token: 'ghp_bad' } }) as TownConfig,
    });
    const outcome = await checkPRStatus(ctx, 'https://github.com/owner/repo/pull/1');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.error.kind === 'http_error') {
      expect(outcome.error.status).toBe(401);
      expect(outcome.error.transient).toBe(false);
    }
  });

  it('returns http_error with transient:false for 403 status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Forbidden', { status: 403, statusText: 'Forbidden' })
    );
    const ctx = mockSCMContext({
      getTownConfig: async () => ({ git_auth: { github_token: 'ghp_limited' } }) as TownConfig,
    });
    const outcome = await checkPRStatus(ctx, 'https://github.com/owner/repo/pull/1');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.error.kind === 'http_error') {
      expect(outcome.error.status).toBe(403);
      expect(outcome.error.transient).toBe(false);
    }
  });

  it('returns http_error with transient:false for 404 status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Not Found', { status: 404, statusText: 'Not Found' })
    );
    const ctx = mockSCMContext({
      getTownConfig: async () => ({ git_auth: { github_token: 'ghp_test' } }) as TownConfig,
    });
    const outcome = await checkPRStatus(ctx, 'https://github.com/owner/repo/pull/1');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.error.kind === 'http_error') {
      expect(outcome.error.status).toBe(404);
      expect(outcome.error.transient).toBe(false);
    }
  });

  it('returns invalid_response with json_parse when response body is not JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not json', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    );
    const ctx = mockSCMContext({
      getTownConfig: async () => ({ git_auth: { github_token: 'ghp_test' } }) as TownConfig,
    });
    const outcome = await checkPRStatus(ctx, 'https://github.com/owner/repo/pull/1');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.error.kind === 'invalid_response') {
      expect(outcome.error.reason).toBe('json_parse');
      expect(outcome.error.provider).toBe('github');
    }
  });

  it('returns invalid_response with schema_mismatch and sampleKeys when response shape is wrong', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 42, title: 'not a PR', random_field: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const ctx = mockSCMContext({
      getTownConfig: async () => ({ git_auth: { github_token: 'ghp_test' } }) as TownConfig,
    });
    const outcome = await checkPRStatus(ctx, 'https://github.com/owner/repo/pull/1');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.error.kind === 'invalid_response') {
      expect(outcome.error.reason).toBe('schema_mismatch');
      expect(outcome.error.sampleKeys).toBeDefined();
      expect(outcome.error.sampleKeys!.length).toBeGreaterThan(0);
      expect(outcome.error.provider).toBe('github');
    }
  });

  it('returns unrecognized_url for non-GitHub/GitLab URLs', async () => {
    const ctx = mockSCMContext({
      getTownConfig: async () => ({}) as TownConfig,
    });
    const outcome = await checkPRStatus(ctx, 'https://example.com/something');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.error.kind === 'unrecognized_url') {
      expect(outcome.error.url).toBe('https://example.com/something');
    }
  });

  it('returns ok:true with merged status for merged PR', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ state: 'closed', merged: true, mergeable_state: 'clean' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const ctx = mockSCMContext({
      getTownConfig: async () => ({ git_auth: { github_token: 'ghp_test' } }) as TownConfig,
    });
    const outcome = await checkPRStatus(ctx, 'https://github.com/owner/repo/pull/1');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.status).toBe('merged');
    }
  });

  it('returns ok:true with open status for open PR', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ state: 'open', merged: false, mergeable_state: 'clean' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const ctx = mockSCMContext({
      getTownConfig: async () => ({ git_auth: { github_token: 'ghp_test' } }) as TownConfig,
    });
    const outcome = await checkPRStatus(ctx, 'https://github.com/owner/repo/pull/1');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.status).toBe('open');
      expect(outcome.result.mergeable_state).toBe('clean');
    }
  });

  it('returns host_mismatch for GitLab URL with unknown host', async () => {
    const ctx = mockSCMContext({
      getTownConfig: async () =>
        ({
          git_auth: {
            gitlab_token: 'glpat_test',
            gitlab_instance_url: 'https://gitlab.mycompany.com',
          },
        }) as TownConfig,
    });
    const outcome = await checkPRStatus(
      ctx,
      'https://gitlab.evil.com/group/project/-/merge_requests/5'
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.error.kind === 'host_mismatch') {
      expect(outcome.error.got).toBe('gitlab.evil.com');
      expect(outcome.error.expected).toBe('gitlab.mycompany.com');
    }
  });

  it('allows gitlab.com without host validation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ state: 'merged' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const ctx = mockSCMContext({
      getTownConfig: async () => ({ git_auth: { gitlab_token: 'glpat_test' } }) as TownConfig,
    });
    const outcome = await checkPRStatus(ctx, 'https://gitlab.com/group/project/-/merge_requests/5');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.status).toBe('merged');
    }
  });
});
