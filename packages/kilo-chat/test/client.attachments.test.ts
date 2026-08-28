import { describe, expect, it, vi } from 'vitest';
import { KiloChatClient } from '../src/client';
import type { KiloChatClientConfig } from '../src/types';

const noopEventService: KiloChatClientConfig['eventService'] = {
  on: () => () => {},
  subscribe: () => () => {},
} as unknown as KiloChatClientConfig['eventService'];

function makeClient(fetchFn: typeof globalThis.fetch) {
  return new KiloChatClient({
    eventService: noopEventService,
    baseUrl: 'https://chat.test',
    getToken: async () => 'tok',
    fetch: fetchFn,
  });
}

describe('KiloChatClient.getAttachmentUrl', () => {
  it('GETs /v1/attachments/:id/url with conversationId query and parses the response', async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input instanceof Request ? input.url : input.toString()).toBe(
        'https://chat.test/v1/attachments/01HV0000000000000000000001/url' +
          '?conversationId=01HV0000000000000000000000'
      );
      expect(init?.method ?? 'GET').toBe('GET');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer tok' });
      return new Response(
        JSON.stringify({
          url: 'https://r2.test/get?sig=x',
          mimeType: 'image/png',
          size: 42,
          filename: 'a.png',
          expiresAt: 1_700_000_000,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    const client = makeClient(fetchFn as unknown as typeof globalThis.fetch);
    const res = await client.getAttachmentUrl({
      attachmentId: '01HV0000000000000000000001',
      conversationId: '01HV0000000000000000000000',
    });
    expect(res.url).toContain('https://r2.test/get');
    expect(res.mimeType).toBe('image/png');
    expect(res.expiresAt).toBe(1_700_000_000);
  });
});

describe('attachment admission', () => {
  it('keeps downloads available while refusing new uploads for a locked owner', async () => {
    const requests: string[] = [];
    const client = new KiloChatClient({
      eventService: noopEventService,
      baseUrl: 'https://chat.test',
      getToken: async () => 'tok',
      canPublish: () => true,
      captureOperationAdmission: () => {
        throw new Error('locked');
      },
      fetch: async input => {
        requests.push(input instanceof Request ? input.url : input.toString());
        return Response.json({
          url: 'https://r2.test/download',
          mimeType: 'image/png',
          size: 42,
          filename: 'a.png',
          expiresAt: 1_700_000_000,
        });
      },
    });
    await expect(
      client.initAttachment({
        conversationId: 'c1',
        mimeType: 'image/png',
        filename: 'a.png',
        size: 42,
        idempotencyKey: 'tmp-1',
      })
    ).rejects.toThrow('locked');
    await expect(
      client.getAttachmentUrl({ conversationId: 'c1', attachmentId: 'a1' })
    ).resolves.toMatchObject({ url: 'https://r2.test/download' });
    expect(requests).toEqual(['https://chat.test/v1/attachments/a1/url?conversationId=c1']);
  });
});

describe('KiloChatClient.initAttachment', () => {
  it('POSTs body to /v1/attachments/init and parses the response', async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input instanceof Request ? input.url : input.toString()).toBe(
        'https://chat.test/v1/attachments/init'
      );
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer tok' });
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({
        conversationId: '01HV0000000000000000000000',
        mimeType: 'image/png',
        size: 42,
        filename: 'a.png',
        idempotencyKey: 'tmp-1',
      });
      return new Response(
        JSON.stringify({
          attachmentId: '01HV0000000000000000000001',
          putUrl: 'https://r2.test/put',
          putHeaders: { 'Content-Type': 'image/png', 'Content-Length': '42' },
          putUrlExpiresAt: 1_700_000_900,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    const client = makeClient(fetchFn as unknown as typeof globalThis.fetch);
    const res = await client.initAttachment({
      conversationId: '01HV0000000000000000000000',
      mimeType: 'image/png',
      size: 42,
      filename: 'a.png',
      idempotencyKey: 'tmp-1',
    });
    expect(res).toEqual({
      attachmentId: '01HV0000000000000000000001',
      putUrl: 'https://r2.test/put',
      putHeaders: { 'Content-Type': 'image/png', 'Content-Length': '42' },
      putUrlExpiresAt: 1_700_000_900,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
