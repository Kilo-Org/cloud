import { describe, expect, it, vi } from 'vitest';
import { downloadInboundAttachments } from './dispatch.js';
import { ATTACHMENT_MAX_BYTES } from '../synced/schemas.js';
import type { KiloChatClient } from '../client.js';

const ATT_1 = '01JX0000000000000000000A01';
const ATT_2 = '01JX0000000000000000000A02';

type FakeAttachment = {
  attachmentId: string;
  mimeType: string;
  size: number;
  filename: string;
};

function makeClient(getResponses: Record<string, { url: string } | { throws: Error }>) {
  return {
    getAttachmentUrl: vi.fn(async ({ attachmentId }: { attachmentId: string }) => {
      const r = getResponses[attachmentId];
      if (!r) throw new Error(`no mock for ${attachmentId}`);
      if ('throws' in r) throw r.throws;
      return {
        url: r.url,
        mimeType: 'image/png',
        size: 4,
        filename: 'x.png',
        expiresAt: 1,
      };
    }),
  } as unknown as KiloChatClient;
}

describe('downloadInboundAttachments', () => {
  it('downloads each attachment and saves it via saveMediaBuffer', async () => {
    const attachments: FakeAttachment[] = [
      { attachmentId: ATT_1, mimeType: 'image/png', size: 4, filename: 'one.png' },
      { attachmentId: ATT_2, mimeType: 'image/jpeg', size: 5, filename: 'two.jpg' },
    ];

    const client = makeClient({
      [ATT_1]: { url: 'https://r2/one.png' },
      [ATT_2]: { url: 'https://r2/two.jpg' },
    });

    const fetchedUrls: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const u = String(input);
      fetchedUrls.push(u);
      const bytes = u.endsWith('one.png')
        ? new Uint8Array([1, 2, 3, 4])
        : new Uint8Array([9, 8, 7, 6, 5]);
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }) as typeof fetch;

    const saved: Array<{
      buffer: Buffer;
      contentType?: string;
      direction: string;
      maxBytes?: number;
      filename?: string;
    }> = [];
    const saveMediaBuffer = vi.fn(
      async (
        buffer: Buffer,
        contentType?: string,
        direction?: string,
        maxBytes?: number,
        filename?: string
      ) => {
        saved.push({ buffer, contentType, direction: direction ?? '', maxBytes, filename });
        const id = `saved-${saved.length}`;
        return {
          id,
          path: `/tmp/media/inbound/${id}`,
          size: buffer.length,
          contentType,
        };
      }
    );

    const result = await downloadInboundAttachments({
      client,
      conversationId: 'conv-1',
      attachments,
      saveMediaBuffer,
      fetchImpl,
    });

    expect(client.getAttachmentUrl).toHaveBeenCalledTimes(2);
    expect(fetchedUrls).toEqual(['https://r2/one.png', 'https://r2/two.jpg']);
    expect(saveMediaBuffer).toHaveBeenCalledTimes(2);
    expect(saved[0].direction).toBe('inbound');
    expect(saved[0].filename).toBe('one.png');
    expect(saved[0].contentType).toBe('image/png');

    expect(result.mediaPaths).toEqual(['/tmp/media/inbound/saved-1', '/tmp/media/inbound/saved-2']);
    expect(result.mediaTypes).toEqual(['image/png', 'image/jpeg']);
    expect(result.failedCount).toBe(0);
  });

  it('skips attachments whose presigned URL fetch fails (non-2xx)', async () => {
    const attachments: FakeAttachment[] = [
      { attachmentId: ATT_1, mimeType: 'image/png', size: 4, filename: 'one.png' },
      { attachmentId: ATT_2, mimeType: 'image/jpeg', size: 5, filename: 'two.jpg' },
    ];

    const client = makeClient({
      [ATT_1]: { url: 'https://r2/one.png' },
      [ATT_2]: { url: 'https://r2/two.jpg' },
    });

    const fetchImpl = (async (input: string | URL) => {
      const u = String(input);
      if (u.endsWith('two.jpg')) return new Response('gone', { status: 404 });
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    }) as typeof fetch;

    const saveMediaBuffer = vi.fn(async (buffer: Buffer) => ({
      id: 'a',
      path: '/tmp/media/inbound/a',
      size: buffer.length,
    }));

    const result = await downloadInboundAttachments({
      client,
      conversationId: 'conv-1',
      attachments,
      saveMediaBuffer,
      fetchImpl,
    });

    expect(saveMediaBuffer).toHaveBeenCalledTimes(1);
    expect(result.mediaPaths).toEqual(['/tmp/media/inbound/a']);
    expect(result.mediaTypes).toEqual(['image/png']);
    expect(result.failedCount).toBe(1);
  });

  it('skips attachments whose getAttachmentUrl throws', async () => {
    const attachments: FakeAttachment[] = [
      { attachmentId: ATT_1, mimeType: 'image/png', size: 4, filename: 'one.png' },
    ];

    const client = makeClient({
      [ATT_1]: { throws: new Error('forbidden') },
    });

    const fetchImpl = (async () => new Response(null, { status: 200 })) as typeof fetch;
    const saveMediaBuffer = vi.fn(async (buffer: Buffer) => ({
      id: 'a',
      path: '/tmp/x',
      size: buffer.length,
    }));

    const result = await downloadInboundAttachments({
      client,
      conversationId: 'conv-1',
      attachments,
      saveMediaBuffer,
      fetchImpl,
    });

    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(result.mediaPaths).toEqual([]);
    expect(result.mediaTypes).toEqual([]);
    expect(result.failedCount).toBe(1);
  });

  it('skips oversized responses before buffering the body', async () => {
    const attachments: FakeAttachment[] = [
      {
        attachmentId: ATT_1,
        mimeType: 'application/octet-stream',
        size: ATTACHMENT_MAX_BYTES + 1,
        filename: 'oversized.bin',
      },
    ];
    const client = makeClient({
      [ATT_1]: { url: 'https://r2/oversized.bin' },
    });
    const arrayBuffer = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer);
    const fetchImpl = (async () =>
      ({
        ok: true,
        headers: new Headers({ 'content-length': String(ATTACHMENT_MAX_BYTES + 1) }),
        arrayBuffer,
        body: { cancel: vi.fn() },
      }) as unknown as Response) as typeof fetch;
    const saveMediaBuffer = vi.fn(async (buffer: Buffer) => ({
      id: 'a',
      path: '/tmp/x',
      size: buffer.length,
    }));

    const result = await downloadInboundAttachments({
      client,
      conversationId: 'conv-1',
      attachments,
      saveMediaBuffer,
      fetchImpl,
    });

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(result.failedCount).toBe(1);
  });

  it('returns empty arrays when there are no attachments', async () => {
    const client = makeClient({});
    const fetchImpl = (async () => new Response(null, { status: 200 })) as typeof fetch;
    const saveMediaBuffer = vi.fn();

    const result = await downloadInboundAttachments({
      client,
      conversationId: 'conv-1',
      attachments: [],
      saveMediaBuffer,
      fetchImpl,
    });

    expect(result.mediaPaths).toEqual([]);
    expect(result.mediaTypes).toEqual([]);
    expect(result.failedCount).toBe(0);
    expect(saveMediaBuffer).not.toHaveBeenCalled();
  });
});
