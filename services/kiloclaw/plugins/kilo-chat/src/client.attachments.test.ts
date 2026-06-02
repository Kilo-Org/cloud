import { describe, expect, it, vi } from 'vitest';
import { createKiloChatClient } from './client';

const ATTACHMENT_ULID = '01JX0000000000000000000001';
const CONVERSATION_ULID = '01JX0000000000000000000002';

function makeInitResponse() {
  return {
    attachmentId: ATTACHMENT_ULID,
    putUrl: 'https://r2.example.com/upload-signed-url?sig=abc',
    putHeaders: { 'content-type': 'image/png', 'content-length': '1024' },
    putUrlExpiresAt: 1_700_000_900,
  };
}

describe('createKiloChatClient.initAttachment', () => {
  it('POSTs to /_kilo/kilo-chat/attachments/init and returns parsed init response', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(makeInitResponse()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://ctrl',
      gatewayToken: 'gwt',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.initAttachment({
      conversationId: CONVERSATION_ULID,
      mimeType: 'image/png',
      size: 1024,
      filename: 'photo.png',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://ctrl/_kilo/kilo-chat/attachments/init');
    const init2 = init as RequestInit;
    expect(init2.method).toBe('POST');
    const headers = new Headers(init2.headers);
    expect(headers.get('authorization')).toBe('Bearer gwt');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(init2.body as string)).toEqual({
      conversationId: CONVERSATION_ULID,
      mimeType: 'image/png',
      size: 1024,
      filename: 'photo.png',
    });
    expect(result).toEqual(makeInitResponse());
  });

  it('throws on non-2xx response including status and body', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://ctrl',
      gatewayToken: 'gwt',
      fetchImpl,
    });
    await expect(
      client.initAttachment({
        conversationId: CONVERSATION_ULID,
        mimeType: 'image/png',
        size: 100,
        filename: 'x.png',
      })
    ).rejects.toThrow(/500/);
  });

  it('throws when the response is missing required fields', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://ctrl',
      gatewayToken: 'gwt',
      fetchImpl,
    });
    await expect(
      client.initAttachment({
        conversationId: CONVERSATION_ULID,
        mimeType: 'image/png',
        size: 100,
        filename: 'x.png',
      })
    ).rejects.toThrow(/initAttachment/i);
  });
});

describe('createKiloChatClient.getAttachmentUrl', () => {
  it('GETs the signed url with conversationId in query and returns parsed JSON', async () => {
    const responseBody = {
      url: 'https://r2.example.com/get-signed-url?sig=xyz',
      mimeType: 'image/png',
      filename: 'photo.png',
      size: 1024,
      expiresAt: 1_700_000_000_000,
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://ctrl',
      gatewayToken: 'gwt',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.getAttachmentUrl({
      conversationId: CONVERSATION_ULID,
      attachmentId: ATTACHMENT_ULID,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      `http://ctrl/_kilo/kilo-chat/attachments/${ATTACHMENT_ULID}/url?conversationId=${CONVERSATION_ULID}`
    );
    const init2 = init as RequestInit;
    expect(init2.method).toBe('GET');
    const headers = new Headers(init2.headers);
    expect(headers.get('authorization')).toBe('Bearer gwt');
    expect(result).toEqual(responseBody);
  });

  it('URL-encodes the attachmentId', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            url: 'http://x',
            mimeType: 'image/png',
            size: 1,
            filename: 'x.png',
            expiresAt: 1,
          }),
          { status: 200 }
        )
    );
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://ctrl',
      gatewayToken: 'gwt',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.getAttachmentUrl({
      conversationId: CONVERSATION_ULID,
      attachmentId: 'weird/id?x=1',
    });

    const [url] = fetchImpl.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe('/_kilo/kilo-chat/attachments/weird%2Fid%3Fx%3D1/url');
    expect(parsed.searchParams.get('conversationId')).toBe(CONVERSATION_ULID);
  });

  it('throws on non-2xx response', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 404 })) as typeof fetch;
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://ctrl',
      gatewayToken: 'gwt',
      fetchImpl,
    });
    await expect(
      client.getAttachmentUrl({
        conversationId: CONVERSATION_ULID,
        attachmentId: ATTACHMENT_ULID,
      })
    ).rejects.toThrow(/404/);
  });
});
