/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer exercises real React Native hook cleanup without a DOM */
/* eslint-disable require-await, @typescript-eslint/require-await -- native transport and storage doubles return promises */
/* eslint-disable max-lines -- the provider matrix and lifecycle regressions share the real outbox harness */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { type LaunchRepositoryReference } from '@kilocode/app-shared/code-review/repository-identity';

import { listOutboxRows } from '@/lib/persist/mutation-outbox';
import { useContinueCloudCreate } from './use-continue-cloud-create';

const native = vi.hoisted(() => ({
  userId: 'user-1',
  nextKey: 0,
  path: '/continue',
  created: 0,
  rows: new Map<string, { scope: string; k: string; v: string }>(),
  beforeWrite: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: native.userId, isLoading: false }),
}));
vi.mock('expo-crypto', () => ({
  randomUUID: () => {
    native.nextKey += 1;
    return `operation-${native.nextKey}`;
  },
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({
    replace: (path: string) => {
      native.path = path;
    },
  }),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('expo-haptics', () => ({
  notificationAsync: async () => undefined,
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/agent-session-cache', () => ({
  invalidateAgentSessionQueries: async () => undefined,
}));
vi.mock('@/lib/analytics/posthog', () => ({
  captureEvent: vi.fn(),
  SESSION_CREATED_EVENT: 'session_created',
}));
vi.mock('@/lib/persist/encrypted-kv', () => ({
  getItem: async (scope: string, k: string) => native.rows.get(`${scope}\0${k}`)?.v ?? null,
  setItem: async (scope: string, k: string, v: string) => {
    await native.beforeWrite?.();
    native.rows.set(`${scope}\0${k}`, { scope, k, v });
  },
  removeItem: async (scope: string, k: string) => {
    native.rows.delete(`${scope}\0${k}`);
  },
  listEntries: async (scope: string) =>
    [...native.rows.values()].filter(row => row.scope === scope),
}));
// Keep the real retry classifier; replace only its native and transport dependencies.
vi.mock('@kilocode/cloud-agent-sdk', () => ({ createSessionManager: vi.fn() }));
vi.mock('@/lib/auth/token-owner', () => ({ getAuthTokenForRequest: vi.fn() }));
vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.test',
  CLOUD_AGENT_WS_URL: 'wss://ws.test',
  WEB_BASE_URL: 'https://web.test',
}));
vi.mock('@/lib/user-web-connection-lifecycle', () => ({
  createNativeUserWebConnectionLifecycleHooks: vi.fn(),
}));
vi.mock('@/components/agents/mobile-session-transport-payload', () => ({
  normalizeTransportPayload: vi.fn(),
}));
vi.mock('@/components/agents/mobile-session-diagnostics', () => ({
  formatSafeCloudAgentFailureDiagnostic: vi.fn(),
  withCloudAgentDiagnostics: vi.fn(),
}));
vi.mock('@/components/agents/mobile-session-page-adapter', () => ({
  fetchMobileSessionSnapshotPage: vi.fn(),
}));
vi.mock('@/components/agents/tool-card-image-cache', () => ({ cacheToolAttachment: vi.fn() }));
vi.mock('@/components/agents/file-part-cache', () => ({ cacheFilePart: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({}),
  trpcClient: {
    cloudAgentNext: {
      prepareSession: { mutate: async (input: Payload) => prepare(input, 'user') },
    },
    organizations: {
      cloudAgentNext: {
        prepareSession: { mutate: async (input: Payload) => prepare(input, 'org') },
      },
    },
  },
}));

type Run = ReturnType<typeof useContinueCloudCreate>;
type Destination = Parameters<Run>[1];
type Payload = { operationKey: string; organizationId?: string; [key: string]: unknown };
const SOURCE = 'ses_source' as KiloSessionId;
const server = {
  requests: [] as Payload[],
  routes: [] as ('user' | 'org')[],
  sessions: new Map<string, string>(),
  error: undefined as Error | undefined,
  beforeResponse: undefined as (() => Promise<void>) | undefined,
};
async function storedKeys(userId = 'user-1') {
  const rows = await listOutboxRows(userId);
  return rows?.map(row => row.operationKey);
}
async function prepare(input: Payload, owner: 'user' | 'org') {
  server.requests.push(input);
  server.routes.push(owner);
  expect(await storedKeys(native.userId)).toContain(input.operationKey);
  const kiloSessionId =
    server.sessions.get(input.operationKey) ?? `session-${server.sessions.size + 1}`;
  server.sessions.set(input.operationKey, kiloSessionId);
  await server.beforeResponse?.();
  if (server.error) {
    throw server.error;
  }
  return { kiloSessionId };
}
const providers = [
  {
    platform: 'github',
    instanceUrl: 'https://github.com',
    fullName: 'owner/repo',
    legacy: { githubRepo: 'owner/repo' },
    pin: { githubIntegrationId: 'integration-a' },
    pinField: 'githubIntegrationId',
  },
  {
    platform: 'gitlab',
    instanceUrl: 'https://gitlab.com',
    fullName: 'group/sub/repo',
    legacy: { gitlabProject: 'group/sub/repo' },
    pin: { gitlabIntegrationId: 'integration-a', gitlabInstanceUrl: 'https://gitlab.com' },
    pinField: 'gitlabIntegrationId',
  },
  {
    platform: 'gitlab',
    instanceUrl: 'https://git.example/base',
    fullName: 'group/sub/repo',
    legacy: { gitlabProject: 'group/sub/repo' },
    pin: { gitlabIntegrationId: 'integration-a', gitlabInstanceUrl: 'https://git.example/base' },
    pinField: 'gitlabIntegrationId',
  },
  {
    platform: 'bitbucket',
    instanceUrl: 'https://bitbucket.org',
    fullName: 'workspace/repo',
    legacy: {
      bitbucketRepo: {
        fullName: 'workspace/repo',
        workspaceUuid: 'workspace-1',
        repositoryUuid: '42',
      },
    },
    pin: { bitbucketIntegrationId: 'integration-a' },
    pinField: 'bitbucketIntegrationId',
  },
] as const;
const cases = providers.flatMap(provider =>
  (provider.platform === 'bitbucket' ? (['org'] as const) : (['user', 'org'] as const)).map(
    type => {
      const reference: LaunchRepositoryReference = {
        repository: {
          instanceUrl: provider.instanceUrl,
          repositoryId: '42',
          fullName: provider.fullName,
          defaultBranch: 'main',
          ...(provider.platform === 'bitbucket'
            ? { provider: 'bitbucket' as const, workspaceUuid: 'workspace-1' }
            : { provider: provider.platform }),
        },
        authorization: {
          kind: 'ownerIntegration',
          owner: { type, id: type === 'org' ? 'org-1' : 'user-1' },
          integrationId: 'integration-a',
        },
      };
      return { provider, type, reference, organizationId: type === 'org' ? 'org-1' : undefined };
    }
  )
);
function destinationFor(entry: (typeof cases)[number]): Destination {
  return {
    repository: {
      platform: entry.provider.platform,
      fullName: entry.provider.fullName,
      isPrivate: true,
      ...(entry.provider.platform === 'bitbucket'
        ? { workspaceUuid: 'workspace-1', repositoryUuid: '42' }
        : {}),
    },
    model: 'model',
    variant: 'high',
    launchSelection: { reference: entry.reference, upstreamBranch: 'release/Case' },
  };
}
function onCreated() {
  native.created += 1;
}
function Form({
  organizationId,
  result,
}: {
  organizationId?: string;
  result: { current: Run | null };
}) {
  result.current = useContinueCloudCreate(organizationId, onCreated);
  return null;
}
const renderers = new Set<TestRenderer.ReactTestRenderer>();
async function mount(organizationId?: string) {
  const result: { current: Run | null } = { current: null };
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Form, { organizationId, result }));
    renderers.add(renderer);
  });
  const get = () => {
    if (!result.current) {
      throw new Error('Creator did not mount');
    }
    return result.current;
  };
  return {
    get,
    submit: async (destination: Destination) => {
      let failure: unknown = undefined;
      await act(async () => {
        try {
          await get()(SOURCE, destination, 'code');
        } catch (error) {
          failure = error;
        }
      });
      return failure;
    },
    update: async (next?: string) => {
      await act(async () => {
        renderer?.update(createElement(Form, { organizationId: next, result }));
      });
    },
    unmount: async () => {
      await act(async () => {
        renderer?.unmount();
      });
      if (renderer) {
        renderers.delete(renderer);
      }
    },
  };
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  native.userId = 'user-1';
  native.nextKey = 0;
  native.path = '/continue';
  native.created = 0;
  native.rows.clear();
  native.beforeWrite = undefined;
  server.requests = [];
  server.routes = [];
  server.sessions.clear();
  server.error = undefined;
  server.beforeResponse = undefined;
});
afterEach(async () => {
  await act(async () => {
    for (const renderer of renderers) {
      renderer.unmount();
    }
  });
  renderers.clear();
  vi.unstubAllGlobals();
});

describe.each(cases)('continue $provider.platform $type $provider.instanceUrl', entry => {
  it.each([false, true])('transmits the exact repository and owner, legacy=%s', async legacy => {
    const destination = destinationFor(entry);
    if (legacy) {
      destination.launchSelection = undefined;
    }
    const form = await mount(entry.organizationId);
    expect(await form.submit(destination)).toBeUndefined();
    expect(server.requests).toEqual([
      {
        cloneFromKiloSessionId: SOURCE,
        mode: 'code',
        model: 'model',
        variant: 'high',
        autoCommit: false,
        autoInitiate: true,
        operationKey: expect.any(String),
        ...entry.provider.legacy,
        ...(legacy ? {} : { ...entry.provider.pin, upstreamBranch: 'release/Case' }),
        ...(entry.organizationId ? { organizationId: entry.organizationId } : {}),
      },
    ]);
    expect(server.routes).toEqual([entry.type]);
    expect(server.sessions.size).toBe(1);
    expect(native.path).toContain('agent-chat/session-1');
    expect(native.created).toBe(1);
    expect(await listOutboxRows('user-1')).toEqual([]);
  });

  it.each(['branch', 'integration'])(
    'recovers A/B/A after lost responses and a changed %s',
    async change => {
      const first = destinationFor(entry);
      const second: Destination = {
        ...first,
        launchSelection: {
          reference: {
            ...entry.reference,
            authorization: {
              ...entry.reference.authorization,
              integrationId: change === 'integration' ? 'integration-b' : 'integration-a',
            },
          },
          upstreamBranch: change === 'branch' ? 'other/Case' : 'release/Case',
        },
      };
      const form = await mount(entry.organizationId);
      server.error = new Error('Lost response');
      await act(async () => {
        const attempts = await Promise.allSettled([
          form.get()(SOURCE, first, 'code'),
          form.get()(SOURCE, first, 'code'),
        ]);
        expect(attempts.map(attempt => attempt.status)).toEqual(['rejected', 'rejected']);
      });
      const keyA = server.requests[0]?.operationKey;
      expect(server.sessions.size).toBe(1);
      expect(await form.submit(second)).toEqual(new Error('Lost response'));
      const keyB = server.requests[2]?.operationKey;
      expect(keyB).not.toBe(keyA);
      expect(server.requests[2]).toMatchObject({
        ...entry.provider.legacy,
        ...entry.provider.pin,
        [entry.provider.pinField]: change === 'integration' ? 'integration-b' : 'integration-a',
        upstreamBranch: change === 'branch' ? 'other/Case' : 'release/Case',
      });
      expect(server.sessions.size).toBe(2);
      expect(new Set(await storedKeys())).toEqual(new Set([keyA, keyB]));
      server.error = undefined;
      expect(await form.submit(first)).toBeUndefined();
      expect(server.requests.map(row => row.operationKey)).toEqual([keyA, keyA, keyB, keyA]);
      expect(server.sessions.size).toBe(2);
      expect(native.path).toContain('agent-chat/session-1');
      expect(await storedKeys()).toEqual([keyB]);
      await form.unmount();
      const remounted = await mount(entry.organizationId);
      expect(await remounted.submit(second)).toBeUndefined();
      expect(server.sessions.size).toBe(2);
      expect(server.requests.at(-1)?.operationKey).toBe(keyB);
      expect(native.path).toContain('agent-chat/session-2');
      expect(await listOutboxRows('user-1')).toEqual([]);
    }
  );

  it('rejects the current and saved callbacks after an owner change', async () => {
    const destination = destinationFor(entry);
    const form = await mount(entry.organizationId);
    const saved = form.get();
    if (entry.type === 'user') {
      native.userId = 'other-user';
    }
    await form.update(entry.type === 'org' ? 'other-org' : undefined);
    await act(async () => {
      await saved(SOURCE, destination, 'code');
    });
    expect(await form.submit(destination)).toMatchObject({ data: { code: 'BAD_REQUEST' } });
    expect(server.sessions.size).toBe(0);
    expect(native.rows.size).toBe(0);
    expect(native.path).toBe('/continue');
    expect(native.created).toBe(0);
  });
});

it.each(['before dispatch', 'success', 'retryable', 'terminal'])(
  'retains retry state after unmount during %s',
  async phase => {
    const entry = cases[0];
    if (!entry) {
      throw new Error('Missing launch case');
    }
    const gate = Promise.withResolvers<undefined>();
    const entered = Promise.withResolvers<undefined>();
    const pause = async () => {
      entered.resolve(undefined);
      await gate.promise;
    };
    if (phase === 'before dispatch') {
      native.beforeWrite = pause;
    } else {
      server.beforeResponse = pause;
    }
    if (phase === 'retryable') {
      server.error = new Error('Lost response');
    }
    if (phase === 'terminal') {
      server.error = Object.assign(new Error('Rejected'), { data: { code: 'BAD_REQUEST' } });
    }
    const form = await mount(entry.organizationId);
    const destination = destinationFor(entry);
    const saved = form.get();
    const request = saved(SOURCE, destination, 'code');
    await act(async () => {
      await entered.promise;
    });
    await form.unmount();
    await act(async () => {
      gate.resolve(undefined);
      await request;
      await saved(SOURCE, destination, 'code');
    });
    expect(server.sessions.size).toBe(phase === 'before dispatch' ? 0 : 1);
    expect(await storedKeys()).toEqual(['operation-1']);
    expect(native.path).toBe('/continue');
    expect(native.created).toBe(0);
  }
);

it.each(['owner', 'account'])(
  'keeps a preparation retired after a %s A/B/A transition',
  async change => {
    const entry = cases.find(candidate => candidate.type === 'org');
    if (!entry) {
      throw new Error('Missing organization case');
    }
    const gate = Promise.withResolvers<undefined>();
    const entered = Promise.withResolvers<undefined>();
    server.beforeResponse = async () => {
      entered.resolve(undefined);
      await gate.promise;
    };
    const destination = destinationFor(entry);
    const form = await mount(entry.organizationId);
    const request = form.get()(SOURCE, destination, 'code');
    await act(async () => {
      await entered.promise;
    });
    if (change === 'account') {
      native.userId = 'other-user';
    }
    await form.update(change === 'owner' ? 'other-org' : entry.organizationId);
    native.userId = 'user-1';
    await form.update(entry.organizationId);
    await act(async () => {
      gate.resolve(undefined);
      await request;
    });
    expect(server.sessions.size).toBe(1);
    expect(await storedKeys()).toEqual(['operation-1']);
    expect(native.path).toBe('/continue');
    expect(native.created).toBe(0);
  }
);

it('keeps an absent continue repository inert', async () => {
  const form = await mount();
  expect(await form.submit({ repository: null, model: 'model', variant: '' })).toBeUndefined();
  expect(server.sessions.size).toBe(0);
  expect(native.rows.size).toBe(0);
  expect(native.path).toBe('/continue');
});
