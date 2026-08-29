import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { toolDefinitions } from '@kilocode/agent-harness/tools';
import { SummaryOutputSchema, type UsageAnalyticsFilters } from '@/routers/usage-analytics-schemas';
import type { HarnessCapabilityScope } from './authorization';
import type * as Reads from './kilo-reads';

const conversationId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const org = '33333333-3333-4333-8333-333333333333';
const parent = '44444444-4444-4444-8444-444444444444';
const user = { id: 'oauth/github:reader' };
const member = { id: user.id, email: 'reader@example.com', role: 'member' };
const pending = { email: 'pending@example.com', role: 'member' };
type Context = { user: typeof user };
type RepositoryInput = { organizationId?: string; forceRefresh?: boolean; bounded?: boolean };
type RepositoryProvider = 'github' | 'gitlab';
type RepositoryState = {
  status?: string;
  integrationInstalled: boolean;
  errorMessage?: string;
};
let organizationId: string | null;
let revoked: boolean;
let billing: boolean;
let empty: boolean;
let copies: number;
let title: string;
let sourceError: Error | undefined;
let providers: Record<RepositoryProvider, RepositoryState>;
let bitbucketStatus: string;
let directMembership: boolean;
let additionalOrganizationCount: number;
const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const rows = <T>(values: T[]) => (empty ? [] : Array.from({ length: copies }, () => values).flat());

function guard(ctx: Context, scope: string | null | undefined) {
  if (ctx.user.id !== user.id || scope !== organizationId)
    throw new TRPCError({ code: 'FORBIDDEN' });
  if (sourceError) {
    const error = sourceError;
    sourceError = undefined;
    throw error;
  }
}
function repositoryCaller(ctx: Context, organization: boolean) {
  const check = (input: RepositoryInput) => {
    guard(ctx, organization ? input.organizationId : null);
    if (input.forceRefresh) throw new Error('Unexpected forced provider refresh');
    if (input.bounded !== true) throw new Error('Unbounded repository read');
  };
  const list = (input: RepositoryInput, provider: RepositoryProvider, id: number) => {
    check(input);
    const state = providers[provider];
    return {
      ...state,
      repositories: state.status === 'available' ? rows([{ id, fullName: title }]) : [],
    };
  };
  return {
    listGitHubRepositories: (input: RepositoryInput) => list(input, 'github', 7),
    listGitLabRepositories: (input: RepositoryInput) => list(input, 'gitlab', 8),
    listBitbucketRepositories: (input: RepositoryInput) => {
      check(input);
      return bitbucketStatus === 'available'
        ? {
            status: bitbucketStatus,
            repositories: rows([{ id: operationId, fullName: title }]),
            syncedAt: '2026-08-29T10:00:00.000Z',
          }
        : { status: bitbucketStatus };
    },
  };
}
jest.mock('./authorization', () => ({
  harnessInputDigest: digest,
  authorizeHarnessCapability: async (token: string, scope: HarnessCapabilityScope) => {
    if (
      revoked ||
      token !== scope.operation ||
      scope.conversationId !== conversationId ||
      scope.dispatchId !== operationId ||
      scope.audience !== 'agent-harness:operations' ||
      scope.definitionVersion !== '1' ||
      scope.target.kind !== 'backend' ||
      scope.inputDigest !== digest({})
    ) {
      throw new TRPCError({ code: 'FORBIDDEN' });
    }
    return { ctx: { user }, authority: { organizationId } };
  },
}));
jest.mock('@/routers/root-router', () => ({
  rootRouter: {
    createCaller: (ctx: Context) => ({
      cloudAgentNext: repositoryCaller(ctx, false),
      organizations: {
        cloudAgentNext: repositoryCaller(ctx, true),
        list: () => {
          guard(ctx, organizationId);
          return rows([
            {
              organizationId: parent,
              organizationName: 'Parent',
              inheritedChildren: [{ organizationId: org, organizationName: title }],
              secret: 'secret-sentinel',
            },
            ...(directMembership
              ? [{ organizationId: org, organizationName: title, inheritedChildren: [] }]
              : []),
            ...Array.from({ length: additionalOrganizationCount }, (_, index) => ({
              organizationId: `organization-${index}`,
              organizationName: `Organization ${index}`,
              inheritedChildren: [],
            })),
          ]);
        },
        members: {
          listPublic: (input: { organizationId: string }) => {
            guard(ctx, input.organizationId);
            return rows([
              { ...member, status: 'active', currentDailyUsageUsd: 99 },
              {
                ...pending,
                status: 'invited',
                inviteToken: 'secret-sentinel',
                inviteUrl: 'https://example.com/secret-sentinel',
              },
            ]);
          },
        },
      },
      usageAnalytics: {
        getSummary: (input: UsageAnalyticsFilters) => {
          guard(ctx, input.organizationId ?? null);
          if (input.organizationId && input.viewAs === 'org-wide' && !billing)
            throw new TRPCError({ code: 'UNAUTHORIZED' });
          const totals = Object.fromEntries(
            Object.keys(SummaryOutputSchema.shape).map(key => [
              key,
              key === 'effectiveGranularity' ? 'day' : 0,
            ])
          );
          const count = input.organizationId
            ? input.viewAs === 'org-wide'
              ? 7
              : 3
            : input.personalScope === 'personal-only' && input.viewAs === 'self'
              ? 2
              : 999;
          return { ...totals, requestCount: empty ? 0 : count, secret: 'secret-sentinel' };
        },
      },
    }),
  },
}));
// Register mocks before loading server modules; the repository transformer does not hoist them.
const { executeHarnessRead } = jest.requireActual<typeof Reads>('./kilo-reads');
const read = (name: string, args: unknown = {}) =>
  executeHarnessRead(name, { conversationId, operationId, name, arguments: args });
const definitions = toolDefinitions.filter(
  tool => tool.group === 'kilo' && tool.effect === 'read' && !tool.name.startsWith('kilo.sessions.')
);

beforeEach(() => {
  organizationId = org;
  revoked = false;
  billing = true;
  empty = false;
  copies = 1;
  title = 'allowed/repo';
  providers = {
    github: { status: 'available', integrationInstalled: true },
    gitlab: { status: 'available', integrationInstalled: true },
  };
  bitbucketStatus = 'available';
  directMembership = false;
  additionalOrganizationCount = 0;
  sourceError = undefined;
  jest.useFakeTimers({ now: new Date('2026-08-29T10:00:00Z') });
});
afterEach(() => jest.useRealTimers());

describe.each(definitions)('$name authorized read', ({ name }) => {
  const expected = (scope: string | null = org) => {
    const results = {
      'kilo.organizations': [
        ...(scope === null ? [{ id: parent, name: 'Parent' }] : []),
        { id: org, name: 'allowed/repo' },
      ],
      'kilo.members': [member, { id: 'pending@example.com', ...pending }],
      'kilo.repositories': [
        { id: 'github:7', name: 'allowed/repo' },
        { id: 'gitlab:8', name: 'allowed/repo' },
        ...(scope === null ? [] : [{ id: `bitbucket:${operationId}`, name: 'allowed/repo' }]),
      ],
      'kilo.usage': expect.objectContaining({
        requestCount: scope === null ? 2 : 7,
        startDate: '2026-07-30T10:00:00.000Z',
        endDate: '2026-08-29T10:00:00.000Z',
      }),
    };
    return results[name as keyof typeof results];
  };
  it.each([null, org])('reads only the grant scope %s', async scope => {
    organizationId = scope;
    if (name === 'kilo.members' && scope === null) {
      await expect(read(name)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      return;
    }
    const result = await read(name);
    expect(result).toEqual(expected(scope));
    expect(JSON.stringify(result)).not.toContain('secret-sentinel');
  });
  it('denies removed access instead of reusing an earlier result', async () => {
    await read(name);
    revoked = true;
    await expect(read(name)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('keeps the billing role restriction specific to organization usage', async () => {
    billing = false;
    if (name === 'kilo.usage')
      await expect(read(name)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    else await expect(read(name)).resolves.toEqual(expected());
  });
  it('preserves an authorized empty result', async () => {
    empty = true;
    expect(await read(name)).toEqual(
      name === 'kilo.usage' ? expect.objectContaining({ requestCount: 0, costMicrodollars: 0 }) : []
    );
  });
  it.each(['SERVICE_UNAVAILABLE', 'PRECONDITION_FAILED'] as const)(
    'preserves %s instead of returning empty data',
    async code => {
      sourceError = new TRPCError({ code });
      await expect(read(name)).rejects.toMatchObject({ code });
      if (code === 'SERVICE_UNAVAILABLE') await expect(read(name)).resolves.toEqual(expected());
    }
  );
  it.each([
    ['organizationId', parent],
    ['actorUserId', 'oauth/github:other'],
    ['userIds', [user.id]],
    ['viewAs', 'org-wide'],
    ['personalScope', 'include-orgs'],
    ['path', 'organizations.members.listPublic'],
    ['cursor', 'next-page'],
    ['limit', 51],
    ['bounded', true],
    ['forceRefresh', true],
    ['signal', {}],
  ] as const)('rejects model-supplied %s', async (field, value) => {
    await expect(read(name, { [field]: value })).rejects.toBeInstanceOf(z.ZodError);
  });
});
it.each(['organizations.members.listPublic', 'getOrganizationMembers', 'kilo.invite'])(
  'rejects an unregistered read %s',
  async name => {
    await expect(read(name)).rejects.toBeInstanceOf(z.ZodError);
  }
);
it('rejects authority supplied outside the tool arguments', async () => {
  await expect(
    executeHarnessRead('kilo.members', {
      conversationId,
      operationId,
      name: 'kilo.members',
      arguments: {},
      organizationId: parent,
    })
  ).rejects.toBeInstanceOf(z.ZodError);
});
it.each([null, org])('deduplicates direct and inherited organizations in %s', async scope => {
  organizationId = scope;
  directMembership = true;
  copies = 51;
  await expect(read('kilo.organizations')).resolves.toEqual([
    ...(scope === null ? [{ id: parent, name: 'Parent' }] : []),
    { id: org, name: 'allowed/repo' },
  ]);
});
it.each(['kilo.organizations', 'kilo.members', 'kilo.repositories'])(
  'bounds %s to one page',
  async name => {
    copies = 51;
    if (name === 'kilo.organizations') {
      organizationId = null;
      directMembership = true;
      additionalOrganizationCount = 49;
    }
    const result = await read(name);
    expect(result).toHaveLength(50);
    if (name === 'kilo.organizations') {
      expect(result).toContainEqual({ id: 'organization-47', name: 'Organization 47' });
      expect(result).not.toContainEqual({ id: 'organization-48', name: 'Organization 48' });
    }
  }
);
it('enforces the UTF-8 byte limit rather than a character limit', async () => {
  title = '界'.repeat(23_000);
  await expect(read('kilo.organizations')).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
});
it('rejects an invalid resource instead of fabricating its name', async () => {
  title = '';
  await expect(read('kilo.repositories')).rejects.toBeInstanceOf(z.ZodError);
});
it.each([
  ['temporarily_unavailable', 'SERVICE_UNAVAILABLE'],
  ['insufficient_permissions', 'FORBIDDEN'],
  ['invalid_request', 'BAD_REQUEST'],
  ['reconnect_required', 'PRECONDITION_FAILED'],
  ['workspace_selection_required', 'PRECONDITION_FAILED'],
])('preserves the Bitbucket %s state after filling the page', async (status, code) => {
  bitbucketStatus = status;
  copies = 51;
  await expect(read('kilo.repositories')).rejects.toMatchObject({
    code,
    message: `Bitbucket repositories: ${status}`,
  });
});
it.each([null, org])('reports no available repository integration in %s', async scope => {
  organizationId = scope;
  providers = {
    github: { status: 'not_connected', integrationInstalled: false },
    gitlab: { status: 'not_connected', integrationInstalled: false },
  };
  bitbucketStatus = 'not_connected';
  await expect(read('kilo.repositories')).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'No repository integration is available in this context',
  });
});
it('does not expose a provider error or report partial repositories as success', async () => {
  providers.github.errorMessage = 'secret-sentinel';
  await expect(read('kilo.repositories')).rejects.toMatchObject({
    code: 'SERVICE_UNAVAILABLE',
    message: 'Repository integration read failed',
  });
});

describe.each([null, org])('repository states in %s', scope => {
  beforeEach(() => {
    organizationId = scope;
  });
  describe.each(['github', 'gitlab'] as const)('%s', provider => {
    it.each([false, true])('preserves one available provider with empty=%s', async isEmpty => {
      providers = {
        github: { status: 'not_connected', integrationInstalled: false },
        gitlab: { status: 'not_connected', integrationInstalled: false },
      };
      providers[provider] = { status: 'available', integrationInstalled: true };
      bitbucketStatus = 'not_connected';
      empty = isEmpty;
      await expect(read('kilo.repositories')).resolves.toEqual(
        isEmpty
          ? []
          : [{ id: provider === 'github' ? 'github:7' : 'gitlab:8', name: 'allowed/repo' }]
      );
    });
    it.each([
      ['temporarily_unavailable', 'SERVICE_UNAVAILABLE'],
      ['suspended', 'PRECONDITION_FAILED'],
      ['reconnect_required', 'PRECONDITION_FAILED'],
      ['misconfigured', 'PRECONDITION_FAILED'],
      ['integration_limit_exceeded', 'PAYLOAD_TOO_LARGE'],
    ])('preserves %s instead of partial success', async (status, code) => {
      providers[provider] = { status, integrationInstalled: true };
      copies = 51;
      await expect(read('kilo.repositories')).rejects.toMatchObject({
        code,
        message: `${provider} repositories: ${status}`,
      });
    });
    it.each(['resources', 'empty', 'absent'])(
      'does not hide unavailable integrationInstalled:false behind %s siblings',
      async sibling => {
        empty = sibling === 'empty';
        if (sibling === 'absent') {
          providers = {
            github: { status: 'not_connected', integrationInstalled: false },
            gitlab: { status: 'not_connected', integrationInstalled: false },
          };
          bitbucketStatus = 'not_connected';
        }
        providers[provider] = {
          status: 'suspended',
          integrationInstalled: false,
          errorMessage: 'secret-sentinel',
        };
        await expect(read('kilo.repositories')).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: `${provider} repositories: suspended`,
        });
      }
    );
    it.each([undefined, 'secret-sentinel'])(
      'rejects a missing bounded status with errorMessage=%s',
      async errorMessage => {
        providers[provider] = { integrationInstalled: false, errorMessage };
        await expect(read('kilo.repositories')).rejects.toMatchObject({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Repository integration read failed',
        });
      }
    );
  });
  it('uses Bitbucket only in an organization conversation', async () => {
    providers = {
      github: { status: 'not_connected', integrationInstalled: false },
      gitlab: { status: 'not_connected', integrationInstalled: false },
    };
    if (scope === null) {
      await expect(read('kilo.repositories')).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    } else {
      await expect(read('kilo.repositories')).resolves.toEqual([
        { id: `bitbucket:${operationId}`, name: 'allowed/repo' },
      ]);
    }
  });
});
