import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { router } from '../auth.js';
import { createSessionManagementHandlers } from './session-management.js';
import { createSessionSendHandlers } from './session-send.js';
import { requireCurrentSessionAccess } from '../../session-access.js';
import type { Env } from '../../types.js';

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));
vi.mock('../../session-access.js', () => ({ requireCurrentSessionAccess: vi.fn() }));

const api = router({ ...createSessionSendHandlers(), ...createSessionManagementHandlers() });
const messageId = 'msg_000000000001AbCdEfGhIjKlMn';

function fixture() {
  const control = {
    cancelQueuedMessage: vi.fn().mockResolvedValue({ dropped: true }),
    admitSubmittedMessage: vi.fn(),
  };
  const legacy = { cancelQueuedMessage: vi.fn().mockResolvedValue({ dropped: false }) };
  const controlNamespace = { idFromName: vi.fn(name => name), get: vi.fn(() => control) };
  const legacyNamespace = { idFromName: vi.fn(name => name), get: vi.fn(() => legacy) };
  const env = {
    SANDBOX_SESSION: controlNamespace,
    CLOUD_AGENT_SESSION: legacyNamespace,
  } as unknown as Env;
  const call = (path: string, input: unknown, authenticated = true) => {
    const request = new Request(`https://queue.test/trpc/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return fetchRequestHandler({
      endpoint: '/trpc',
      req: request,
      router: api,
      createContext: () => ({
        env,
        request,
        userId: authenticated ? 'owner' : '',
        authToken: authenticated ? 'fixture-token' : '',
      }),
    });
  };
  return { control, legacy, controlNamespace, legacyNamespace, call };
}

beforeEach(() => {
  vi.mocked(requireCurrentSessionAccess).mockReset();
});

describe('public queue RPC routing', () => {
  it.each(['workspace', 'agent'])(
    'routes %s cancellation through its own plane without changing the result',
    async plane => {
      const { call, control, legacy, controlNamespace, legacyNamespace } = fixture();
      const sessionId = `${plane}_11111111-1111-4111-8111-111111111111`;
      const response = await call('cancelQueuedMessage', { sessionId, messageId });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: { data: { dropped: plane === 'workspace' } },
      });
      const selected = plane === 'workspace' ? control : legacy;
      const unused = plane === 'workspace' ? legacy : control;
      expect(selected.cancelQueuedMessage).toHaveBeenCalledExactlyOnceWith(messageId);
      expect(unused.cancelQueuedMessage).not.toHaveBeenCalled();
      expect(
        (plane === 'workspace' ? controlNamespace : legacyNamespace).idFromName
      ).toHaveBeenCalledWith(`owner:${sessionId}`);
    }
  );

  it('projects the actual control admission failure contract to HTTP 429', async () => {
    const { control, call } = fixture();
    control.admitSubmittedMessage.mockResolvedValue({
      success: false,
      code: 'PENDING_QUEUE_FULL',
      error: 'Pending message queue is full (10)',
    });
    const response = await call('send', {
      cloudAgentSessionId: 'workspace_11111111-1111-4111-8111-111111111111',
      message: { id: messageId, prompt: 'overflow' },
      agent: { mode: 'code', model: 'test/model' },
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      error: { data: { code: 'TOO_MANY_REQUESTS', clientError: { retryable: true } } },
    });
    expect(control.admitSubmittedMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        userId: 'owner',
        turn: { type: 'prompt', id: messageId, prompt: 'overflow' },
      })
    );
  });

  it('never resolves a mutation receiver for unauthenticated or forbidden access', async () => {
    const { call, controlNamespace, legacyNamespace } = fixture();
    const input = { sessionId: 'workspace_11111111-1111-4111-8111-111111111111', messageId };
    expect((await call('cancelQueuedMessage', input, false)).status).toBe(401);
    vi.mocked(requireCurrentSessionAccess).mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    expect((await call('cancelQueuedMessage', input)).status).toBe(403);
    expect(controlNamespace.get).not.toHaveBeenCalled();
    expect(legacyNamespace.get).not.toHaveBeenCalled();
  });
});
