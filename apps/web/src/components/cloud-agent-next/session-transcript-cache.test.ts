import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { QueryClient } from '@tanstack/react-query';
import type { KiloSessionId, SessionSnapshotPage } from '@kilocode/cloud-agent-sdk';
import {
  createWebSessionTranscriptCache,
  transcriptCacheKey,
  transcriptCacheScope,
  type TranscriptCacheScope,
} from './session-transcript-cache';

const queryClient = new QueryClient();

const alice: TranscriptCacheScope = { userId: 'user-alice', organizationId: null };
const bob: TranscriptCacheScope = { userId: 'user-bob', organizationId: null };
const aliceOrganization: TranscriptCacheScope = {
  userId: 'user-alice',
  organizationId: 'organization-a',
};

function page(id: string, count = 1, text = 'cached text'): SessionSnapshotPage {
  return {
    info: { id },
    messages: Array.from({ length: count }, (_, index) => ({
      info: {
        id: `message-${index}`,
        sessionID: id,
        role: 'user',
        time: { created: index },
        agent: 'code',
        model: { providerID: 'kilo', modelID: 'fake-deterministic' },
      },
      parts: [
        {
          id: `part-${index}`,
          messageID: `message-${index}`,
          sessionID: id,
          type: 'text',
          text,
        },
      ],
    })),
    nextCursor: 'older-page',
    omittedItemCount: 3,
  };
}

function cacheFor(scope: TranscriptCacheScope) {
  return createWebSessionTranscriptCache(queryClient, () => scope);
}

function textOf(page: SessionSnapshotPage | null): unknown {
  return page?.messages[0].parts[0];
}

afterEach(() => {
  queryClient.clear();
  jest.restoreAllMocks();
});

describe('web session transcript cache', () => {
  it('keeps only the recent transcript while the live page restores pagination', async () => {
    const cache = cacheFor(alice);
    cache.write(page('ses-1', 60));
    await Promise.resolve(); // writes land in a microtask
    const snapshot = cache.read('ses-1' as KiloSessionId);
    expect(snapshot?.messages).toHaveLength(50);
    expect(snapshot?.messages[0].info.id).toBe('message-10');
    expect(snapshot?.messages.at(-1)?.info.id).toBe('message-59');
    expect(snapshot?.nextCursor).toBeNull();
    expect(snapshot?.omittedItemCount).toBe(0);
  });

  it('keys one session apart per user, account context and session identity', () => {
    const alicePersonal = transcriptCacheKey(transcriptCacheScope('user-alice', null), 'ses-1');
    expect(alicePersonal).not.toEqual(
      transcriptCacheKey(transcriptCacheScope('user-bob', null), 'ses-1')
    );
    expect(alicePersonal).not.toEqual(
      transcriptCacheKey(transcriptCacheScope('user-alice', 'organization-a'), 'ses-1')
    );
    expect(alicePersonal).not.toEqual(
      transcriptCacheKey(transcriptCacheScope('user-alice', null), 'ses-2')
    );
  });

  it('returns nothing cached by another user for the same session id', async () => {
    cacheFor(alice).write(page('ses-1'));
    await Promise.resolve(); // writes land in a microtask

    expect(cacheFor(bob).read('ses-1' as KiloSessionId)).toBeNull();
    expect(cacheFor(aliceOrganization).read('ses-1' as KiloSessionId)).toBeNull();
    expect(cacheFor(alice).read('ses-1' as KiloSessionId)).not.toBeNull();
  });

  it('evicts only its own oldest pages, leaving another user entries intact', async () => {
    const bobCache = cacheFor(bob);
    bobCache.write(page('ses-1'));
    const aliceCache = cacheFor(alice);
    for (let index = 0; index < 6; index++) {
      jest.spyOn(Date, 'now').mockReturnValue(1000 + index);
      aliceCache.write(page(`ses-${index}`));
    }
    await Promise.resolve(); // writes land in a microtask

    expect(aliceCache.read('ses-0' as KiloSessionId)).toBeNull();
    expect(aliceCache.read('ses-5' as KiloSessionId)).not.toBeNull();
    expect(bobCache.read('ses-1' as KiloSessionId)).not.toBeNull();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(6);
  });

  it('evicts the oldest transcript after five cached sessions', async () => {
    const cache = cacheFor(alice);
    for (let index = 0; index < 6; index++) {
      jest.spyOn(Date, 'now').mockReturnValue(1000 + index);
      cache.write(page(`ses-${index}`));
    }
    await Promise.resolve(); // writes land in a microtask
    expect(cache.read('ses-0' as KiloSessionId)).toBeNull();
    expect(cache.read('ses-5' as KiloSessionId)).not.toBeNull();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(5);
  });

  it('removes an earlier cached page when its replacement exceeds the size bound', async () => {
    const cache = cacheFor(alice);
    cache.write(page('ses-1'));
    cache.write(page('ses-1', 1, 'x'.repeat(1_000_000)));
    await Promise.resolve(); // writes land in a microtask
    expect(cache.read('ses-1' as KiloSessionId)).toBeNull();
  });

  it('retains the latest write even when timestamps match', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1000);
    const cache = cacheFor(alice);
    for (let index = 0; index < 6; index++) cache.write(page(`ses-${index}`));
    await Promise.resolve(); // writes land in a microtask
    expect(cache.read('ses-5' as KiloSessionId)).not.toBeNull();
    expect(cache.read('ses-0' as KiloSessionId)).toBeNull();
  });

  it('drops one session page on invalidate and keeps the rest of the scope', async () => {
    const cache = cacheFor(alice);
    const organization = cacheFor(aliceOrganization);
    const other = cacheFor(bob);
    cache.write(page('ses-1'));
    cache.write(page('ses-2'));
    organization.write(page('ses-1'));
    other.write(page('ses-1'));
    await Promise.resolve(); // writes land in a microtask

    cache.invalidate('ses-1' as KiloSessionId);

    expect(cache.read('ses-1' as KiloSessionId)).toBeNull();
    expect(cache.read('ses-2' as KiloSessionId)).not.toBeNull();
    expect(organization.read('ses-1' as KiloSessionId)).not.toBeNull();
    expect(other.read('ses-1' as KiloSessionId)).not.toBeNull();
  });

  it('follows the current user instead of the one it was created with', async () => {
    let scope = alice;
    const cache = createWebSessionTranscriptCache(queryClient, () => scope);
    cache.write(page('ses-1', 1, 'alice text'));
    await Promise.resolve(); // writes land in a microtask

    scope = bob;
    expect(cache.read('ses-1' as KiloSessionId)).toBeNull();
    cache.write(page('ses-1', 1, 'bob text'));
    await Promise.resolve(); // writes land in a microtask

    scope = alice;
    expect(textOf(cache.read('ses-1' as KiloSessionId))).toMatchObject({ text: 'alice text' });
  });
});
