jest.mock('@/lib/integrations/gitlab-service', () => ({ getGitLabIntegration: jest.fn() }));
jest.mock('@/lib/integrations/platforms/gitlab/credential-broker-client', () => ({
  fetchGitLabCredential: jest.fn(),
}));

import type { PlatformIntegration } from '@kilocode/db/schema';
import type {
  OwnerIntegrationAuthorization,
  RepositoryIdentity,
} from '@kilocode/app-shared/code-review/repository-identity';
import { getGitLabIntegration } from '@/lib/integrations/gitlab-service';
import { fetchGitLabCredential } from '@/lib/integrations/platforms/gitlab/credential-broker-client';
import { authorizeGitLabReview, resolveGitLabReviewProject } from './gitlab-authorization';

const instanceUrl = 'https://gitlab.com/GitLab';
const integrationId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
const userId = 'oauth/current-user';
const authorization: OwnerIntegrationAuthorization = {
  kind: 'ownerIntegration',
  owner: { type: 'user', id: userId },
  integrationId,
};
const repository: RepositoryIdentity = {
  provider: 'gitlab',
  instanceUrl,
  repositoryId: '123',
  fullName: 'Group/Sub/Repo',
  defaultBranch: null,
};
const project = {
  id: 123,
  path_with_namespace: repository.fullName,
  web_url: `${instanceUrl}/${repository.fullName}`,
  default_branch: 'release/next',
};
const broker = jest.mocked(fetchGitLabCredential);
const integrationLookup = jest.mocked(getGitLabIntegration);
let integration: PlatformIntegration;
let providerRequests: string[];

beforeEach(() => {
  jest.resetAllMocks();
  integration = {
    id: integrationId,
    platform: 'gitlab',
    owned_by_user_id: userId,
    owned_by_organization_id: null,
    integration_type: 'oauth',
    integration_status: 'active',
    suspended_at: null,
    auth_invalid_at: null,
    metadata: { gitlab_instance_url: instanceUrl },
    scopes: ['api'],
    platform_account_login: 'stale-name',
  } as PlatformIntegration;
  integrationLookup.mockImplementation(async (owner, selected) =>
    selected === integrationId &&
    (owner.type === 'user'
      ? owner.id === integration.owned_by_user_id
      : owner.id === integration.owned_by_organization_id)
      ? integration
      : null
  );
  broker.mockImplementation(async (actor, selector) => {
    const allowedOwner =
      integration.owned_by_organization_id === null
        ? actor.organizationId === undefined
        : actor.organizationId === integration.owned_by_organization_id;
    return actor.userId === userId && allowedOwner && selector.integrationId === integrationId
      ? {
          status: 'available',
          token: selector.credential === 'project-exact' ? 'project-secret' : 'integration-secret',
          instanceUrl,
          glabIsOAuth2: true,
        }
      : { status: 'not_connected' };
  });
  providerRequests = [];
  global.fetch = jest.fn(async (destination, init) => {
    const path = new URL(String(destination)).pathname;
    providerRequests.push(path);
    if (path.endsWith('/user'))
      return Response.json({
        id: new Headers(init?.headers).get('authorization') === 'Bearer project-secret' ? 24 : 9,
        username: 'actual-provider-actor',
        name: 'Provider Actor',
      });
    if (path.endsWith('/projects/123')) return Response.json(project);
    return Response.json({}, { status: 404 });
  });
});

it.each(['user', 'org'] as const)(
  'AC4 resolves the exact %s owner and actual provider actor',
  async type => {
    if (type === 'org') {
      integration.owned_by_user_id = null;
      integration.owned_by_organization_id = orgId;
    }
    const selected = { ...authorization, owner: { type, id: type === 'org' ? orgId : userId } };
    const auth = await authorizeGitLabReview({ userId, authorization: selected, instanceUrl });
    const resolved = await resolveGitLabReviewProject(auth, '123', repository);
    expect(auth).toMatchObject({
      authorization: selected,
      actor: { id: '9', login: 'actual-provider-actor', instanceUrl },
      credentialKind: 'gitlabOAuth',
    });
    expect(resolved.repository).toEqual({ ...repository, defaultBranch: 'release/next' });
    expect(resolved.canonicalUrl).toBe(`${instanceUrl}/Group/Sub/Repo`);
    expect(JSON.stringify(auth)).not.toContain('secret');
  }
);

it('AC4 rejects another Personal owner before provider access', async () => {
  await expect(
    authorizeGitLabReview({
      userId,
      authorization: { ...authorization, owner: { type: 'user', id: 'other' } },
      instanceUrl,
    })
  ).rejects.toMatchObject({ code: 'forbidden' });
  expect(providerRequests).toEqual([]);
});
it('AC4 never resolves a Personal integration through organization authorization', async () => {
  await expect(
    authorizeGitLabReview({
      userId,
      authorization: { ...authorization, owner: { type: 'org', id: orgId } },
      instanceUrl,
    })
  ).rejects.toMatchObject({ code: 'not_connected' });
  expect(providerRequests).toEqual([]);
});
it('AC4 rejects a non-member even when an organization integration exists', async () => {
  integration.owned_by_user_id = null;
  integration.owned_by_organization_id = orgId;
  await expect(
    authorizeGitLabReview({
      userId: 'non-member',
      authorization: { ...authorization, owner: { type: 'org', id: orgId } },
      instanceUrl,
    })
  ).rejects.toMatchObject({ code: 'not_connected' });
  expect(providerRequests).toEqual([]);
});
it.each(['not_connected', 'reconnect_required', 'temporarily_unavailable'] as const)(
  'AC4 preserves broker recovery %s without a provider call',
  async status => {
    broker.mockResolvedValue({ status });
    await expect(
      authorizeGitLabReview({ userId, authorization, instanceUrl })
    ).rejects.toMatchObject({ code: status });
    expect(providerRequests).toEqual([]);
  }
);
it.each([
  { integration_status: 'suspended' },
  { auth_invalid_at: '2026-08-29 01:16:12.945+00' },
  { suspended_at: '2026-08-29 01:16:12.945+00' },
])('AC4 rejects inactive or expired integration state: %j', async change => {
  Object.assign(integration, change);
  await expect(authorizeGitLabReview({ userId, authorization, instanceUrl })).rejects.toMatchObject(
    { code: 'reconnect_required' }
  );
  expect(providerRequests).toEqual([]);
});
it.each(['https://gitlab.com', 'https://gitlab.com/other', 'https://other.example/GitLab'])(
  'AC4 rejects the wrong configured instance %s',
  async wrongInstance => {
    await expect(
      authorizeGitLabReview({ userId, authorization, instanceUrl: wrongInstance })
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(providerRequests).toEqual([]);
  }
);
it.each([{ repositoryId: '124' }, { fullName: 'Other/Sub/Repo' }, { provider: 'github' as const }])(
  'AC4 rejects a changed repository identity: %j',
  async change => {
    const auth = await authorizeGitLabReview({ userId, authorization, instanceUrl });
    await expect(
      resolveGitLabReviewProject(auth, '123', { ...repository, ...change })
    ).rejects.toMatchObject({ code: change.fullName ? 'not_found' : 'forbidden' });
  }
);
it('AC4 labels an explicitly selected project actor without borrowing integration grants', async () => {
  const auth = await authorizeGitLabReview({
    userId,
    authorization,
    instanceUrl,
    projectTokenId: '123',
  });
  expect(auth).toMatchObject({
    actor: { id: '24' },
    credentialKind: 'gitlabProjectToken',
    scopes: null,
  });
  await expect(resolveGitLabReviewProject(auth, '123', repository)).resolves.toMatchObject({
    repository: { ...repository, defaultBranch: 'release/next' },
  });
  await expect(resolveGitLabReviewProject(auth, '124')).rejects.toMatchObject({
    code: 'forbidden',
  });
  expect(providerRequests).not.toContain('/GitLab/api/v4/projects/124');
});
it('AC4 retains PAT and read-only grant identity', async () => {
  integration.integration_type = 'pat';
  integration.scopes = ['read_api'];
  const auth = await authorizeGitLabReview({ userId, authorization, instanceUrl });
  expect(auth).toMatchObject({
    credentialKind: 'gitlabPat',
    scopes: ['read_api'],
    actor: { id: '9' },
  });
});
it('AC4 maps provider token expiry to reconnect without exposing response text', async () => {
  global.fetch = jest.fn(async () =>
    Response.json({ message: 'integration-secret' }, { status: 401 })
  );
  const failure = await authorizeGitLabReview({ userId, authorization, instanceUrl }).catch(
    (error: unknown) => error
  );
  expect(failure).toMatchObject({ code: 'reconnect_required' });
  expect(JSON.stringify(failure)).not.toContain('secret');
});
it.each(['http://gitlab.com/GitLab', 'https://user:secret@gitlab.com/GitLab', 'not a URL'])(
  'AC4 rejects unsafe requested instances: %s',
  async unsafe => {
    await expect(
      authorizeGitLabReview({ userId, authorization, instanceUrl: unsafe })
    ).rejects.toMatchObject({ code: 'unsafe_url' });
    expect(providerRequests).toEqual([]);
  }
);
it('AC4 rejects a changed live project ID and a foreign canonical URL', async () => {
  const auth = await authorizeGitLabReview({ userId, authorization, instanceUrl });
  for (const change of [{ id: 124 }, { web_url: 'https://other.example/Group/Sub/Repo' }]) {
    global.fetch = jest.fn(async () => Response.json({ ...project, ...change }));
    await expect(resolveGitLabReviewProject(auth, '123', repository)).rejects.toMatchObject({
      code: 'not_found',
    });
  }
});
it('AC4 rejects an integration pin instead of choosing another connection', async () => {
  await expect(
    authorizeGitLabReview({
      userId,
      authorization: { ...authorization, integrationId: '33333333-3333-4333-8333-333333333333' },
      instanceUrl,
    })
  ).rejects.toMatchObject({ code: 'not_connected' });
  expect(providerRequests).toEqual([]);
});
