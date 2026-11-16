import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWorkerDb } from '@kilocode/db/client';
import { createAppAuth } from '@octokit/auth-app';
import { GitTokenRPCEntrypoint } from './index.js';
import { InstallationLookupService } from './installation-lookup-service.js';

vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class {
    constructor(
      _ctx: unknown,
      readonly env: unknown
    ) {}
  },
}));
vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn() }));
vi.mock('@octokit/auth-app', () => ({ createAppAuth: vi.fn() }));

const installation = {
  id: '00000000-0000-4000-8000-000000000001',
  platform_installation_id: '123',
  platform_account_login: 'example',
  github_app_type: 'standard',
  owned_by_organization_id: null,
  repository_access: 'all',
  repositories: [],
  permissions: { contents: 'write', pull_requests: 'write' },
};

afterEach(() => vi.restoreAllMocks());

describe('final GitHub broker provenance with real lookup and token issuance', () => {
  const ambiguous = [installation, { ...installation, platform_installation_id: '456' }];
  it.each([
    { scenario: 'miss', rows: [[], []], provenance: 'managed_lookup_miss', repairs: 1, tokens: 0 },
    {
      scenario: 'ambiguity',
      rows: [ambiguous],
      provenance: 'ambiguous_eligible_installations',
      repairs: 0,
      tokens: 0,
    },
    {
      scenario: 'repaired_ambiguity',
      rows: [[], ambiguous],
      provenance: 'ambiguous_eligible_installations',
      repairs: 1,
      tokens: 0,
    },
    {
      scenario: 'token404',
      rows: [[installation]],
      provenance: 'installation_token_http404',
      repairs: 0,
      tokens: 1,
    },
    {
      scenario: 'repair',
      rows: [[], [installation]],
      provenance: undefined,
      repairs: 1,
      tokens: 1,
    },
    { scenario: 'success', rows: [[installation]], provenance: undefined, repairs: 0, tokens: 1 },
  ])(
    '$scenario retains only the final decision',
    async ({ scenario, rows, provenance, repairs, tokens }) => {
      const batches = [...rows];
      const read = vi.fn(async () => batches.shift() ?? []);
      const query = {
        from: () => query,
        leftJoin: () => query,
        innerJoin: () => query,
        where: () => query,
        orderBy: () => query,
        limit: () => query,
        then: (resolve: (rows: unknown[]) => unknown) => read().then(resolve),
      };
      vi.mocked(getWorkerDb).mockReturnValue({ select: () => query } as never);
      const repair = vi
        .spyOn(InstallationLookupService.prototype, 'findRefreshCandidates')
        .mockResolvedValue({ success: true, candidates: [] });
      const auth = vi.fn().mockImplementation(async () => {
        if (scenario === 'token404')
          throw {
            status: 404,
            response: { data: { message: 'Not Found', token: 'synthetic-secret' } },
          };
        return {
          token: 'synthetic-token',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        };
      });
      vi.mocked(createAppAuth).mockReturnValue(Object.assign(auth, { hook: vi.fn() }));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const broker = new GitTokenRPCEntrypoint(
        {} as ExecutionContext,
        {
          HYPERDRIVE: { connectionString: 'postgres://test' },
          GITHUB_APP_ID: 'synthetic-app',
          GITHUB_APP_PRIVATE_KEY: 'synthetic-key',
          GITHUB_APP_SLUG: 'synthetic-app',
          GITHUB_APP_BOT_USER_ID: '123',
          SCM_SESSION_CAPABILITY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        } as unknown as CloudflareEnv
      );
      const result = await broker.issueGitHubSessionCapability({
        githubRepo: 'example/repository',
        userId: 'synthetic-user',
        outboundContainerId: 'synthetic-container',
      });
      if (provenance === undefined) {
        expect(result).toMatchObject({ success: true, source: 'installation' });
        expect(result).not.toHaveProperty('rejectionProvenance');
      } else {
        expect(result).toEqual({
          success: false,
          reason: 'no_installation_found',
          rejectionProvenance: provenance,
        });
      }
      expect(read).toHaveBeenCalledTimes(rows.length);
      expect(repair).toHaveBeenCalledTimes(repairs);
      expect(auth).toHaveBeenCalledTimes(tokens);
      expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    }
  );
});
