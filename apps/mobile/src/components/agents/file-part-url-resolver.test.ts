/* eslint-disable import/first -- mocks must be defined before the module under test is imported */
/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom) */
/* eslint-disable max-lines -- cohesive resolver suite: cache seeding, sweeper, renew-on-read, and refresh coalescing share one harness */
import { type FilePart } from '@kilocode/cloud-agent-sdk';
import { createElement, type FC } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getAttachmentDownloadUrlMutate = vi.hoisted(() => vi.fn());

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cloudAgentNext: {
      getAttachmentDownloadUrl: { mutate: getAttachmentDownloadUrlMutate },
    },
  },
}));

vi.mock('expo-file-system', () => ({
  Directory: vi.fn(),
  File: vi.fn(),
  Paths: { cache: 'file:///cache' },
}));

vi.mock('@/lib/share-remote-file', () => ({
  getSafeCacheFilename: ({ id, filename }: { id: string; filename: string }) => `${id}-${filename}`,
}));

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';

import {
  __resetFilePartCacheForTests,
  cacheFilePart,
  clearFilePartCache,
  getFilePartCacheEntry,
  overwriteFilePartCacheEntry,
} from './file-part-cache';
import {
  __resetFilePartUrlResolverForTests,
  refreshFilePartUrl,
  useResolvedFilePartUrl,
} from './file-part-url-resolver';

function attachmentUrl(uuid: string, filename: string): string {
  return `file:///tmp/attachments/agent-1/user-1/${uuid}/${filename}`;
}

function makeFilePart(id: string, uuid: string, filename: string): FilePart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'file',
    mime: 'image/png',
    url: attachmentUrl(uuid, filename),
    filename,
  };
}

/** Seed an attachment entry that already carries a presigned URL. */
function cacheRenewableEntry(
  partId: string,
  attachment: { uuid: string; filename: string },
  configure: { urlExpiresAt?: number; url?: string }
): void {
  cacheFilePart(partId, {
    url: attachmentUrl(attachment.uuid, attachment.filename),
    mime: 'image/png',
    filename: attachment.filename,
  });
  overwriteFilePartCacheEntry(partId, {
    url: configure.url ?? 'https://r2.example/signed',
    mime: 'image/png',
    filename: attachment.filename,
    ...(configure.urlExpiresAt !== undefined ? { urlExpiresAt: configure.urlExpiresAt } : {}),
  });
}

const ResolverProbe: FC<{ part: FilePart }> = ({ part }) => {
  const resolved = useResolvedFilePartUrl(part);
  return createElement(
    'Text',
    null,
    `${resolved.status}|${resolved.url ?? ''}|${resolved.renewing ?? false}`
  );
};

const mounted: TestRenderer.ReactTestRenderer[] = [];

async function mountProbe(part: FilePart): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(createElement(ResolverProbe, { part }));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mounted.push(renderer);
  return renderer;
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  const node = renderer.root.find(n => typeof n.type === 'string' && (n.type as string) === 'Text');
  return node.props.children as string;
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

type PresignPath = 'initial' | 'renew-on-read' | 'sweep' | 'refresh';
type PresignResult = { signedUrl: string; key: string; expiresAt: string };

async function startPendingPresign(path: PresignPath) {
  const uuid = '11111111-1111-4111-8111-111111111111';
  const part = makeFilePart('part-1', uuid, 'a.png');
  cacheFilePart(part.id, part);
  if (path !== 'initial') {
    cacheRenewableEntry(
      part.id,
      { uuid, filename: 'a.png' },
      { urlExpiresAt: Date.now() + (path === 'sweep' ? 130_000 : -1000) }
    );
  }
  if (path === 'refresh') {
    return { refresh: refreshFilePartUrl(part.id) };
  }
  const renderer = await mountProbe(part);
  if (path === 'sweep') {
    advance(30_000);
  }
  act(() => {
    renderer.unmount();
  });
  return { refresh: undefined };
}

function settlePresign(
  request: PromiseWithResolvers<PresignResult>,
  outcome: 'success' | 'failure',
  signedUrl: string
): void {
  if (outcome === 'failure') {
    request.reject(new Error('presign failed'));
    return;
  }
  request.resolve({ signedUrl, key: 'k', expiresAt: '2099-01-01T00:00:00Z' });
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  __resetFilePartCacheForTests();
  __resetFilePartUrlResolverForTests();
  getAttachmentDownloadUrlMutate.mockReset();
  getAttachmentDownloadUrlMutate.mockResolvedValue({
    signedUrl: 'https://r2.example/signed',
    key: 'k',
    expiresAt: '2099-01-01T00:00:00Z',
  });
});

afterEach(() => {
  act(() => {
    for (const renderer of mounted) {
      renderer.unmount();
    }
  });
  mounted.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useResolvedFilePartUrl sweeper', () => {
  it('starts one shared 30s interval for every subscriber', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const due = Date.now() + 900_000;
    const parts = [
      { id: 'part-1', uuid: '11111111-1111-4111-8111-111111111111', filename: 'a.png' },
      { id: 'part-2', uuid: '22222222-2222-4222-8222-222222222222', filename: 'b.png' },
      { id: 'part-3', uuid: '33333333-3333-4333-8333-333333333333', filename: 'c.png' },
    ];
    for (const { id, uuid, filename } of parts) {
      cacheRenewableEntry(id, { uuid, filename }, { urlExpiresAt: due });
      // eslint-disable-next-line no-await-in-loop -- each mount must commit sequentially under act
      await mountProbe(makeFilePart(id, uuid, filename));
    }

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
  });

  it('renews each due entry exactly once per sweep', async () => {
    vi.spyOn(globalThis, 'setInterval');
    const uuid1 = '11111111-1111-4111-8111-111111111111';
    const uuid2 = '22222222-2222-4222-8222-222222222222';
    // Not due on read (> 120s), but due after the first 30s tick.
    const nearlyDue = Date.now() + 130_000;
    cacheRenewableEntry('part-1', { uuid: uuid1, filename: 'a.png' }, { urlExpiresAt: nearlyDue });
    cacheRenewableEntry('part-2', { uuid: uuid2, filename: 'b.png' }, { urlExpiresAt: nearlyDue });
    await mountProbe(makeFilePart('part-1', uuid1, 'a.png'));
    await mountProbe(makeFilePart('part-2', uuid2, 'b.png'));

    expect(getAttachmentDownloadUrlMutate).not.toHaveBeenCalled();

    advance(30_000);

    expect(getAttachmentDownloadUrlMutate).toHaveBeenCalledTimes(2);
    expect(getAttachmentDownloadUrlMutate).toHaveBeenCalledWith({
      messageUuid: uuid1,
      filename: 'a.png',
    });
    expect(getAttachmentDownloadUrlMutate).toHaveBeenCalledWith({
      messageUuid: uuid2,
      filename: 'b.png',
    });
  });

  it('keeps ready status and the last URL while a renew is in flight', async () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    cacheRenewableEntry(
      'part-1',
      { uuid, filename: 'a.png' },
      {
        url: 'https://r2.example/old',
        urlExpiresAt: Date.now() + 130_000,
      }
    );
    // An unresolved mutate keeps the renew in flight past the tick.
    getAttachmentDownloadUrlMutate.mockReturnValue(new Promise<never>(() => undefined));

    const renderer = await mountProbe(makeFilePart('part-1', uuid, 'a.png'));
    expect(textOf(renderer)).toBe('ready|https://r2.example/old|false');

    advance(30_000);

    expect(textOf(renderer)).toBe('ready|https://r2.example/old|true');
  });

  it('clears renewing after a failed renew and keeps the last URL ready', async () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    cacheRenewableEntry(
      'part-1',
      { uuid, filename: 'a.png' },
      {
        url: 'https://r2.example/old',
        urlExpiresAt: Date.now() + 130_000,
      }
    );
    getAttachmentDownloadUrlMutate.mockRejectedValueOnce(new Error('presign failed'));

    const renderer = await mountProbe(makeFilePart('part-1', uuid, 'a.png'));
    expect(textOf(renderer)).toBe('ready|https://r2.example/old|false');

    advance(30_000);
    expect(textOf(renderer)).toBe('ready|https://r2.example/old|true');

    await flushMicrotasks();

    expect(textOf(renderer)).toBe('ready|https://r2.example/old|false');
  });
});

describe('useResolvedFilePartUrl renew-on-read', () => {
  it('renews on read when urlExpiresAt is missing, keeping the last URL', async () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    cacheRenewableEntry('part-1', { uuid, filename: 'a.png' }, { url: 'https://r2.example/old' });

    const renderer = await mountProbe(makeFilePart('part-1', uuid, 'a.png'));

    // The renew completes on read; the probe never dropped to resolving.
    expect(textOf(renderer)).toBe('ready|https://r2.example/signed|false');
    expect(getAttachmentDownloadUrlMutate).toHaveBeenCalledTimes(1);
    expect(getAttachmentDownloadUrlMutate).toHaveBeenCalledWith({
      messageUuid: uuid,
      filename: 'a.png',
    });
    expect(getFilePartCacheEntry('part-1')?.urlExpiresAt).toBe(Date.parse('2099-01-01T00:00:00Z'));
  });

  it('keeps ready status and the last URL while a read-path renew is in flight', async () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    cacheRenewableEntry('part-1', { uuid, filename: 'a.png' }, { url: 'https://r2.example/old' });
    getAttachmentDownloadUrlMutate.mockReturnValue(new Promise<never>(() => undefined));

    const renderer = await mountProbe(makeFilePart('part-1', uuid, 'a.png'));

    expect(textOf(renderer)).toBe('ready|https://r2.example/old|true');
  });

  it('parses the server expiresAt ISO into the cached urlExpiresAt', async () => {
    getAttachmentDownloadUrlMutate.mockResolvedValue({
      signedUrl: 'https://r2.example/fresh',
      key: 'k',
      expiresAt: '2040-01-01T12:34:56Z',
    });
    const uuid = '22222222-2222-4222-8222-222222222222';
    cacheFilePart('part-1', {
      url: attachmentUrl(uuid, 'a.png'),
      mime: 'image/png',
      filename: 'a.png',
    });

    await mountProbe(makeFilePart('part-1', uuid, 'a.png'));
    await flushMicrotasks();

    expect(getFilePartCacheEntry('part-1')?.urlExpiresAt).toBe(Date.parse('2040-01-01T12:34:56Z'));
  });
});

describe('refreshFilePartUrl', () => {
  it('marks renewing, stores a parsed expiry on success, and clears on failure', async () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    cacheRenewableEntry('part-1', { uuid, filename: 'a.png' }, { url: 'https://r2.example/old' });

    getAttachmentDownloadUrlMutate.mockResolvedValue({
      signedUrl: 'https://r2.example/new',
      key: 'k',
      expiresAt: '2041-02-03T04:05:06Z',
    });
    await expect(refreshFilePartUrl('part-1')).resolves.toBe(true);
    expect(getFilePartCacheEntry('part-1')?.url).toBe('https://r2.example/new');
    expect(getFilePartCacheEntry('part-1')?.urlExpiresAt).toBe(Date.parse('2041-02-03T04:05:06Z'));
    expect(getFilePartCacheEntry('part-1')).not.toHaveProperty('renewing');

    getAttachmentDownloadUrlMutate.mockRejectedValueOnce(new Error('presign failed'));
    await expect(refreshFilePartUrl('part-1')).resolves.toBe(false);
    expect(getFilePartCacheEntry('part-1')).not.toHaveProperty('renewing');
    expect(getFilePartCacheEntry('part-1')?.url).toBe('https://r2.example/new');
  });

  it('shares one in-flight set with the sweep so a retry presign is not duplicated', async () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    cacheRenewableEntry(
      'part-1',
      { uuid, filename: 'a.png' },
      { url: 'https://r2.example/old', urlExpiresAt: Date.now() - 1000 }
    );
    // Mount an unrelated, non-due part so the shared sweeper starts without
    // touching part-1.
    cacheRenewableEntry(
      'part-2',
      { uuid: '22222222-2222-4222-8222-222222222222', filename: 'b.png' },
      { url: 'https://r2.example/old2', urlExpiresAt: Date.now() + 900_000 }
    );
    await mountProbe(makeFilePart('part-2', '22222222-2222-4222-8222-222222222222', 'b.png'));

    // A retry presign that stays in flight across the sweep tick.
    getAttachmentDownloadUrlMutate.mockReturnValue(new Promise<never>(() => undefined));

    act(() => {
      void refreshFilePartUrl('part-1');
    });

    expect(getAttachmentDownloadUrlMutate).toHaveBeenCalledTimes(1);
    expect(getFilePartCacheEntry('part-1')?.renewing).toBe(true);

    advance(30_000);

    expect(getAttachmentDownloadUrlMutate).toHaveBeenCalledTimes(1);
    expect(getFilePartCacheEntry('part-1')?.renewing).toBe(true);
  });

  it('no-ops a retry during an in-flight sweep presign without clearing renewing early', async () => {
    const uuid1 = '11111111-1111-4111-8111-111111111111';
    // part-1 is already due, so the sweep re-presigns it.
    cacheRenewableEntry(
      'part-1',
      { uuid: uuid1, filename: 'a.png' },
      { url: 'https://r2.example/old', urlExpiresAt: Date.now() - 1000 }
    );
    // Mount an unrelated, non-due part so the shared sweeper starts without
    // touching part-1 on the read path.
    cacheRenewableEntry(
      'part-2',
      { uuid: '22222222-2222-4222-8222-222222222222', filename: 'b.png' },
      { url: 'https://r2.example/old2', urlExpiresAt: Date.now() + 900_000 }
    );
    await mountProbe(makeFilePart('part-2', '22222222-2222-4222-8222-222222222222', 'b.png'));

    // The sweep presign stays in flight.
    const sweepHolder: { reject?: (error: Error) => void } = {};
    getAttachmentDownloadUrlMutate.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        sweepHolder.reject = reject;
      })
    );

    advance(30_000);

    expect(getAttachmentDownloadUrlMutate).toHaveBeenCalledTimes(1);
    expect(getFilePartCacheEntry('part-1')?.renewing).toBe(true);

    // A retry during the in-flight sweep presign must be a no-op: no second
    // mutate and no early clearFilePartRenewing.
    await expect(refreshFilePartUrl('part-1')).resolves.toBe(false);

    expect(getAttachmentDownloadUrlMutate).toHaveBeenCalledTimes(1);
    expect(getFilePartCacheEntry('part-1')?.renewing).toBe(true);

    // The renewing mark clears only when the in-flight presign settles.
    await act(async () => {
      sweepHolder.reject?.(new Error('presign failed'));
      await Promise.resolve();
    });

    expect(getFilePartCacheEntry('part-1')).not.toHaveProperty('renewing');
    expect(getAttachmentDownloadUrlMutate).toHaveBeenCalledTimes(1);
  });
});

describe.each(['initial', 'renew-on-read', 'sweep', 'refresh'] as const)(
  '%s presign across a cache clear',
  path => {
    it.each(['success', 'failure'] as const)(
      'discards stale %s and allows a subsequent request for the same file',
      async outcome => {
        const stale = Promise.withResolvers<PresignResult>();
        getAttachmentDownloadUrlMutate.mockReturnValueOnce(stale.promise);
        const previous = await startPendingPresign(path);
        expect(getAttachmentDownloadUrlMutate).toHaveBeenCalledTimes(1);

        clearFilePartCache();
        settlePresign(stale, outcome, 'https://r2.example/stale');
        await flushMicrotasks();

        expect(getFilePartCacheEntry('part-1')).toBeUndefined();
        if (previous.refresh) {
          await expect(previous.refresh).resolves.toBe(false);
        }
        const next = await startPendingPresign(path);
        await flushMicrotasks();

        expect(getAttachmentDownloadUrlMutate).toHaveBeenCalledTimes(2);
        expect(getFilePartCacheEntry('part-1')?.url).toBe('https://r2.example/signed');
        expect(getFilePartCacheEntry('part-1')).not.toHaveProperty('resolveFailed');
        expect(getFilePartCacheEntry('part-1')).not.toHaveProperty('renewing');
        if (next.refresh) {
          await expect(next.refresh).resolves.toBe(true);
        }
      }
    );

    it.each(['success', 'failure'] as const)(
      'keeps a newer request pending when stale %s settles',
      async outcome => {
        const stale = Promise.withResolvers<PresignResult>();
        const fresh = Promise.withResolvers<PresignResult>();
        getAttachmentDownloadUrlMutate
          .mockReturnValueOnce(stale.promise)
          .mockReturnValueOnce(fresh.promise);
        const previous = await startPendingPresign(path);

        clearFilePartCache();
        const next = await startPendingPresign(path);
        expect(getAttachmentDownloadUrlMutate).toHaveBeenCalledTimes(2);
        const pendingEntry = getFilePartCacheEntry('part-1');

        settlePresign(stale, outcome, 'https://r2.example/stale');
        await flushMicrotasks();

        expect(getFilePartCacheEntry('part-1')).toBe(pendingEntry);
        if (previous.refresh) {
          await expect(previous.refresh).resolves.toBe(false);
        }
        await expect(refreshFilePartUrl('part-1')).resolves.toBe(false);
        expect(getAttachmentDownloadUrlMutate).toHaveBeenCalledTimes(2);

        settlePresign(fresh, 'success', 'https://r2.example/fresh');
        await flushMicrotasks();

        expect(getFilePartCacheEntry('part-1')?.url).toBe('https://r2.example/fresh');
        expect(getFilePartCacheEntry('part-1')).not.toHaveProperty('resolveFailed');
        expect(getFilePartCacheEntry('part-1')).not.toHaveProperty('renewing');
        if (next.refresh) {
          await expect(next.refresh).resolves.toBe(true);
        }
      }
    );

    it.each(['success', 'failure'] as const)(
      'preserves a newer result when stale %s settles last',
      async outcome => {
        const stale = Promise.withResolvers<PresignResult>();
        const fresh = Promise.withResolvers<PresignResult>();
        getAttachmentDownloadUrlMutate
          .mockReturnValueOnce(stale.promise)
          .mockReturnValueOnce(fresh.promise);
        const previous = await startPendingPresign(path);

        clearFilePartCache();
        const next = await startPendingPresign(path);
        expect(getAttachmentDownloadUrlMutate).toHaveBeenCalledTimes(2);
        settlePresign(fresh, 'success', 'https://r2.example/fresh');
        await flushMicrotasks();
        const currentEntry = getFilePartCacheEntry('part-1');
        expect(currentEntry?.url).toBe('https://r2.example/fresh');

        settlePresign(stale, outcome, 'https://r2.example/stale');
        await flushMicrotasks();

        expect(getFilePartCacheEntry('part-1')).toBe(currentEntry);
        if (previous.refresh) {
          await expect(previous.refresh).resolves.toBe(false);
        }
        if (next.refresh) {
          await expect(next.refresh).resolves.toBe(true);
        }
        await expect(refreshFilePartUrl('part-1')).resolves.toBe(true);
        expect(getAttachmentDownloadUrlMutate).toHaveBeenCalledTimes(3);
      }
    );
  }
);

describe('refreshFilePartUrl across an authentication epoch change', () => {
  it.each(['success', 'failure'] as const)(
    'ignores stale %s without modifying or releasing a newer request',
    async outcome => {
      const stale = Promise.withResolvers<PresignResult>();
      const fresh = Promise.withResolvers<PresignResult>();
      getAttachmentDownloadUrlMutate
        .mockReturnValueOnce(stale.promise)
        .mockReturnValueOnce(fresh.promise);
      const previous = await startPendingPresign('refresh');

      bumpAuthEpoch();
      const next = refreshFilePartUrl('part-1');
      expect(getAttachmentDownloadUrlMutate).toHaveBeenCalledTimes(2);
      const pendingEntry = getFilePartCacheEntry('part-1');
      settlePresign(stale, outcome, 'https://r2.example/stale');
      await flushMicrotasks();

      expect(getFilePartCacheEntry('part-1')).toBe(pendingEntry);
      await expect(previous.refresh).resolves.toBe(false);
      await expect(refreshFilePartUrl('part-1')).resolves.toBe(false);
      expect(getAttachmentDownloadUrlMutate).toHaveBeenCalledTimes(2);

      settlePresign(fresh, 'success', 'https://r2.example/fresh');
      await expect(next).resolves.toBe(true);
      expect(getFilePartCacheEntry('part-1')?.url).toBe('https://r2.example/fresh');
    }
  );
});
