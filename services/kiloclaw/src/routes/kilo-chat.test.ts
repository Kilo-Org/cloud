import { describe, expect, it, vi } from 'vitest';
import { kiloChatProxy } from './kilo-chat';
import { deriveGatewayToken } from '../auth/gateway-token';

const GATEWAY_TOKEN_SECRET = 'test-gateway-secret';
const SANDBOX_ID = 'sbx_test-1';

/**
 * Minimal KILOCHAT fake. Tests supply the method they care about and pass
 * through whatever result they want kilo-chat's RPC to return.
 */
function fakeKilochat(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    botCreateMessage: vi.fn(),
    botEditMessage: vi.fn(),
    botDeleteMessage: vi.fn(),
    botAddReaction: vi.fn(),
    botRemoveReaction: vi.fn(),
    botSendTyping: vi.fn(),
    ...overrides,
  };
}

type ProxyEnv = Parameters<typeof kiloChatProxy.fetch>[1];

function makeEnv(overrides: { kilochat?: ReturnType<typeof fakeKilochat> } = {}): ProxyEnv {
  return {
    GATEWAY_TOKEN_SECRET,
    KILOCHAT: overrides.kilochat ?? fakeKilochat(),
  } as unknown as ProxyEnv;
}

async function validBearer(): Promise<string> {
  return deriveGatewayToken(SANDBOX_ID, GATEWAY_TOKEN_SECRET);
}

type ReqInit = Omit<RequestInit, 'body'> & {
  auth?: string | false;
  body?: unknown;
};

function req(path: string, init: ReqInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (init.auth !== false) {
    headers.set('authorization', `Bearer ${init.auth}`);
  }
  const { body, auth: _auth, ...rest } = init;
  return new Request(`http://kc.test${path}`, {
    ...rest,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('/api/kilo-chat proxy — auth', () => {
  it('401 when authorization is missing', async () => {
    const res = await kiloChatProxy.fetch(
      req('/sandboxes/sbx_test-1/messages', {
        method: 'POST',
        body: { conversationId: 'c1', content: [{ type: 'text', text: 'hi' }] },
        auth: false,
      }),
      makeEnv()
    );
    expect(res.status).toBe(401);
  });

  it('403 when bearer is not the correct gateway token for the sandbox', async () => {
    const res = await kiloChatProxy.fetch(
      req('/sandboxes/sbx_test-1/messages', {
        method: 'POST',
        body: { conversationId: 'c1', content: [{ type: 'text', text: 'hi' }] },
        auth: 'wrong-token',
      }),
      makeEnv()
    );
    expect(res.status).toBe(403);
  });

  it('400 when sandboxId in the URL is malformed', async () => {
    const bearer = await validBearer();
    const res = await kiloChatProxy.fetch(
      req('/sandboxes/has%20spaces/messages', {
        method: 'POST',
        body: { conversationId: 'c1', content: [{ type: 'text', text: 'hi' }] },
        auth: bearer,
      }),
      makeEnv()
    );
    expect(res.status).toBe(400);
  });

  it('503 when GATEWAY_TOKEN_SECRET is missing', async () => {
    const bearer = await validBearer();
    const env = { KILOCHAT: fakeKilochat() } as unknown as Parameters<typeof kiloChatProxy.fetch>[1];
    const res = await kiloChatProxy.fetch(
      req('/sandboxes/sbx_test-1/messages', {
        method: 'POST',
        body: { conversationId: 'c1', content: [{ type: 'text', text: 'hi' }] },
        auth: bearer,
      }),
      env
    );
    expect(res.status).toBe(503);
  });

  it('503 when KILOCHAT service binding is missing', async () => {
    const bearer = await validBearer();
    const env = { GATEWAY_TOKEN_SECRET } as unknown as Parameters<typeof kiloChatProxy.fetch>[1];
    const res = await kiloChatProxy.fetch(
      req('/sandboxes/sbx_test-1/messages', {
        method: 'POST',
        body: { conversationId: 'c1', content: [{ type: 'text', text: 'hi' }] },
        auth: bearer,
      }),
      env
    );
    expect(res.status).toBe(503);
  });

  it('a bearer valid for sandbox A cannot be used to talk to sandbox B', async () => {
    // Token derived for sandbox-A should not pass validation for sandbox-B.
    const tokenForA = await deriveGatewayToken('sandbox-A', GATEWAY_TOKEN_SECRET);
    const res = await kiloChatProxy.fetch(
      req('/sandboxes/sandbox-B/messages', {
        method: 'POST',
        body: { conversationId: 'c1', content: [{ type: 'text', text: 'hi' }] },
        auth: tokenForA,
      }),
      makeEnv()
    );
    expect(res.status).toBe(403);
  });
});

describe('/api/kilo-chat proxy — dispatch', () => {
  it('POST messages: forwards to botCreateMessage with verified sandboxId and maps 201', async () => {
    const bearer = await validBearer();
    const kilochat = fakeKilochat();
    kilochat.botCreateMessage.mockResolvedValue({
      ok: true,
      messageId: '01ABCDEFGHIJKLMNOPQRSTUVWX',
      version: 1,
    });
    const res = await kiloChatProxy.fetch(
      req('/sandboxes/sbx_test-1/messages', {
        method: 'POST',
        body: { conversationId: 'c1', content: [{ type: 'text', text: 'hello' }] },
        auth: bearer,
      }),
      makeEnv({ kilochat })
    );
    expect(res.status).toBe(201);
    expect(kilochat.botCreateMessage).toHaveBeenCalledWith({
      sandboxId: SANDBOX_ID,
      conversationId: 'c1',
      content: [{ type: 'text', text: 'hello' }],
      inReplyToMessageId: undefined,
    });
    expect(await res.json()).toEqual({
      messageId: '01ABCDEFGHIJKLMNOPQRSTUVWX',
      version: 1,
    });
  });

  it('POST messages: forbidden result maps to 403', async () => {
    const bearer = await validBearer();
    const kilochat = fakeKilochat();
    kilochat.botCreateMessage.mockResolvedValue({
      ok: false,
      code: 'forbidden',
      error: 'Forbidden',
    });
    const res = await kiloChatProxy.fetch(
      req('/sandboxes/sbx_test-1/messages', {
        method: 'POST',
        body: { conversationId: 'c1', content: [{ type: 'text', text: 'hi' }] },
        auth: bearer,
      }),
      makeEnv({ kilochat })
    );
    expect(res.status).toBe(403);
  });

  it('PATCH messages/:id: conflict result maps to 409 with server version', async () => {
    const bearer = await validBearer();
    const kilochat = fakeKilochat();
    kilochat.botEditMessage.mockResolvedValue({
      ok: true,
      conflict: true,
      messageId: '01ABCDEFGHIJKLMNOPQRSTUVWX',
      version: 7,
    });
    const res = await kiloChatProxy.fetch(
      req('/sandboxes/sbx_test-1/messages/01ABCDEFGHIJKLMNOPQRSTUVWX', {
        method: 'PATCH',
        body: {
          conversationId: 'c1',
          content: [{ type: 'text', text: 'stale' }],
          version: 2,
        },
        auth: bearer,
      }),
      makeEnv({ kilochat })
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ version: 7 });
  });

  it('DELETE messages/:id: 404 when RPC returns not_found', async () => {
    const bearer = await validBearer();
    const kilochat = fakeKilochat();
    kilochat.botDeleteMessage.mockResolvedValue({
      ok: false,
      code: 'not_found',
      error: 'Not found',
    });
    const res = await kiloChatProxy.fetch(
      req('/sandboxes/sbx_test-1/messages/01ABCDEFGHIJKLMNOPQRSTUVWX', {
        method: 'DELETE',
        body: { conversationId: 'c1' },
        auth: bearer,
      }),
      makeEnv({ kilochat })
    );
    expect(res.status).toBe(404);
  });

  it('POST typing: 204 on success', async () => {
    const bearer = await validBearer();
    const kilochat = fakeKilochat();
    kilochat.botSendTyping.mockResolvedValue({ ok: true });
    const res = await kiloChatProxy.fetch(
      req('/sandboxes/sbx_test-1/conversations/01ABCDEFGHIJKLMNOPQRSTUVWX/typing', {
        method: 'POST',
        auth: bearer,
      }),
      makeEnv({ kilochat })
    );
    expect(res.status).toBe(204);
    expect(kilochat.botSendTyping).toHaveBeenCalledWith({
      sandboxId: SANDBOX_ID,
      conversationId: '01ABCDEFGHIJKLMNOPQRSTUVWX',
    });
  });

  it('POST reactions: 201 when added, 200 when already present', async () => {
    const bearer = await validBearer();
    const kilochat = fakeKilochat();
    kilochat.botAddReaction.mockResolvedValueOnce({
      ok: true,
      id: 'rxn-1',
      added: true,
    });
    kilochat.botAddReaction.mockResolvedValueOnce({
      ok: true,
      id: 'rxn-1',
      added: false,
    });

    const first = await kiloChatProxy.fetch(
      req('/sandboxes/sbx_test-1/messages/01ABCDEFGHIJKLMNOPQRSTUVWX/reactions', {
        method: 'POST',
        body: { conversationId: 'c1', emoji: '👍' },
        auth: bearer,
      }),
      makeEnv({ kilochat })
    );
    expect(first.status).toBe(201);

    const second = await kiloChatProxy.fetch(
      req('/sandboxes/sbx_test-1/messages/01ABCDEFGHIJKLMNOPQRSTUVWX/reactions', {
        method: 'POST',
        body: { conversationId: 'c1', emoji: '👍' },
        auth: bearer,
      }),
      makeEnv({ kilochat })
    );
    expect(second.status).toBe(200);
  });

  it('413 when content-length exceeds the cap', async () => {
    const bearer = await validBearer();
    const kilochat = fakeKilochat();
    const request = new Request('http://kc.test/sandboxes/sbx_test-1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
        'content-length': String(2 * 1024 * 1024),
      },
      body: 'x'.repeat(2 * 1024 * 1024),
    });
    const res = await kiloChatProxy.fetch(request, makeEnv({ kilochat }));
    expect(res.status).toBe(413);
    expect(kilochat.botCreateMessage).not.toHaveBeenCalled();
  });
});
