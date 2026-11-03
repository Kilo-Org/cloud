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
  const controlNamespace = { idFromName: vi.fn(name => name), get: vi.fn(() => control) };
  const env = {
    SANDBOX_SESSION: controlNamespace,
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
  return { control, controlNamespace, call };
}

beforeEach(() => {
  vi.mocked(requireCurrentSessionAccess).mockReset();
});

describe('public queue RPC routing', () => {
  it.each(['workspace', 'agent'])(
    'accepts workspace cancellation and rejects retired agent IDs: %s',
    async plane => {
      const { call, control, controlNamespace } = fixture();
      const sessionId = `${plane}_11111111-1111-4111-8111-111111111111`;
      const response = await call('cancelQueuedMessage', { sessionId, messageId });
      if (plane === 'agent') {
        expect(response.status).toBe(400);
        expect(controlNamespace.get).not.toHaveBeenCalled();
        expect(requireCurrentSessionAccess).not.toHaveBeenCalled();
        return;
      }
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: { data: { dropped: true } },
      });
      expect(control.cancelQueuedMessage).toHaveBeenCalledExactlyOnceWith(messageId);
      expect(controlNamespace.idFromName).toHaveBeenCalledWith(`owner:${sessionId}`);
    }
  );

  it('never resolves a mutation receiver for unauthenticated or forbidden access', async () => {
    const { call, controlNamespace } = fixture();
    const input = { sessionId: 'workspace_11111111-1111-4111-8111-111111111111', messageId };
    expect((await call('cancelQueuedMessage', input, false)).status).toBe(401);
    vi.mocked(requireCurrentSessionAccess).mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    expect((await call('cancelQueuedMessage', input)).status).toBe(403);
    expect(controlNamespace.get).not.toHaveBeenCalled();
  });
});
