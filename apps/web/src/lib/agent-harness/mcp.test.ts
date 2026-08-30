import { beforeEach, expect, it, jest } from '@jest/globals';
import { GatewayError } from '@kilocode/mcp-gateway';
import { TRPCError } from '@trpc/server';
import type * as McpModule from './mcp';

const invocation = {
  conversationId: '11111111-1111-4111-8111-111111111111',
  operationId: '22222222-2222-4222-8222-222222222222',
  request: { name: 'mcp.discover', arguments: {} },
};
let organizationId: string | null,
  unavailable: boolean,
  denied: boolean,
  configurationVersion: number,
  mintVersion: number,
  gatewayBaseUrl: string,
  canonicalOverride: string | undefined,
  failure: Error | undefined,
  failureStage:
    | 'authorization'
    | 'configuration'
    | 'availability'
    | 'route'
    | 'mint'
    | 'verification';
const config = (id: string) => ({
  configId: id,
  canonicalUrl: `${gatewayBaseUrl}/${id}`,
  registryMetadata: { providerSecret: 'provider-secret' },
});
function throwIfFailed(stage: typeof failureStage) {
  if (failure && failureStage === stage) throw failure;
}
jest.mock('./authorization', () => ({
  harnessInputDigest: (args: unknown) => JSON.stringify(args),
  authorizeHarnessCapability: async (token: string, scope: Record<string, unknown>) => {
    throwIfFailed('authorization');
    if (
      denied ||
      token !== 'capability' ||
      scope.audience !== 'agent-harness:operations' ||
      scope.conversationId !== invocation.conversationId ||
      scope.dispatchId !== invocation.operationId ||
      scope.operation !== invocation.request.name ||
      scope.definitionVersion !== '1' ||
      JSON.stringify(scope.target) !== '{"kind":"backend"}' ||
      scope.inputDigest !== JSON.stringify(invocation.request.arguments)
    )
      throw new TRPCError({ code: 'FORBIDDEN' });
    return { authority: { userId: 'oauth/github:owner', organizationId } };
  },
}));
jest.mock('@/lib/mcp-gateway/services', () => ({
  createGatewayServices: () => {
    throwIfFailed('configuration');
    return {
      availableService: {
        listAvailableConfigs: async (
          user: string,
          context: { type: string; organizationId?: string }
        ) => {
          throwIfFailed('availability');
          return unavailable || user !== 'oauth/github:owner'
            ? []
            : [
                config(
                  context.type === 'personal'
                    ? 'personal'
                    : (context.organizationId ?? 'wrong-context')
                ),
              ];
        },
      },
      routeService: {
        resolveResource: async (url: string) => {
          throwIfFailed('route');
          return {
            route: { configId: url.split('/').at(-1) },
            resolved: {
              config: { config_version: configurationVersion, encrypted_secret: 'provider-secret' },
            },
          };
        },
        canonicalUrl: (route: { configId: string }) =>
          canonicalOverride ?? config(route.configId).canonicalUrl,
      },
      tokenService: {
        mintDerivedConnectToken: async ({
          route,
          userId,
          executionContext,
        }: {
          route: { configId: string };
          userId: string;
          executionContext: { type: string; organizationId?: string };
        }) => {
          throwIfFailed('mint');
          if (
            route.configId !== (organizationId ?? 'personal') ||
            userId !== 'oauth/github:owner' ||
            executionContext.type !== (organizationId === null ? 'personal' : 'organization') ||
            executionContext.organizationId !== (organizationId ?? undefined)
          )
            throw new Error('Wrong authority');
          return { token: 'derived-only' };
        },
        verifyUserInfoToken: async (token: string) => {
          throwIfFailed('verification');
          if (token !== 'derived-only') throw new Error('Wrong token');
          return { config_version: mintVersion };
        },
      },
    };
  },
}));
const { authorizeHarnessMcp } = jest.requireActual<typeof McpModule>('./mcp');
beforeEach(() => {
  organizationId = null;
  unavailable = false;
  denied = false;
  configurationVersion = 1;
  mintVersion = 1;
  gatewayBaseUrl = 'https://gateway.example';
  canonicalOverride = undefined;
  failure = undefined;
  failureStage = 'mint';
  invocation.request = { name: 'mcp.discover', arguments: {} };
});

it.each([null, 'organization'])('uses only current conversation scope: %s', async scope => {
  organizationId = scope;
  configurationVersion = mintVersion = 7;
  const result = await authorizeHarnessMcp('capability', invocation);
  expect(result).toEqual([
    {
      serverId: scope ?? 'personal',
      configurationVersion: '7',
      url: config(scope ?? 'personal').canonicalUrl,
      authorization: 'Bearer derived-only',
    },
  ]);
  expect(JSON.stringify(result)).not.toContain('provider-secret');
});
it('returns an honest empty set and rejects substituted authority', async () => {
  unavailable = true;
  expect(await authorizeHarnessMcp('capability', invocation)).toEqual([]);
  for (const patch of [
    { userId: 'another-owner' },
    { organizationId: 'another-context' },
    { 'provider-secret': 'untrusted' },
    { request: { name: 'kilo.organizations', arguments: {} } },
  ]) {
    await expect(
      authorizeHarnessMcp('capability', { ...invocation, ...patch })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'invalid_input',
      cause: undefined,
    });
  }
  denied = true;
  await expect(authorizeHarnessMcp('capability', invocation)).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'access_revoked',
  });
});
it.each([
  ['capability', { conversationId: invocation.operationId }],
  ['capability', { operationId: invocation.conversationId }],
  ['forged', {}],
] as const)('rejects a forged capability: %s %j', async (token, patch) => {
  await expect(authorizeHarnessMcp(token, { ...invocation, ...patch })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'access_revoked',
  });
});
it.each([
  ['forbidden', 'reauthorization_required'],
  ['invalid_grant', 'reauthorization_required'],
  ['temporarily_unavailable', 'unavailable_server'],
  ['not_found', 'unavailable_server'],
  ['invalid_request', 'unsafe_destination'],
  ['access_denied', 'access_revoked'],
] as const)('sanitizes gateway %s without merging recovery states', async (code, message) => {
  failure = new GatewayError(code, 'provider-secret', 403);
  await expect(authorizeHarnessMcp('capability', invocation)).rejects.toMatchObject({
    message,
    cause: undefined,
  });
});
it.each(['FORBIDDEN', 'UNAUTHORIZED'] as const)('sanitizes %s denial', async code => {
  failureStage = 'authorization';
  failure = new TRPCError({
    code,
    message: 'unavailable_server',
    cause: new Error('provider-secret'),
  });
  await expect(authorizeHarnessMcp('capability', invocation)).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'access_revoked',
    cause: undefined,
  });
});
it.each([
  'authorization',
  'configuration',
  'availability',
  'route',
  'mint',
  'verification',
] as const)('removes sensitive failures from %s', async stage => {
  failureStage = stage;
  for (const message of ['provider-secret', 'unavailable_server']) {
    failure = new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message,
      cause: new Error('provider-secret'),
    });
    await expect(authorizeHarnessMcp('capability', invocation)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'unavailable_server',
      cause: undefined,
    });
  }
});
it('reports missing gateway configuration rather than an empty discovery', async () => {
  failureStage = 'configuration';
  failure = new Error('provider-secret');
  await expect(authorizeHarnessMcp('capability', invocation)).rejects.toMatchObject({
    code: 'SERVICE_UNAVAILABLE',
    message: 'unavailable_server',
    cause: undefined,
  });
});
it.each([
  'http://gateway.example',
  'https://provider-secret@gateway.example',
  'https://user:provider-secret@gateway.example',
])('refuses unsafe gateway destinations: %s', async url => {
  gatewayBaseUrl = url;
  await expect(authorizeHarnessMcp('capability', invocation)).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'unsafe_destination',
    cause: undefined,
  });
});
it('refuses a destination that differs from the available canonical route', async () => {
  canonicalOverride = 'https://other.example/personal';
  await expect(authorizeHarnessMcp('capability', invocation)).rejects.toMatchObject({
    message: 'unsafe_destination',
  });
});
it('rejects configuration changes while minting authorization', async () => {
  mintVersion = 2;
  await expect(authorizeHarnessMcp('capability', invocation)).rejects.toMatchObject({
    message: 'definition_changed',
  });
});
it.each([
  [null, 'personal', '1', null],
  ['organization', 'organization', '1', null],
  ['organization', 'personal', '1', 'unavailable_server'],
  [null, 'other', '1', 'unavailable_server'],
  [null, 'personal', '2', 'definition_changed'],
])(
  'checks the scoped server and version before a call: %s/%s/%s',
  async (scope, serverId, configurationVersion, message) => {
    organizationId = scope;
    invocation.request = {
      name: 'mcp.call',
      arguments: {
        serverId,
        configurationVersion,
        name: 'remote',
        definitionVersion: 'immutable',
        arguments: {},
      },
    };
    const result = authorizeHarnessMcp('capability', invocation);
    if (message) await expect(result).rejects.toMatchObject({ message });
    else expect(await result).toHaveLength(1);
  }
);
