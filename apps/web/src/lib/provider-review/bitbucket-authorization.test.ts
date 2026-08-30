jest.mock('@/lib/config.server', () => ({ GIT_TOKEN_SERVICE_API_URL: 'https://broker.example' }));
jest.mock('@/lib/tokens', () => ({
  generateInternalServiceToken: () => 'internal-fixture',
  TOKEN_EXPIRY: { fiveMinutes: '5m' },
}));

import type {
  OwnerIntegrationAuthorization,
  RepositoryIdentity,
} from '@kilocode/app-shared/code-review/repository-identity';
import type { BitbucketInteractiveMetadata } from '@/lib/integrations/platforms/bitbucket/interactive-client';
import { authorizeBitbucketReview } from './bitbucket-authorization';

const authorization: OwnerIntegrationAuthorization = {
  kind: 'ownerIntegration',
  owner: { type: 'org', id: '11111111-1111-4111-8111-111111111111' },
  integrationId: '22222222-2222-4222-8222-222222222222',
};
const repository: RepositoryIdentity = {
  provider: 'bitbucket',
  instanceUrl: 'https://bitbucket.org',
  workspaceUuid: '33333333-3333-4333-8333-333333333333',
  repositoryId: '44444444-4444-4444-8444-444444444444',
  fullName: 'team/repo',
  defaultBranch: null,
};
const providerRepository = {
  uuid: `{${repository.repositoryId}}`,
  full_name: repository.fullName,
  workspace: { uuid: `{${repository.workspaceUuid}}`, slug: 'team' },
  mainbranch: { name: 'trunk' },
};
const userId = 'oauth/kilo-user';
const input = { userId, authorization, repository };
let metadata: BitbucketInteractiveMetadata;
let data: unknown;
let failure: string | undefined;
let calls: number;
const originalFetch = global.fetch;

beforeEach(() => {
  metadata = {
    actorUserId: userId,
    organizationId: authorization.owner.id,
    integrationId: authorization.integrationId,
    instanceUrl: 'https://bitbucket.org',
    providerActor: {
      credentialKind: 'bitbucketWorkspaceToken',
      workspaceUuid: repository.workspaceUuid!,
      workspaceSlug: 'team',
    },
    grants: { scopes: ['repository', 'repository:write', 'pullrequest'] },
  };
  data = structuredClone(providerRepository);
  failure = undefined;
  calls = 0;
  global.fetch = jest.fn(async (url, init) => {
    calls++;
    if (
      String(url) !== 'https://broker.example/internal/bitbucket/interactive-review' ||
      new Headers(init?.headers).get('authorization') !== 'Bearer internal-fixture'
    )
      return Response.json({}, { status: 403 });
    const target = JSON.parse(String(init?.body));
    if (target.integrationId !== authorization.integrationId)
      return Response.json({ success: false, reason: 'integration_mismatch' });
    if (target.workspaceUuid !== repository.workspaceUuid || target.workspaceSlug !== 'team')
      return Response.json({ success: false, reason: 'workspace_mismatch' });
    if (
      target.repositoryUuid !== repository.repositoryId ||
      target.repositoryFullName !== repository.fullName
    )
      return Response.json({ success: false, reason: 'repository_mismatch' });
    return Response.json(
      failure
        ? { success: false, reason: failure }
        : { success: true, result: { status: 200, data }, metadata }
    );
  });
});
afterEach(() => {
  global.fetch = originalFetch;
});

it.each(['bitbucketOAuth', 'bitbucketWorkspaceToken'] as const)(
  'AC4 authorizes %s without exporting credentials or impersonating the Kilo user',
  async credentialKind => {
    if (credentialKind === 'bitbucketOAuth')
      metadata.providerActor = {
        credentialKind,
        actor: {
          provider: 'bitbucket',
          instanceUrl: 'https://bitbucket.org',
          id: '{55555555-5555-4555-8555-555555555555}',
          login: 'actual-actor',
          displayName: null,
          avatarUrl: null,
        },
      };
    const auth = await authorizeBitbucketReview(input);
    expect(auth.repository).toEqual({ ...repository, defaultBranch: 'trunk' });
    expect(auth.actor).toMatchObject(
      credentialKind === 'bitbucketOAuth'
        ? { id: '55555555-5555-4555-8555-555555555555', login: 'actual-actor' }
        : { id: `workspace:${repository.workspaceUuid}`, login: null, displayName: 'team' }
    );
    expect(auth.credentialKind).toBe(credentialKind);
    expect(auth.scopes).not.toContain('pullrequest:write');
    expect(JSON.stringify(auth)).not.toContain('internal-fixture');
    expect(auth.actor.id).not.toBe(userId);
  }
);
it('AC4 keeps an unavailable default branch null', async () => {
  data = { ...providerRepository, mainbranch: null };
  expect((await authorizeBitbucketReview(input)).repository.defaultBranch).toBeNull();
});
it.each([
  { userId: '' },
  { authorization: { ...authorization, owner: { type: 'user', id: userId } } },
  { authorization: { ...authorization, integrationId: '' } },
  { repository: { ...repository, provider: 'gitlab' } },
  { repository: { ...repository, instanceUrl: 'https://other.example' } },
  { repository: { ...repository, workspaceUuid: '{33333333-3333-4333-8333-333333333333}' } },
  { repository: { ...repository, fullName: 'team/../repo' } },
  { repository: { ...repository, fullName: 'team/repo%2Fother' } },
])('AC4 rejects invalid caller identity before accessing the broker: %j', async change => {
  await expect(
    authorizeBitbucketReview({ ...input, ...change } as typeof input)
  ).rejects.toMatchObject({ code: 'invalid_request' });
  expect(calls).toBe(0);
});
it.each([
  ['integrationId', '66666666-6666-4666-8666-666666666666', 'integration_mismatch'],
  ['workspaceUuid', '66666666-6666-4666-8666-666666666666', 'workspace_mismatch'],
  ['repositoryId', '66666666-6666-4666-8666-666666666666', 'repository_mismatch'],
  ['fullName', 'team/replacement', 'repository_mismatch'],
])(
  'AC4 retains the exact %s selector instead of selecting a replacement',
  async (field, value, code) => {
    const selected =
      field === 'integrationId'
        ? { ...input, authorization: { ...authorization, integrationId: value } }
        : { ...input, repository: { ...repository, [field]: value } };
    await expect(authorizeBitbucketReview(selected)).rejects.toMatchObject({ code });
  }
);
it.each([
  'not_connected',
  'reconnect_required',
  'insufficient_permissions',
  'authentication_rejected',
  'provider_unavailable',
  'rate_limited',
  'temporarily_unavailable',
])('AC4 preserves sanitized broker failure %s without retry or data', async reason => {
  failure = reason;
  const error = await authorizeBitbucketReview(input).catch((error: unknown) => error);
  expect(error).toMatchObject({ code: reason, message: reason });
  expect(error).not.toHaveProperty('data');
  expect(error).not.toHaveProperty('cause');
  expect(JSON.stringify(error)).not.toContain('internal-fixture');
  expect(calls).toBe(1);
});
it.each(['actorUserId', 'organizationId', 'integrationId'] as const)(
  'AC4 rejects mismatched broker metadata %s',
  async field => {
    metadata[field] = 'another-identity';
    await expect(authorizeBitbucketReview(input)).rejects.toMatchObject({
      code: 'integration_mismatch',
    });
  }
);
it.each(['workspaceUuid', 'workspaceSlug'] as const)(
  'AC4 rejects a workspace principal with another %s',
  async field => {
    metadata.providerActor = {
      credentialKind: 'bitbucketWorkspaceToken',
      workspaceUuid: repository.workspaceUuid!,
      workspaceSlug: 'team',
      [field]: field === 'workspaceUuid' ? '66666666-6666-4666-8666-666666666666' : 'other',
    };
    await expect(authorizeBitbucketReview(input)).rejects.toMatchObject({
      code: 'workspace_mismatch',
    });
  }
);
it.each([
  { uuid: '{66666666-6666-4666-8666-666666666666}' },
  { full_name: 'team/replacement' },
  { workspace: { uuid: '{66666666-6666-4666-8666-666666666666}', slug: 'team' } },
])('AC4 rejects live UUID and name collisions: %j', async change => {
  data = { ...providerRepository, ...change };
  await expect(authorizeBitbucketReview(input)).rejects.toMatchObject({
    code: 'workspace' in change ? 'workspace_mismatch' : 'repository_mismatch',
  });
});
it.each(['grant', 'actor', 'revoked'] as const)(
  'AC4 rechecks %s identity on every operation',
  async change => {
    const auth = await authorizeBitbucketReview(input);
    if (change === 'grant') metadata.grants.scopes.push('pullrequest:write');
    if (change === 'actor')
      metadata.providerActor = {
        credentialKind: 'bitbucketOAuth',
        actor: {
          provider: 'bitbucket',
          instanceUrl: 'https://bitbucket.org',
          id: 'another-actor',
          login: null,
          displayName: null,
          avatarUrl: null,
        },
      };
    if (change === 'revoked') failure = 'not_connected';
    await expect(
      auth.client.execute({ operation: 'repository', params: { path: auth.path } })
    ).rejects.toMatchObject({
      code: change === 'revoked' ? 'not_connected' : 'reconnect_required',
    });
  }
);
it('AC4 ignores grant ordering while keeping read-only grants intact', async () => {
  const auth = await authorizeBitbucketReview(input);
  metadata.grants.scopes.reverse();
  await expect(
    auth.client.execute({ operation: 'repository', params: { path: auth.path } })
  ).resolves.toMatchObject({ data: { full_name: 'team/repo' } });
});
it('AC4 rejects another organization even when the repository names match', async () => {
  await expect(
    authorizeBitbucketReview({
      ...input,
      authorization: {
        ...authorization,
        owner: { type: 'org', id: '99999999-9999-4999-8999-999999999999' },
      },
    })
  ).rejects.toMatchObject({ code: 'integration_mismatch' });
});
it('AC4 rejects credential-bearing metadata without including the secret in its error', async () => {
  Object.assign(metadata, { accessToken: 'provider-secret' });
  const error = await authorizeBitbucketReview(input).catch((error: unknown) => error);
  expect(error).toMatchObject({ code: 'invalid_response' });
  expect(JSON.stringify(error)).not.toContain('provider-secret');
});
