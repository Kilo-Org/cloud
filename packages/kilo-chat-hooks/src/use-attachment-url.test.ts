import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { AttachmentGetUrlResponse, KiloChatClient } from '@kilocode/kilo-chat';

import { attachmentUrlKey } from './query-keys';
import {
  attachmentUrlQueryOptions,
  computeAttachmentUrlStaleMs,
  isAttachmentUrlValid,
} from './use-attachment-url';

describe('computeAttachmentUrlStaleMs', () => {
  it('returns the lifetime minus the refresh buffer in ms', () => {
    const now = 1_000_000_000_000;
    const expiresAt = Math.floor(now / 1000) + 3600;
    const stale = computeAttachmentUrlStaleMs(expiresAt, now);
    expect(stale).toBe(3_300_000);
  });

  it('returns 0 when the URL is already within the refresh buffer', () => {
    const now = 1_000_000_000_000;
    const expiresAt = Math.floor(now / 1000) + 60;
    expect(computeAttachmentUrlStaleMs(expiresAt, now)).toBe(0);
  });

  it('returns 0 when the URL is already expired', () => {
    const now = 1_000_000_000_000;
    const expiresAt = Math.floor(now / 1000) - 10;
    expect(computeAttachmentUrlStaleMs(expiresAt, now)).toBe(0);
  });
});

describe('isAttachmentUrlValid', () => {
  it('returns true while the signed URL has not expired', () => {
    const now = 1_000_000_000_000;
    const expiresAt = Math.floor(now / 1000) + 60;

    expect(isAttachmentUrlValid(expiresAt, now)).toBe(true);
  });

  it('returns false once the signed URL has expired', () => {
    const now = 1_000_000_000_000;
    const expiresAt = Math.floor(now / 1000) - 1;

    expect(isAttachmentUrlValid(expiresAt, now)).toBe(false);
  });
});

describe('attachmentUrlQueryOptions', () => {
  const conversationId = '01HV0000000000000000CONV01';
  const attachmentId = '01HV0000000000000000ATT001';

  function makeClient(response: AttachmentGetUrlResponse) {
    const getAttachmentUrl = vi.fn().mockResolvedValue(response);
    const client = { getAttachmentUrl } as unknown as KiloChatClient;
    return { client, getAttachmentUrl };
  }

  function makeQueryClient() {
    return new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  }

  it('produces a stable queryKey for the same ids', () => {
    const { client } = makeClient({
      url: 'https://r2/x',
      mimeType: 'image/png',
      size: 10,
      filename: 'a.png',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const a = attachmentUrlQueryOptions(client, conversationId, attachmentId);
    const b = attachmentUrlQueryOptions(client, conversationId, attachmentId);
    expect(a.queryKey).toEqual(b.queryKey);
    expect(a.queryKey).toEqual(attachmentUrlKey(conversationId, attachmentId));
  });

  it('fires queryFn only once across multiple observers on the same ids', async () => {
    const { client, getAttachmentUrl } = makeClient({
      url: 'https://r2/x',
      mimeType: 'image/png',
      size: 10,
      filename: 'a.png',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const queryClient = makeQueryClient();
    const options = attachmentUrlQueryOptions(client, conversationId, attachmentId);

    // Simulate multiple MessageAttachment renders subscribing to the same key.
    const obs1 = new QueryObserver(queryClient, options);
    const obs2 = new QueryObserver(queryClient, options);
    const obs3 = new QueryObserver(queryClient, options);
    const unsubs = [obs1.subscribe(() => {}), obs2.subscribe(() => {}), obs3.subscribe(() => {})];

    await queryClient.getQueryCache().find({ queryKey: options.queryKey })?.fetch();
    unsubs.forEach(u => u());

    expect(getAttachmentUrl).toHaveBeenCalledTimes(1);
  });

  it('does not refetch within the fresh window when a new observer subscribes', async () => {
    const { client, getAttachmentUrl } = makeClient({
      url: 'https://r2/x',
      mimeType: 'image/png',
      size: 10,
      filename: 'a.png',
      // 1h out: stale window starts only 5 min before, so we are squarely fresh.
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const queryClient = makeQueryClient();
    const options = attachmentUrlQueryOptions(client, conversationId, attachmentId);

    const obs1 = new QueryObserver(queryClient, options);
    const unsub1 = obs1.subscribe(() => {});
    await queryClient.getQueryCache().find({ queryKey: options.queryKey })?.fetch();
    unsub1();

    expect(getAttachmentUrl).toHaveBeenCalledTimes(1);

    // Re-subscribe (e.g. component remounts because of scroll virtualization).
    const obs2 = new QueryObserver(queryClient, options);
    const unsub2 = obs2.subscribe(() => {});
    // Yield so any auto-refetch would have a chance to fire.
    await new Promise(r => setTimeout(r, 0));
    unsub2();

    expect(getAttachmentUrl).toHaveBeenCalledTimes(1);
  });

  it('does not fetch when explicitly disabled', async () => {
    const { client, getAttachmentUrl } = makeClient({
      url: 'https://r2/x',
      mimeType: 'application/pdf',
      size: 10,
      filename: 'a.pdf',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const queryClient = makeQueryClient();
    const options = attachmentUrlQueryOptions(client, conversationId, attachmentId, {
      enabled: false,
    });

    const obs = new QueryObserver(queryClient, options);
    const unsub = obs.subscribe(() => {});
    await new Promise(r => setTimeout(r, 0));
    unsub();

    expect(getAttachmentUrl).not.toHaveBeenCalled();
  });

  it('allows disabled queries to fetch on explicit refetch', async () => {
    const { client, getAttachmentUrl } = makeClient({
      url: 'https://r2/x',
      mimeType: 'application/pdf',
      size: 10,
      filename: 'a.pdf',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const queryClient = makeQueryClient();
    const options = attachmentUrlQueryOptions(client, conversationId, attachmentId, {
      enabled: false,
    });

    const obs = new QueryObserver(queryClient, options);
    const unsub = obs.subscribe(() => {});
    await obs.refetch();
    unsub();

    expect(getAttachmentUrl).toHaveBeenCalledTimes(1);
  });

  it('refetches stale signed URLs when window focus returns', async () => {
    const now = 1_000_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const { client, getAttachmentUrl } = makeClient({
      url: 'https://r2/fresh',
      mimeType: 'image/png',
      size: 10,
      filename: 'a.png',
      expiresAt: Math.floor(now / 1000) + 3600,
    });
    getAttachmentUrl
      .mockResolvedValueOnce({
        url: 'https://r2/initial',
        mimeType: 'image/png',
        size: 10,
        filename: 'a.png',
        expiresAt: Math.floor((now + 6 * 60 * 1000) / 1000),
      })
      .mockResolvedValueOnce({
        url: 'https://r2/refreshed',
        mimeType: 'image/png',
        size: 10,
        filename: 'a.png',
        expiresAt: Math.floor((now + 3600 * 1000) / 1000),
      });

    const queryClient = makeQueryClient();
    const options = attachmentUrlQueryOptions(client, conversationId, attachmentId);
    const obs = new QueryObserver(queryClient, options);
    const unsub = obs.subscribe(() => {});

    await queryClient.getQueryCache().find({ queryKey: options.queryKey })?.fetch();
    expect(getAttachmentUrl).toHaveBeenCalledTimes(1);

    vi.setSystemTime(now + 2 * 60 * 1000);
    queryClient.getQueryCache().onFocus();

    await Promise.resolve();
    unsub();
    vi.useRealTimers();

    expect(getAttachmentUrl).toHaveBeenCalledTimes(2);
  });

  it('does not call queryFn when ids are null', async () => {
    const { client, getAttachmentUrl } = makeClient({
      url: 'https://r2/x',
      mimeType: 'image/png',
      size: 10,
      filename: 'a.png',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const queryClient = makeQueryClient();
    const options = attachmentUrlQueryOptions(client, null, null);

    const obs = new QueryObserver(queryClient, options);
    const unsub = obs.subscribe(() => {});
    await new Promise(r => setTimeout(r, 0));
    unsub();

    expect(getAttachmentUrl).not.toHaveBeenCalled();
  });
});
