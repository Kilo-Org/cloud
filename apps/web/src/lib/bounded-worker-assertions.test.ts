import jwt from 'jsonwebtoken';
import type * as ServerConfig from '@/lib/config.server';
import {
  BITBUCKET_CODE_REVIEW_PULL_REQUEST_AUDIENCE,
  BITBUCKET_CODE_REVIEW_WEBHOOK_DELETE_AUDIENCE,
  BITBUCKET_CODE_REVIEW_WEBHOOK_ENSURE_AUDIENCE,
  BITBUCKET_REPOSITORY_LIST_AUDIENCE,
  GITHUB_USER_ACCESS_TOKEN_AUDIENCE,
  GITHUB_USER_AUTHORIZATION_DISCONNECT_AUDIENCE,
  GITLAB_CREDENTIAL_BROKER_AUDIENCE,
  USER_DATA_EXPORT_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';
import { verifyKiloToken } from '@kilocode/worker-utils/kilo-token';
import {
  isKiloCredentialExchangeEligible,
  verifyKiloTokenForPolicy,
  verifyKiloTokenForResource,
} from '@kilocode/worker-utils/kilo-token-policy';

const mockConfig = {
  gitTokenServiceUrl: 'https://git-token-service.example.test',
  exportWorkerUrl: 'http://127.0.0.1:8787',
  internalApiSecret: 'test-internal-api-secret',
};

jest.mock('@/lib/config.server', () => {
  const actual = jest.requireActual<typeof ServerConfig>('@/lib/config.server');
  return {
    ...actual,
    get GIT_TOKEN_SERVICE_API_URL() {
      return mockConfig.gitTokenServiceUrl;
    },
    get USER_DATA_EXPORT_WORKER_URL() {
      return mockConfig.exportWorkerUrl;
    },
    get INTERNAL_API_SECRET() {
      return mockConfig.internalApiSecret;
    },
  };
});

import { NEXTAUTH_SECRET } from '@/lib/config.server';
import {
  deleteBitbucketWorkspaceWebhooksFromTokenService,
  ensureBitbucketWorkspaceWebhookFromTokenService,
  fetchBitbucketPullRequestFromTokenService,
  fetchBitbucketRepositoriesFromTokenService,
  fetchBitbucketWorkspaceAccessTokenRepositoriesFromTokenService,
} from '@/lib/integrations/platforms/bitbucket/token-service-client';
import { fetchGitLabCredential } from '@/lib/integrations/platforms/gitlab/credential-broker-client';
import { disconnectStoredGitHubUserAuthorization } from '@/lib/integrations/platforms/github/user-authorization-client';
import {
  __resetGitHubUserAccessTokenClientForTests,
  getGitHubUserAccessToken,
} from '@/lib/integrations/platforms/github/user-token-client';
import {
  dispatchUserDataExport,
  requestUserDataExportDownload,
} from '@/lib/user-data-export-worker-client';

const boundedTokenFlag = 'BOUNDED_INTERNAL_SERVICE_TOKENS_ENABLED';
const originalBoundedTokenFlag = process.env[boundedTokenFlag];
const userId = 'bounded-assertion-user';
const organizationId = '11111111-1111-4111-8111-111111111111';
const integrationId = '22222222-2222-4222-8222-222222222222';
const workspaceUuid = '33333333-3333-4333-8333-333333333333';
const repositoryUuid = '44444444-4444-4444-8444-444444444444';

type WorkerOperation = {
  name: string;
  audience: string;
  legacyAudience: boolean;
  organizationId?: string;
  url: string;
  body?: object;
  response: () => Response;
  expectedResult: unknown;
  invoke: () => Promise<unknown>;
  headers?: Record<string, string>;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function authorizationFrom(init: RequestInit | undefined): string {
  const authorization = new Headers(init?.headers).get('authorization');
  if (!authorization?.startsWith('Bearer ')) throw new Error('missing bearer assertion');
  return authorization.slice('Bearer '.length);
}

const workspace = {
  integrationId,
  workspaceUuid,
  workspaceSlug: 'bounded-workspace',
};

const repository = {
  repositoryUuid,
  repositoryFullName: 'bounded-workspace/bounded-repository',
};

const operations: WorkerOperation[] = [
  {
    name: 'Bitbucket repository listing without required organization',
    audience: BITBUCKET_REPOSITORY_LIST_AUDIENCE,
    legacyAudience: true,
    url: `${mockConfig.gitTokenServiceUrl}/internal/bitbucket/repositories`,
    response: () => jsonResponse({ error: 'organization_required' }, 403),
    expectedResult: { status: 'temporarily_unavailable' },
    invoke: () => fetchBitbucketRepositoriesFromTokenService(userId),
  },
  {
    name: 'Bitbucket workspace repository listing',
    audience: BITBUCKET_REPOSITORY_LIST_AUDIENCE,
    legacyAudience: true,
    organizationId,
    url: `${mockConfig.gitTokenServiceUrl}/internal/bitbucket/repositories`,
    response: () => jsonResponse({ status: 'available', repositories: [] }),
    expectedResult: { status: 'available', repositories: [] },
    invoke: () =>
      fetchBitbucketWorkspaceAccessTokenRepositoriesFromTokenService(userId, organizationId),
  },
  {
    name: 'Bitbucket pull-request code review',
    audience: BITBUCKET_CODE_REVIEW_PULL_REQUEST_AUDIENCE,
    legacyAudience: true,
    organizationId,
    url: `${mockConfig.gitTokenServiceUrl}/internal/bitbucket/code-review/pull-request`,
    body: { ...workspace, ...repository, pullRequestId: 17 },
    response: () =>
      jsonResponse({
        success: true,
        pullRequest: {
          id: 17,
          state: 'OPEN',
          draft: false,
          updatedOn: '2026-01-02T03:04:05.000Z',
          title: 'Bounded assertion fixture',
          author: { uuid: workspaceUuid, displayName: 'Bounded User' },
          source: { ...repository, branch: 'feature/bounded', sha: '1234567' },
          destination: { ...repository, branch: 'main', sha: '89abcde' },
          url: 'https://bitbucket.org/bounded-workspace/bounded-repository/pull-requests/17',
        },
      }),
    expectedResult: {
      success: true,
      pullRequest: expect.objectContaining({ id: 17, state: 'OPEN' }),
    },
    invoke: () =>
      fetchBitbucketPullRequestFromTokenService({
        botUserId: userId,
        organizationId,
        workspace,
        repository,
        pullRequestId: 17,
      }),
  },
  {
    name: 'Bitbucket webhook ensure code review',
    audience: BITBUCKET_CODE_REVIEW_WEBHOOK_ENSURE_AUDIENCE,
    legacyAudience: true,
    organizationId,
    url: `${mockConfig.gitTokenServiceUrl}/internal/bitbucket/code-review/webhooks/ensure`,
    body: {
      ...workspace,
      callbackUrl: 'https://app.example.test/api/bitbucket/webhook',
      secret: 'test-webhook-secret',
    },
    response: () =>
      jsonResponse({
        success: true,
        webhook: {
          uuid: workspaceUuid,
          callbackUrl: 'https://app.example.test/api/bitbucket/webhook',
          active: true,
          events: ['pullrequest:created'],
          secretSet: true,
        },
      }),
    expectedResult: {
      success: true,
      webhook: expect.objectContaining({ uuid: workspaceUuid, secretSet: true }),
    },
    invoke: () =>
      ensureBitbucketWorkspaceWebhookFromTokenService({
        managerUserId: userId,
        organizationId,
        workspace,
        callbackUrl: 'https://app.example.test/api/bitbucket/webhook',
        secret: 'test-webhook-secret',
      }),
  },
  {
    name: 'Bitbucket webhook delete code review',
    audience: BITBUCKET_CODE_REVIEW_WEBHOOK_DELETE_AUDIENCE,
    legacyAudience: true,
    organizationId,
    url: `${mockConfig.gitTokenServiceUrl}/internal/bitbucket/code-review/webhooks/delete`,
    body: { ...workspace, callbackUrl: 'https://app.example.test/api/bitbucket/webhook' },
    response: () => jsonResponse({ success: true }),
    expectedResult: { success: true },
    invoke: () =>
      deleteBitbucketWorkspaceWebhooksFromTokenService({
        managerUserId: userId,
        organizationId,
        workspace,
        callbackUrl: 'https://app.example.test/api/bitbucket/webhook',
      }),
  },
  {
    name: 'GitLab credentials',
    audience: GITLAB_CREDENTIAL_BROKER_AUDIENCE,
    legacyAudience: true,
    organizationId,
    url: `${mockConfig.gitTokenServiceUrl}/internal/gitlab/credentials`,
    body: { credential: 'integration', integrationId },
    response: () =>
      jsonResponse({
        status: 'available',
        token: 'glpat-bounded-fixture',
        instanceUrl: 'https://gitlab.example.test',
        glabIsOAuth2: false,
      }),
    expectedResult: {
      status: 'available',
      token: 'glpat-bounded-fixture',
      instanceUrl: 'https://gitlab.example.test',
      glabIsOAuth2: false,
    },
    invoke: () =>
      fetchGitLabCredential(
        { userId, organizationId },
        { credential: 'integration', integrationId }
      ),
  },
  {
    name: 'GitHub user access-token fetch',
    audience: GITHUB_USER_ACCESS_TOKEN_AUDIENCE,
    legacyAudience: true,
    url: `${mockConfig.gitTokenServiceUrl}/internal/github-user-authorizations/token`,
    body: { op: 'fetch' },
    response: () =>
      jsonResponse({
        connected: true,
        token: 'ghs-bounded-fixture',
        expiresAtEpochMs: Date.now() + 60 * 60 * 1000,
        githubLogin: 'bounded-octocat',
        authorizationId: 'bounded-auth-id',
        credentialVersion: 1,
      }),
    expectedResult: {
      status: 'connected',
      credential: expect.objectContaining({
        connected: true,
        token: 'ghs-bounded-fixture',
        credentialVersion: 1,
      }),
    },
    invoke: () => {
      __resetGitHubUserAccessTokenClientForTests();
      return getGitHubUserAccessToken(userId, { op: 'fetch' });
    },
  },
  {
    name: 'GitHub authorization disconnect',
    audience: GITHUB_USER_AUTHORIZATION_DISCONNECT_AUDIENCE,
    legacyAudience: false,
    url: `${mockConfig.gitTokenServiceUrl}/internal/github-user-authorizations/disconnect`,
    response: () => jsonResponse({ disconnected: true }),
    expectedResult: undefined,
    invoke: () => disconnectStoredGitHubUserAuthorization(userId),
  },
  {
    name: 'user-data export dispatch',
    audience: USER_DATA_EXPORT_AUDIENCE,
    legacyAudience: true,
    url: `${mockConfig.exportWorkerUrl}/internal/exports/dispatch`,
    body: { version: 1, operation: 'generate', exportId: 'bounded-export', generation: 3 },
    headers: { 'x-internal-api-key': mockConfig.internalApiSecret },
    response: () => new Response(null, { status: 202 }),
    expectedResult: { kind: 'accepted' },
    invoke: () =>
      dispatchUserDataExport({ exportId: 'bounded-export', generation: 3, kiloUserId: userId }),
  },
  {
    name: 'user-data export download',
    audience: USER_DATA_EXPORT_AUDIENCE,
    legacyAudience: true,
    url: `${mockConfig.exportWorkerUrl}/internal/exports/download`,
    body: { version: 1, exportId: 'bounded-export' },
    headers: { 'x-internal-api-key': mockConfig.internalApiSecret },
    response: () =>
      jsonResponse({
        downloadUrl: 'https://downloads.example.test/bounded-export.zip',
        expiresAt: '2026-01-02T03:04:05.000Z',
      }),
    expectedResult: {
      kind: 'available',
      downloadUrl: 'https://downloads.example.test/bounded-export.zip',
      expiresAt: '2026-01-02T03:04:05.000Z',
    },
    invoke: () => requestUserDataExportDownload({ exportId: 'bounded-export', kiloUserId: userId }),
  },
];

describe('bounded Worker assertions', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    __resetGitHubUserAccessTokenClientForTests();
    if (originalBoundedTokenFlag === undefined) {
      delete process.env[boundedTokenFlag];
    } else {
      process.env[boundedTokenFlag] = originalBoundedTokenFlag;
    }
  });

  it.each(operations)(
    '$name preserves its request contract while toggling bounded assertions',
    async operation => {
      for (const enabled of [false, true]) {
        if (enabled) {
          process.env[boundedTokenFlag] = 'true';
        } else {
          delete process.env[boundedTokenFlag];
        }

        const fetchMock = jest
          .spyOn(global, 'fetch')
          .mockImplementation(async () => operation.response());

        const result = await operation.invoke();
        expect(result).toEqual(operation.expectedResult);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [input, init] = fetchMock.mock.calls[0] ?? [];
        expect(String(input)).toBe(operation.url);
        expect(init?.method).toBe('POST');
        if (operation.body === undefined) {
          expect(init?.body).toBeUndefined();
        } else {
          expect(JSON.parse(String(init?.body))).toEqual(operation.body);
        }
        for (const [name, value] of Object.entries(operation.headers ?? {})) {
          expect(new Headers(init?.headers).get(name)).toBe(value);
        }

        const token = authorizationFrom(init);
        const claims = jwt.verify(token, NEXTAUTH_SECRET, { algorithms: ['HS256'] });
        if (
          typeof claims === 'string' ||
          typeof claims.exp !== 'number' ||
          typeof claims.iat !== 'number'
        ) {
          throw new Error('Expected an object payload with numeric token timestamps');
        }
        expect(claims.kiloUserId).toBe(userId);
        expect(claims.exp - claims.iat).toBe(300);
        expect(claims.apiTokenPepper).toBeUndefined();
        expect(claims.env).toBeUndefined();
        expect(claims.organizationId).toBe(operation.organizationId);

        if (enabled) {
          expect(claims).toMatchObject({
            aud: operation.audience,
            tokenPurpose: 'internal-service',
            credentialExchange: false,
          });
          await expect(
            verifyKiloTokenForResource(token, NEXTAUTH_SECRET, {
              audience: operation.audience,
              mode: 'required',
            })
          ).resolves.toMatchObject({ kiloUserId: userId });
          const auth = await verifyKiloTokenForPolicy(token, NEXTAUTH_SECRET, {
            audience: operation.audience,
            mode: 'required',
          });
          expect(isKiloCredentialExchangeEligible(auth, { legacy: 'five-year-api' })).toBe(false);
          for (const otherAudience of ['kilo-api', 'kilo-gateway']) {
            await expect(
              verifyKiloTokenForResource(token, NEXTAUTH_SECRET, {
                audience: otherAudience,
                mode: 'allow-legacy',
              })
            ).rejects.toThrow();
          }
        } else {
          expect(claims.tokenPurpose).toBeUndefined();
          expect(claims.credentialExchange).toBeUndefined();
          if (operation.legacyAudience) {
            expect(claims.aud).toBe(operation.audience);
            await expect(
              verifyKiloToken(token, NEXTAUTH_SECRET, { audience: operation.audience })
            ).resolves.toMatchObject({ kiloUserId: userId });
          } else {
            expect(claims.aud).toBeUndefined();
            await expect(
              verifyKiloTokenForResource(token, NEXTAUTH_SECRET, {
                audience: operation.audience,
                mode: 'allow-legacy',
              })
            ).resolves.toMatchObject({ kiloUserId: userId });
          }
        }

        fetchMock.mockRestore();
      }
    }
  );
});
