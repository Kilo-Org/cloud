import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrizzleClient } from '@kilocode/db/client';
import { kilocode_users, user_github_app_tokens } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import { encryptKeyedEnvelope } from '@kilocode/encryption';
import { GitHubUserAuthorizationService } from './github-user-authorization-service.js';

const mocks = vi.hoisted(() => ({
  installation: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withFields: vi.fn() },
}));
vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class {
    constructor(
      _ctx: unknown,
      public env: unknown
    ) {}
  },
}));
vi.mock('./installation-lookup-service.js', () => ({
  InstallationLookupService: class {
    findManagedInstallationForRepo = mocks.installation;
  },
}));
vi.mock('./github-token-service.js', () => ({
  GitHubTokenService: class {
    async getTokenForRepo() {
      return 'synthetic-installation-token';
    }
  },
}));
vi.mock('@cloudflare/sandbox', () => ({ Sandbox: class {}, ContainerProxy: class {} }));
vi.mock('../../cloud-agent-next/node_modules/@cloudflare/sandbox/dist/index.js', () => ({
  Sandbox: class {},
  ContainerProxy: class {},
}));
vi.mock('../../cloud-agent-next/src/container-usage.js', () => ({ MeteredSandbox: class {} }));
vi.mock('../../cloud-agent-next/src/logger.js', () => ({ logger: mocks.logger }));

import { GitTokenRPCEntrypoint } from './index.js';

// This explicit, local-only target keeps the normal unit suite database-free.
const databaseUrl = process.env.GITHUB_IDENTITY_TEST_POSTGRES_URL;
describe.skipIf(!databaseUrl)(
  'typed GitHub credentials through the actual outbound proxy and redemption path',
  () => {
    const userId = `github-identity-integration-${randomUUID()}`;
    const integrationId = '00000000-0000-4000-8000-000000000042';
    const token = 'ghu_CONTAINEDSENTINEL012345678901234567890';
    const nextToken = 'gho_REPLACEDSENTINEL012345678901234567890';
    const keys = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    let database: ReturnType<typeof createDrizzleClient>;
    let service: GitTokenRPCEntrypoint;
    let authorizationService: GitHubUserAuthorizationService;
    let handleOutbound: (
      request: Request,
      env: unknown,
      context: { containerId: string }
    ) => Promise<Response>;
    const upstreamRequests: Request[] = [];
    let upstreamStatus = 200;
    let subjectId = '8080';
    const env = () => ({ GIT_TOKEN_SERVICE: service });
    const metadata = {
      id: 42,
      node_id: 'R_repo',
      name: 'repo',
      owner: { login: 'acme' },
      full_name: 'acme/repo',
      permissions: { push: true },
    };
    const scopedToken = 'ghu_SCOPEDSENTINEL012345678901234567890';
    const encrypted = (value: string, githubUserId = '8080') =>
      encryptKeyedEnvelope(
        value,
        'github-user-token-rsa-aes-256-gcm',
        { keyId: 'test', publicKeyPem: keys.publicKey },
        `github-user-authorization:v1:${userId}:standard:${githubUserId}:access`
      );

    beforeAll(async () => {
      if (
        !databaseUrl ||
        !['localhost', '127.0.0.1', '::1'].includes(new URL(databaseUrl).hostname)
      )
        throw new Error('A local test database is required');
      database = createDrizzleClient({ connectionString: databaseUrl });
      await database.db.insert(kilocode_users).values({
        id: userId,
        google_user_email: `${userId}@example.com`,
        google_user_name: 'Synthetic identity',
        google_user_image_url: '',
        stripe_customer_id: 'synthetic',
      });
      const configuration = {
        HYPERDRIVE: { connectionString: databaseUrl },
        REPOSITORY_POLICY: {
          repositoryAccessProtocolVersion: async () => 2,
          readWorkspaceRepositoryPolicy: async () => ({
            sandboxId: 'sandbox_test',
            access: {
              version: 1,
              scopeId: 'worktree_test',
              revision: 0,
              repositories: [
                {
                  repositoryId: 42,
                  nodeId: 'R_repo',
                  owner: 'acme',
                  name: 'repo',
                  mode: 'contribute',
                  source: 'environment',
                  approvedBy: userId,
                  approvedAt: 1,
                  integrationId,
                  identity: { source: 'user', providerSubjectId: '8080', appType: 'standard' },
                },
              ],
            },
          }),
        },
        GITHUB_APP_SLUG: 'kiloconnect',
        GITHUB_APP_CLIENT_ID: 'synthetic-client',
        GITHUB_APP_CLIENT_SECRET: 'synthetic-secret',
        GITHUB_APP_BOT_USER_ID: '123',
        SCM_SESSION_CAPABILITY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        USER_GITHUB_APP_TOKEN_ACTIVE_KEY_ID: 'test',
        USER_GITHUB_APP_TOKEN_ACTIVE_PUBLIC_KEY: Buffer.from(keys.publicKey).toString('base64'),
        USER_GITHUB_APP_TOKEN_ACTIVE_PRIVATE_KEY: Buffer.from(keys.privateKey).toString('base64'),
      } as unknown as CloudflareEnv;
      service = new GitTokenRPCEntrypoint({} as ExecutionContext, configuration);
      authorizationService = new GitHubUserAuthorizationService(configuration);
      // Load the production proxy without adding another service's generated Env
      // declarations to this package's TypeScript compilation.
      const proxyModule = new URL('../../cloud-agent-next/src/sandbox-outbound.ts', import.meta.url)
        .pathname;
      ({ handleManagedScmOutbound: handleOutbound } = await vi.importActual<{
        handleManagedScmOutbound: typeof handleOutbound;
      }>(proxyModule));
    });

    beforeEach(async () => {
      vi.clearAllMocks();
      mocks.logger.withFields.mockReturnValue(mocks.logger);
      upstreamRequests.length = 0;
      upstreamStatus = 200;
      subjectId = '8080';
      mocks.installation.mockResolvedValue({
        success: true,
        installationId: '123',
        accountLogin: 'acme',
        githubAppType: 'standard',
        repoName: 'repo',
        integrationId,
        permissions: { contents: 'write', pull_requests: 'write' },
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          if (new URL(request.url).pathname === '/user')
            return Response.json({ id: Number(subjectId) });
          if (new URL(request.url).pathname === '/user/installations/123/repositories')
            return Response.json({ total_count: 1, repositories: [{ id: 42 }] });
          if (request.url === 'https://api.github.com/repos/acme/repo')
            return Response.json(metadata);
          if (new URL(request.url).pathname.endsWith('/token/scoped'))
            return Response.json({
              token: scopedToken,
              installation: {
                id: 123,
                repository_selection: 'selected',
                permissions: JSON.parse(await request.text()).permissions,
              },
            });
          if (request.url === 'https://api.github.com/repos/acme/other')
            return new Response(null, { status: 404 });
          if (new URL(request.url).pathname.startsWith('/applications/'))
            return new Response(null, { status: 204 });
          upstreamRequests.push(request);
          return Response.json({ ok: true }, { status: upstreamStatus });
        })
      );
      await database.db
        .delete(user_github_app_tokens)
        .where(eq(user_github_app_tokens.kilo_user_id, userId));
      await database.db.insert(user_github_app_tokens).values({
        kilo_user_id: userId,
        github_user_id: '8080',
        github_login: 'token-user',
        credential_source: 'github_app',
        refresh_token_encrypted: encrypted('synthetic-refresh'),
        refresh_token_expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        access_token_encrypted: encrypted(token),
        access_token_expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
    });

    afterAll(async () => {
      vi.unstubAllGlobals();
      if (database) {
        await database.db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
        await database.pool.end();
      }
    });

    async function issue(allowUserAuthorization = true) {
      const result = await service.issueGitHubSessionCapability({
        userId,
        githubRepo: 'acme/repo',
        expectedIntegrationId: integrationId,
        outboundContainerId: 'container-1',
        allowUserAuthorization,
        ...(allowUserAuthorization
          ? { taskScope: { scopeId: 'worktree_test', taskRef: 'refs/heads/main' } }
          : {}),
      });
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('issuance_failed');
      expect(JSON.stringify(result)).not.toContain(token);
      return result.capability;
    }
    const proxyRequest = (
      capability: string,
      url = 'https://api.github.com/repos/acme/repo/issues',
      method = 'GET',
      containerId = 'container-1'
    ) =>
      handleOutbound(
        new Request(url, { method, headers: { Authorization: `Bearer ${capability}` } }),
        env(),
        { containerId }
      );

    it('rejects provided credentials explicitly when issuing a task capability', async () => {
      await database.db
        .update(user_github_app_tokens)
        .set({
          credential_source: 'provided_token',
          refresh_token_encrypted: null,
          refresh_token_expires_at: null,
        })
        .where(eq(user_github_app_tokens.kilo_user_id, userId));
      await expect(
        service.issueGitHubSessionCapability({
          userId,
          githubRepo: 'acme/repo',
          expectedIntegrationId: integrationId,
          outboundContainerId: 'container-1',
          allowUserAuthorization: true,
          taskScope: { scopeId: 'worktree_test', taskRef: 'refs/heads/main' },
        })
      ).resolves.toEqual({ success: false, reason: 'provided_token_not_supported' });
      expect(upstreamRequests).toHaveLength(0);
    });

    it('rejects user-authorized issuance without a task scope', async () => {
      await expect(
        service.issueGitHubSessionCapability({
          userId,
          githubRepo: 'acme/repo',
          outboundContainerId: 'container-1',
          allowUserAuthorization: true,
        })
      ).resolves.toEqual({ success: false, reason: 'invalid_task_scope' });
    });

    it('injects the decrypted credential only into the admitted upstream request', async () => {
      const capability = await issue();
      const response = await proxyRequest(capability);
      expect(response.status).toBe(200);
      expect(upstreamRequests).toHaveLength(1);
      expect(upstreamRequests[0].headers.get('authorization')).toBe(`Bearer ${scopedToken}`);
      expect(await response.text()).not.toContain(token);
      expect(JSON.stringify(Object.values(mocks.logger).map(log => log.mock.calls))).not.toContain(
        token
      );
    });

    it.each([404, 500])(
      'denies attachment uploads outside the task contract without revoking identity (upstream %s)',
      async status => {
        const capability = await issue();
        upstreamStatus = status;
        const response = await proxyRequest(
          capability,
          'https://uploads.github.com/user-attachments/assets?repository_id=42',
          'POST'
        );
        expect(response.ok).toBe(false);
        expect(upstreamRequests).toHaveLength(0);
        const [authorization] = await database.db
          .select()
          .from(user_github_app_tokens)
          .where(eq(user_github_app_tokens.kilo_user_id, userId));
        expect(authorization.revoked_at).toBeNull();
        expect(authorization.credential_version).toBe(1);
      }
    );

    it.each([
      ['https://api.github.com/repos/acme/other/issues', 'GET', 'container-1'],
      ['https://api.github.com/repos/acme/repo/issues', 'GET', 'wrong-container'],
      [
        'https://uploads.github.com/user-attachments/assets?repository_id=999',
        'POST',
        'container-1',
      ],
      ['https://uploads.github.com/user-attachments/assets?repository_id=42', 'PUT', 'container-1'],
    ])(
      'denies wrong repository, container, numeric ID, or method: %s %s %s',
      async (url, method, containerId) => {
        const response = await proxyRequest(await issue(), url, method, containerId);
        expect(response.ok).toBe(false);
        expect(upstreamRequests).toHaveLength(0);
      }
    );

    it('denies an unsupported host at redemption', async () => {
      await expect(
        service.redeemGitHubSessionCapability({
          capability: await issue(),
          outboundContainerId: 'container-1',
          requestUrl: 'https://evil.example/repos/acme/repo',
          requestMethod: 'GET',
        })
      ).resolves.toMatchObject({ success: false });
      expect(upstreamRequests).toHaveLength(0);
    });

    it('rechecks installation admission before choosing the App user token', async () => {
      const capability = await issue();
      mocks.installation.mockResolvedValue({ success: false, reason: 'integration_mismatch' });
      expect((await proxyRequest(capability)).ok).toBe(false);
      expect(upstreamRequests).toHaveLength(0);
    });

    it('serves an existing capability with a scoped token after a same-account credential replacement', async () => {
      const capability = await issue();
      await database.db
        .update(user_github_app_tokens)
        .set({ access_token_encrypted: encrypted(nextToken), credential_version: 2 })
        .where(eq(user_github_app_tokens.kilo_user_id, userId));
      expect((await proxyRequest(capability)).ok).toBe(true);
      expect(upstreamRequests[0].headers.get('authorization')).toBe(`Bearer ${scopedToken}`);
    });

    it('denies a changed account for a user-source capability', async () => {
      const capability = await issue();
      subjectId = '9090';
      await database.db
        .update(user_github_app_tokens)
        .set({
          github_user_id: '9090',
          github_login: 'different-user',
          access_token_encrypted: encrypted(nextToken, '9090'),
          credential_version: 2,
        })
        .where(eq(user_github_app_tokens.kilo_user_id, userId));
      expect((await proxyRequest(capability)).ok).toBe(false);
      expect(upstreamRequests).toHaveLength(0);
    });

    it('denies legacy attachment uploads outside the workspace repository policy', async () => {
      const capability = await issue(false);
      await database.db
        .update(user_github_app_tokens)
        .set({
          github_user_id: '9090',
          github_login: 'different-user',
          access_token_encrypted: encrypted(nextToken, '9090'),
          credential_version: 2,
        })
        .where(eq(user_github_app_tokens.kilo_user_id, userId));
      const redemption = await service.redeemGitHubSessionCapability({
        capability,
        outboundContainerId: 'container-1',
        requestMethod: 'POST',
        requestUrl: 'https://uploads.github.com/user-attachments/assets?repository_id=42',
      });
      expect(redemption.success).toBe(false);
      expect(redemption).not.toHaveProperty('authorization');
      expect(
        (
          await proxyRequest(
            capability,
            'https://uploads.github.com/user-attachments/assets?repository_id=42',
            'POST'
          )
        ).ok
      ).toBe(false);
      expect(upstreamRequests).toHaveLength(0);
    });

    it('does not remove a replacement through a stale disconnect', async () => {
      const [initial] = await database.db
        .select()
        .from(user_github_app_tokens)
        .where(eq(user_github_app_tokens.kilo_user_id, userId));
      await database.db
        .update(user_github_app_tokens)
        .set({ access_token_encrypted: encrypted(nextToken), credential_version: 2 })
        .where(eq(user_github_app_tokens.id, initial.id));
      await expect(
        authorizationService.disconnectUserAuthorization(userId, {
          authorizationId: initial.id,
          credentialVersion: 1,
        })
      ).rejects.toThrow('github_identity_conflict');
      expect(
        await database.db
          .select()
          .from(user_github_app_tokens)
          .where(
            and(
              eq(user_github_app_tokens.id, initial.id),
              eq(user_github_app_tokens.credential_version, 2)
            )
          )
      ).toHaveLength(1);
      await authorizationService.disconnectUserAuthorization(userId, {
        authorizationId: initial.id,
        credentialVersion: 2,
      });
      expect(
        (await authorizationService.getUserAccessToken(userId, { op: 'fetch' })).connected
      ).toBe(false);
      expect(upstreamRequests).toHaveLength(0);
    });
  }
);
