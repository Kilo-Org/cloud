/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer exercises real React Native hook cleanup without a DOM */
/* eslint-disable require-await, @typescript-eslint/require-await -- native transport and storage doubles return promises */
/* eslint-disable max-lines -- the producer/consumer matrix and lifecycle regressions share the real outbox harness */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SessionManagerConfig } from '@kilocode/cloud-agent-sdk';
import { type LaunchRepositoryReference } from '@kilocode/app-shared/code-review/repository-identity';

import { listOutboxRows } from '@/lib/persist/mutation-outbox';
import {
  resolveContinueStartDisabled,
  resolveNewSessionStartDisabled,
} from '@/lib/new-session-submit';
import { createMobileAgentSessionManager } from './mobile-session-manager';
import { resolveProviderLaunchInput } from './provider-launch-input';
import { useNewSessionCreator } from './use-new-session-creator';

const native = vi.hoisted(() => ({
  userId: 'user-1',
  nextKey: 0,
  path: '/new',
  created: 0,
  busy: [] as boolean[],
  errors: [] as string[],
  rows: new Map<string, { scope: string; k: string; v: string }>(),
  beforeWrite: undefined as (() => Promise<void>) | undefined,
}));
const manager = vi.hoisted(() => ({ config: null as SessionManagerConfig | null, query: vi.fn() }));
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
vi.mock('sonner-native', () => ({
  toast: {
    error: (message: string) => {
      native.errors.push(message);
    },
  },
}));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/agent-session-cache', () => ({
  invalidateAgentSessionQueries: async () => undefined,
}));
vi.mock('@/lib/analytics/posthog', () => ({
  captureEvent: vi.fn(),
  SESSION_CREATED_EVENT: 'session_created',
}));
vi.mock('@kilocode/cloud-agent-sdk/message-id', () => ({ generateMessageId: () => 'msg_test' }));
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
// Capture the adapter's SDK boundary; its mapping and retry classifier remain real.
vi.mock('@kilocode/cloud-agent-sdk', () => ({
  createSessionManager: (config: SessionManagerConfig) => {
    manager.config = config;
    return {};
  },
}));
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
  withCloudAgentDiagnostics: async (
    _action: string,
    _organizationId: string | undefined,
    operation: () => Promise<unknown>
  ) => operation(),
}));
vi.mock('@/components/agents/mobile-session-page-adapter', () => ({
  fetchMobileSessionSnapshotPage: vi.fn(),
}));
vi.mock('@/components/agents/tool-card-image-cache', () => ({ cacheToolAttachment: vi.fn() }));
vi.mock('@/components/agents/file-part-cache', () => ({ cacheFilePart: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({}),
  trpcClient: {
    cliSessionsV2: { getWithRuntimeState: { query: manager.query } },
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

type Input = Parameters<typeof useNewSessionCreator>[0];
type Result = ReturnType<typeof useNewSessionCreator>;
type Payload = { operationKey?: string; organizationId?: string; [key: string]: unknown };
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
  // SDK legacy callers omit operationKey; creator requests must persist it first.
  if (input.operationKey) {
    expect(await storedKeys(native.userId)).toContain(input.operationKey);
  }
  const operationKey = input.operationKey ?? `unkeyed-${server.sessions.size + 1}`;
  const kiloSessionId = server.sessions.get(operationKey) ?? `session-${server.sessions.size + 1}`;
  server.sessions.set(operationKey, kiloSessionId);
  await server.beforeResponse?.();
  if (server.error) {
    throw server.error;
  }
  return { kiloSessionId, cloudAgentSessionId: `cloud-${kiloSessionId}` };
}

const providers = [
  {
    platform: 'github',
    instanceUrl: 'https://github.com',
    fullName: 'owner/repo',
    displayName: 'owner/repo',
    legacy: { githubRepo: 'owner/repo' },
    pin: { githubIntegrationId: 'integration-a' },
    pinField: 'githubIntegrationId',
  },
  {
    platform: 'gitlab',
    instanceUrl: 'https://gitlab.com',
    fullName: 'group/sub/repo',
    displayName: 'group/sub/repo',
    legacy: { gitlabProject: 'group/sub/repo' },
    pin: { gitlabIntegrationId: 'integration-a', gitlabInstanceUrl: 'https://gitlab.com' },
    pinField: 'gitlabIntegrationId',
  },
  {
    platform: 'gitlab',
    instanceUrl: 'https://git.example/base',
    fullName: 'group/sub/repo',
    displayName: 'base/group/sub/repo',
    legacy: { gitlabProject: 'group/sub/repo' },
    pin: { gitlabIntegrationId: 'integration-a', gitlabInstanceUrl: 'https://git.example/base' },
    pinField: 'gitlabIntegrationId',
  },
  {
    platform: 'bitbucket',
    instanceUrl: 'https://bitbucket.org',
    fullName: 'workspace/repo',
    displayName: 'workspace/repo',
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
// The same seven contexts drive both creator suites, SDK tests, and recent tests.
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
function inputFor(entry: (typeof cases)[number]): Input {
  return {
    attachments: {
      attachments: [],
      isUploading: false,
      hasFailedAttachments: false,
      addCandidates: vi.fn(async () => undefined),
      removeAttachment: vi.fn(() => undefined),
      retryAttachment: vi.fn(() => undefined),
      reset: vi.fn(() => undefined),
      uploadPending: async () => ({ ok: true, wire: undefined, submission: undefined }),
    },
    mode: 'code',
    model: 'model',
    variant: 'high',
    autoCommit: false,
    organizationId: entry.organizationId,
    selectedRepository: {
      platform: entry.provider.platform,
      fullName: entry.provider.fullName,
      isPrivate: true,
      ...(entry.provider.platform === 'bitbucket'
        ? { workspaceUuid: 'workspace-1', repositoryUuid: '42' }
        : {}),
    },
    launchSelection: { reference: entry.reference, upstreamBranch: 'release/Case' },
    setIsCreating: value => {
      native.busy.push(value);
    },
    onCreated: () => {
      native.created += 1;
    },
  };
}
function Form({ input, result }: { input: Input; result: { current: Result | null } }) {
  result.current = useNewSessionCreator(input);
  return null;
}
const renderers = new Set<TestRenderer.ReactTestRenderer>();
async function mount(input: Input) {
  const result: { current: Result | null } = { current: null };
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Form, { input, result }));
    renderers.add(renderer);
  });
  const get = () => {
    if (!result.current) {
      throw new Error('Creator did not mount');
    }
    return result.current;
  };
  get().promptRef.current = 'Keep this draft';
  return {
    get,
    submit: async () => {
      await act(async () => {
        await get().createSessionFromDraft();
      });
    },
    update: async (next: Input) => {
      await act(async () => {
        renderer?.update(createElement(Form, { input: next, result }));
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
  native.path = '/new';
  native.created = 0;
  native.busy = [];
  native.errors = [];
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

describe.each(cases)('ordinary $provider.platform $type $provider.instanceUrl', entry => {
  it.each([false, true])('transmits the exact repository and owner, legacy=%s', async legacy => {
    const input = inputFor(entry);
    if (legacy) {
      input.launchSelection = undefined;
    }
    const form = await mount(input);
    await form.submit();
    expect(server.requests).toEqual([
      {
        prompt: 'Keep this draft',
        initialMessageId: 'msg_test',
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

  it.each([false, true])(
    'passes the launch mapping through the mobile SDK adapter and recovers metadata, legacy=%s',
    async legacy => {
      const input = inputFor(entry);
      const launch = resolveProviderLaunchInput(input.selectedRepository, {
        accountId: 'user-1',
        organizationId: entry.organizationId,
        launchSelection: legacy ? undefined : input.launchSelection,
      });
      if (!launch) {
        throw new Error('Missing launch mapping');
      }
      const dependencies = {
        store: {},
        userWebConnection: {},
        organizationId: entry.organizationId,
      };
      createMobileAgentSessionManager(
        dependencies as Parameters<typeof createMobileAgentSessionManager>[0]
      );
      const config = manager.config;
      if (!config) {
        throw new Error('Missing manager configuration');
      }
      const prepared = await config.prepare({
        prompt: 'hello',
        mode: 'code',
        model: 'model',
        ...launch.input,
      });
      expect(prepared).toEqual({
        kiloSessionId: 'session-1',
        cloudAgentSessionId: 'cloud-session-1',
      });
      expect(server.requests).toEqual([
        {
          prompt: 'hello',
          mode: 'code',
          model: 'model',
          initialPayload: undefined,
          ...entry.provider.legacy,
          ...(legacy ? {} : { ...entry.provider.pin, upstreamBranch: 'release/Case' }),
          ...(entry.organizationId ? { organizationId: entry.organizationId } : {}),
        },
      ]);
      expect(server.routes).toEqual([entry.type]);
      const gitUrl = `${entry.provider.instanceUrl}/${entry.provider.fullName}.git`;
      manager.query.mockResolvedValue({
        git_url: legacy ? gitUrl : null,
        git_branch: 'main',
        organization_id: entry.organizationId ?? null,
        runtimeState: legacy
          ? null
          : {
              gitUrl,
              upstreamBranch: 'release/Case',
              ...(entry.provider.platform === 'github' ? { githubRepo: 'owner/repo' } : {}),
            },
      });
      expect(await config.fetchSession(prepared.kiloSessionId)).toMatchObject({
        repository: entry.provider.displayName,
        gitUrl,
        gitBranch: legacy ? 'main' : 'release/Case',
        organizationId: entry.organizationId ?? null,
      });
    }
  );

  it('keeps both submit guards aligned with the selected identity', () => {
    const launchSelection = { reference: entry.reference, upstreamBranch: 'release/Case' };
    const common = {
      accountId: 'user-1',
      organizationId: entry.organizationId,
      launchSelection,
      model: 'model',
      selectedRepo: entry.provider.fullName,
      selectedRepositoryResolved: true,
      isCreating: false,
      isSubmitting: false,
      isRemoteTargetSelected: false,
    };
    const ordinary = {
      ...common,
      hasPrompt: true,
      attachmentsHasFailed: false,
      attachmentsIsUploading: false,
      isProfileLoading: false,
    };
    const continuation = {
      ...common,
      isSpawningRemote: false,
      instanceCatalogLoading: false,
      instanceHasSessionClone: true,
      cloneImportFailureKey: null,
      isModelUnavailable: false,
    };
    expect(resolveNewSessionStartDisabled(ordinary)).toBe(false);
    expect(resolveContinueStartDisabled(continuation)).toBe(false);
    for (const stale of [
      { organizationId: 'other-org' },
      { selectedRepositoryResolved: false },
      { launchSelection: { ...launchSelection, upstreamBranch: '' } },
      { launchSelection: null },
    ]) {
      expect(resolveNewSessionStartDisabled({ ...ordinary, ...stale })).toBe(true);
      expect(resolveContinueStartDisabled({ ...continuation, ...stale })).toBe(true);
    }
    expect(resolveNewSessionStartDisabled({ ...ordinary, launchSelection: undefined })).toBe(false);
    expect(resolveContinueStartDisabled({ ...continuation, launchSelection: undefined })).toBe(
      false
    );
  });

  it.each(['branch', 'integration'])(
    'recovers A/B/A after lost responses and a changed %s',
    async change => {
      const first = inputFor(entry);
      const second: Input = {
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
      const form = await mount(first);
      server.error = new Error('Lost response');
      await act(async () => {
        await Promise.all([
          form.get().createSessionFromDraft(),
          form.get().createSessionFromDraft(),
        ]);
      });
      const keyA = server.requests[0]?.operationKey;
      expect(server.sessions.size).toBe(1);
      await form.update(second);
      await form.submit();
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
      await form.update(first);
      server.error = undefined;
      await form.submit();
      expect(server.requests.map(row => row.operationKey)).toEqual([keyA, keyA, keyB, keyA]);
      expect(server.sessions.size).toBe(2);
      expect(native.path).toContain('agent-chat/session-1');
      expect(await storedKeys()).toEqual([keyB]);
      await form.unmount();
      const remounted = await mount(second);
      await remounted.submit();
      expect(server.sessions.size).toBe(2);
      expect(server.requests.at(-1)?.operationKey).toBe(keyB);
      expect(native.path).toContain('agent-chat/session-2');
      expect(await listOutboxRows('user-1')).toEqual([]);
    }
  );

  it('rejects the current and saved callbacks after an owner change', async () => {
    const input = inputFor(entry);
    const form = await mount(input);
    const saved = form.get().createSessionFromDraft;
    if (entry.type === 'user') {
      native.userId = 'other-user';
    }
    await form.update({ ...input, organizationId: entry.type === 'org' ? 'other-org' : undefined });
    await act(async () => {
      await saved();
    });
    await form.submit();
    expect(server.sessions.size).toBe(0);
    expect(native.rows.size).toBe(0);
    expect(native.path).toBe('/new');
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
    const form = await mount(inputFor(entry));
    const saved = form.get();
    const request = saved.createSessionFromDraft();
    await act(async () => {
      await entered.promise;
    });
    await form.unmount();
    const busyAtUnmount = [...native.busy];
    await act(async () => {
      gate.resolve(undefined);
      await request;
      await saved.createSessionFromDraft();
    });
    expect(server.sessions.size).toBe(phase === 'before dispatch' ? 0 : 1);
    expect(await storedKeys()).toEqual(['operation-1']);
    expect(native.path).toBe('/new');
    expect(native.created).toBe(0);
    expect(native.errors).toEqual([]);
    expect(native.busy).toEqual(busyAtUnmount);
    expect(saved.promptRef.current).toBe('Keep this draft');
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
    const input = inputFor(entry);
    const form = await mount(input);
    const request = form.get().createSessionFromDraft();
    await act(async () => {
      await entered.promise;
    });
    if (change === 'account') {
      native.userId = 'other-user';
    }
    await form.update({
      ...input,
      organizationId: change === 'owner' ? 'other-org' : input.organizationId,
    });
    native.userId = 'user-1';
    await form.update(input);
    await act(async () => {
      gate.resolve(undefined);
      await request;
    });
    expect(server.sessions.size).toBe(1);
    expect(await storedKeys()).toEqual(['operation-1']);
    expect(native.path).toBe('/new');
    expect(native.created).toBe(0);
    expect(form.get().promptRef.current).toBe('Keep this draft');
  }
);

it.each(['owner', 'repository'])(
  'releases busy state for a new %s without letting retired work clear its launch',
  async change => {
    const entry = cases.find(candidate => candidate.type === 'org');
    if (!entry) {
      throw new Error('Missing organization case');
    }
    const firstGate = Promise.withResolvers<undefined>();
    const secondGate = Promise.withResolvers<undefined>();
    const firstEntered = Promise.withResolvers<undefined>();
    const secondEntered = Promise.withResolvers<undefined>();
    server.beforeResponse = async () => {
      if (server.requests.length === 1) {
        firstEntered.resolve(undefined);
        await firstGate.promise;
      } else {
        secondEntered.resolve(undefined);
        await secondGate.promise;
      }
    };
    const input = inputFor(entry);
    const form = await mount(input);
    const firstRequest = form.get().createSessionFromDraft();
    await act(async () => {
      await firstEntered.promise;
    });
    expect(native.busy.at(-1)).toBe(true);
    const reference: LaunchRepositoryReference = {
      ...entry.reference,
      repository: {
        ...entry.reference.repository,
        ...(change === 'repository' ? { repositoryId: '43', fullName: 'owner/other' } : {}),
      },
      authorization: {
        ...entry.reference.authorization,
        ...(change === 'owner' ? { owner: { type: 'org', id: 'org-2' } as const } : {}),
      },
    };
    await form.update({
      ...input,
      organizationId: change === 'owner' ? 'org-2' : input.organizationId,
      selectedRepository: {
        platform: reference.repository.provider,
        fullName: reference.repository.fullName,
        isPrivate: true,
      },
      launchSelection: { reference, upstreamBranch: 'release/Case' },
    });
    expect(native.busy.at(-1)).toBe(false);
    const secondRequest = form.get().createSessionFromDraft();
    await act(async () => {
      await secondEntered.promise;
    });
    expect(native.busy.at(-1)).toBe(true);
    await act(async () => {
      firstGate.resolve(undefined);
      await firstRequest;
    });
    expect(native.busy.at(-1)).toBe(true);
    expect(native.path).toBe('/new');
    expect(native.created).toBe(0);
    expect(new Set(await storedKeys())).toEqual(new Set(['operation-1', 'operation-2']));
    await act(async () => {
      secondGate.resolve(undefined);
      await secondRequest;
    });
    expect(native.busy.at(-1)).toBe(false);
    expect(native.path).toContain('agent-chat/session-2');
    expect(await storedKeys()).toEqual(['operation-1']);
  }
);

it('keeps an absent repository and empty prompt inert', async () => {
  const entry = cases[0];
  if (!entry) {
    throw new Error('Missing launch case');
  }
  const input = inputFor(entry);
  const form = await mount({ ...input, selectedRepository: null, launchSelection: undefined });
  await form.submit();
  await form.update(input);
  form.get().promptRef.current = '   ';
  await form.submit();
  expect(server.sessions.size).toBe(0);
  expect(native.rows.size).toBe(0);
  expect(native.path).toBe('/new');
});
