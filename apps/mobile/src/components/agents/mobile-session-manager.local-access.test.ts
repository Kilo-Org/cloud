/* eslint-disable max-lines -- one manager harness covers every cloud action and overlapping prepare continuations */
/* eslint-disable promise/prefer-await-to-then -- race tests attach rejection handlers before changing the owner */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
import {
  type CloudAgentSessionId,
  type SessionManager,
  type SessionManagerConfig,
} from '@kilocode/cloud-agent-sdk';

import { bumpAuthEpoch, currentAuthEpoch } from '@/lib/auth/auth-epoch';
import {
  beginAuthenticatedOwner,
  confirmAuthenticatedOwner,
  getAuthenticatedOwner,
} from '@/lib/context-scope';
import {
  initializeLocalAccess,
  LocalAccessDeniedError,
  lockLocalAccess,
  requestLocalAccess,
  setLocalAccessContextReady,
  setLocalAccessOwner,
} from '@/lib/local-access';
import { type MobileUserWebConnection } from '@/lib/local-access-transport';
import { createMobileAgentSessionManager } from './mobile-session-manager';

const state = vi.hoisted(() => ({
  config: null as SessionManagerConfig | null,
  token: vi.fn(),
  beforeDispatch: vi.fn(),
  response: vi.fn(),
  journal: [] as { path: string; user: string | null; input: unknown }[],
  cached: [] as string[],
  destroyed: 0,
}));
vi.mock('@kilocode/cloud-agent-sdk', () => ({
  createSessionManager: (managerConfig: SessionManagerConfig) => {
    state.config = managerConfig;
    return {
      atoms: {},
      destroy: () => {
        state.destroyed += 1;
      },
    } as unknown as SessionManager;
  },
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.test',
  CLOUD_AGENT_WS_URL: 'wss://cloud.test',
  WEB_BASE_URL: 'https://web.test',
}));
vi.mock('@/lib/auth/token-owner', () => ({ getAuthTokenForRequest: state.token }));
vi.mock('@/lib/user-web-connection-lifecycle', () => ({
  createNativeUserWebConnectionLifecycleHooks: () => ({}),
}));
vi.mock('@/components/agents/mobile-session-transport-payload', () => ({
  normalizeTransportPayload: (value: unknown) => value,
}));
vi.mock('@/components/agents/mobile-session-page-adapter', () => ({
  fetchMobileSessionSnapshotPage: vi.fn(),
}));
vi.mock('@/components/agents/mobile-session-diagnostics', () => ({
  formatSafeCloudAgentFailureDiagnostic: vi.fn(),
  withCloudAgentDiagnostics: (_operation: string, _org: unknown, run: () => unknown) => run(),
}));
vi.mock('@/components/agents/tool-card-image-cache', () => ({
  cacheToolAttachment: (id: string) => {
    state.cached.push(id);
  },
}));
vi.mock('@/components/agents/file-part-cache', () => ({
  cacheFilePart: (id: string) => {
    state.cached.push(id);
  },
}));
vi.mock('@/lib/trpc', async () => {
  const { captureTransportOperation } = await import('@/lib/local-access-transport');
  function procedure(path: string) {
    return {
      mutate: async (input: unknown, options: { context: Record<string, unknown> }) => {
        const operation = captureTransportOperation({
          id: 1,
          type: 'mutation',
          path,
          input,
          context: options.context,
          signal: undefined,
        });
        await state.beforeDispatch();
        operation.assertDispatch();
        state.journal.push({ path, user: operation.owner.userId, input });
        const result: { cloudAgentSessionId: string; kiloSessionId: string } = await state.response(
          path,
          input
        );
        return result;
      },
    };
  }
  function cloud(prefix: string) {
    return {
      sendMessage: procedure(`${prefix}.sendMessage`),
      interruptSession: procedure(`${prefix}.interruptSession`),
      answerQuestion: procedure(`${prefix}.answerQuestion`),
      rejectQuestion: procedure(`${prefix}.rejectQuestion`),
      answerPermission: procedure(`${prefix}.answerPermission`),
      prepareSession: procedure(`${prefix}.prepareSession`),
      initiateFromPreparedSession: procedure(`${prefix}.initiateFromPreparedSession`),
    };
  }
  return {
    trpcClient: {
      cloudAgentNext: cloud('cloudAgentNext'),
      organizations: { cloudAgentNext: cloud('organizations.cloudAgentNext') },
    },
  };
});

let stop: (() => void) | undefined = undefined;
const managers: SessionManager[] = [];
beforeEach(async () => {
  state.config = null;
  state.journal.length = 0;
  state.cached.length = 0;
  state.destroyed = 0;
  state.token.mockReset().mockResolvedValue('token-A');
  state.beforeDispatch.mockReset().mockResolvedValue(undefined);
  state.response
    .mockReset()
    .mockResolvedValue({ cloudAgentSessionId: 'cloud-1', kiloSessionId: 'kilo-1' });
  confirmAuthenticatedOwner(beginAuthenticatedOwner(), 'A');
  stop = initializeLocalAccess({
    storage: {
      read: vi.fn().mockResolvedValue({ status: 'present', enabled: true }),
      write: vi.fn().mockResolvedValue('committed'),
    },
    authenticate: vi.fn().mockResolvedValue({ status: 'authenticated' }),
    lifecycle: { getCurrentState: () => 'active', subscribe: () => () => undefined },
  });
  await setLocalAccessOwner('A', currentAuthEpoch());
  setLocalAccessContextReady(true);
  await requestLocalAccess('unlock', true);
});
afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.destroy();
  }
  stop?.();
  vi.unstubAllGlobals();
});
function config(organizationId?: string) {
  const connection = {
    owner: getAuthenticatedOwner(),
    setSessionScope: vi.fn(),
  } as unknown as MobileUserWebConnection;
  managers.push(
    createMobileAgentSessionManager({
      store: createStore(),
      userWebConnection: connection,
      organizationId,
    })
  );
  if (!state.config) {
    throw new Error('Missing manager config');
  }
  return state.config;
}
const cloudId = 'cloud-1' as CloudAgentSessionId;
const createInput = { prompt: 'hello', mode: 'code', model: 'model' };
const actions: { name: string; run: (value: SessionManagerConfig) => Promise<unknown> }[] = [
  {
    name: 'send',
    run: async value => {
      await value.api.send({
        sessionId: cloudId,
        messageId: 'message-1',
        payload: { type: 'prompt', prompt: 'hello' },
      });
    },
  },
  {
    name: 'interrupt',
    run: async value => {
      await value.api.interrupt({ sessionId: cloudId });
    },
  },
  {
    name: 'answer',
    run: async value => {
      await value.api.answer({ sessionId: cloudId, requestId: 'q', answers: [['yes']] });
    },
  },
  {
    name: 'reject',
    run: async value => {
      await value.api.reject({ sessionId: cloudId, requestId: 'q' });
    },
  },
  {
    name: 'permission',
    run: async value => {
      await value.api.respondToPermission({ sessionId: cloudId, requestId: 'p', response: 'once' });
    },
  },
  {
    name: 'prepare',
    run: async value => {
      const result = await value.prepare(createInput);
      return result;
    },
  },
];

describe('mobile manager final admission', () => {
  it.each(actions)('keeps $name on its original lease through a dispatch wait', async action => {
    const wait = Promise.withResolvers<undefined>();
    state.beforeDispatch.mockReturnValue(wait.promise);
    const pending = Promise.allSettled([action.run(config('org-A'))]);
    lockLocalAccess();
    await requestLocalAccess('unlock');
    wait.resolve(undefined);
    expect(await pending).toEqual([
      { status: 'rejected', reason: expect.any(LocalAccessDeniedError) },
    ]);
    expect(state.journal).toEqual([]);
  });

  it('retains separate prepare leases across overlapping continuations', async () => {
    const firstResponse = Promise.withResolvers<{
      cloudAgentSessionId: string;
      kiloSessionId: string;
    }>();
    state.response.mockReturnValueOnce(firstResponse.promise);
    const manager = config();
    const first = manager.prepare(createInput);
    await vi.waitFor(() => {
      expect(state.journal).toHaveLength(1);
    });
    lockLocalAccess();
    await requestLocalAccess('unlock');
    state.response.mockResolvedValue({ cloudAgentSessionId: 'cloud-2', kiloSessionId: 'kilo-2' });
    const second = await manager.prepare(createInput);
    firstResponse.resolve({ cloudAgentSessionId: 'cloud-1', kiloSessionId: 'kilo-1' });
    const old = await first;
    await expect(manager.initiate(old)).rejects.toBeInstanceOf(LocalAccessDeniedError);
    await manager.initiate(second);
    expect(
      state.journal.filter(entry => entry.path.endsWith('initiateFromPreparedSession'))
    ).toEqual([
      {
        path: 'cloudAgentNext.initiateFromPreparedSession',
        user: 'A',
        input: { cloudAgentSessionId: 'cloud-2' },
      },
    ]);
  });

  it('does not replace an old prepare lease when two operations resolve to the same session', async () => {
    const response = Promise.withResolvers<{
      cloudAgentSessionId: string;
      kiloSessionId: string;
    }>();
    state.response.mockReturnValue(response.promise);
    const manager = config();
    // Match the SDK's adjacent prepare/initiate awaits, including concurrent completions.
    const create = async () => {
      const prepared = await manager.prepare(createInput);
      await manager.initiate(prepared);
    };
    const first = Promise.allSettled([create()]);
    await vi.waitFor(() => {
      expect(state.journal).toHaveLength(1);
    });
    lockLocalAccess();
    await requestLocalAccess('unlock');
    const second = Promise.allSettled([create()]);
    await vi.waitFor(() => {
      expect(state.journal).toHaveLength(2);
    });
    response.resolve({ cloudAgentSessionId: 'same-session', kiloSessionId: 'same-kilo-session' });
    expect(await first).toEqual([
      { status: 'rejected', reason: expect.any(LocalAccessDeniedError) },
    ]);
    expect(await second).toEqual([{ status: 'fulfilled', value: undefined }]);
    expect(
      state.journal.filter(entry => entry.path.endsWith('initiateFromPreparedSession'))
    ).toHaveLength(1);
  });

  it('destroys A callbacks and refuses A effects after B replaces the account', async () => {
    const manager = config();
    bumpAuthEpoch();
    confirmAuthenticatedOwner(beginAuthenticatedOwner(), 'B');
    await setLocalAccessOwner('B', currentAuthEpoch());
    setLocalAccessContextReady(true);
    await requestLocalAccess('unlock', true);
    manager.onToolAttachment?.('old-part', {
      mime: 'image/png',
      dataUrl: 'data:image/png;base64,AA==',
    });
    await expect(manager.api.interrupt({ sessionId: cloudId })).rejects.toBeInstanceOf(
      LocalAccessDeniedError
    );
    expect(state.cached).toEqual([]);
    expect(state.journal).toEqual([]);
    expect(state.destroyed).toBe(1);
  });

  it('allows locked stream tickets but rejects a token wait crossing account replacement', async () => {
    const manager = config();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ticket: 'read-ticket', expiresAt: 123 }));
    vi.stubGlobal('fetch', fetchMock);
    lockLocalAccess();
    await expect(manager.getTicket(cloudId)).resolves.toEqual({
      ticket: 'read-ticket',
      expiresAt: 123,
    });
    const token = Promise.withResolvers<string>();
    state.token.mockReturnValue(token.promise);
    const pending = Promise.allSettled([manager.getTicket(cloudId)]);
    bumpAuthEpoch();
    confirmAuthenticatedOwner(beginAuthenticatedOwner(), 'B');
    token.resolve('token-B');
    expect(await pending).toEqual([
      { status: 'rejected', reason: expect.any(LocalAccessDeniedError) },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
