import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { QueryClient } from '@tanstack/react-query';
import type { KiloSessionId, SessionSnapshotPage } from '@kilocode/cloud-agent-sdk';
import { createWebSessionTranscriptCache } from './session-transcript-cache';

const queryClient = new QueryClient();

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

afterEach(() => {
  queryClient.clear();
  jest.restoreAllMocks();
});

describe('web session transcript cache', () => {
  it('keeps only the recent transcript while the live page restores pagination', async () => {
    const cache = createWebSessionTranscriptCache(queryClient, 'personal');
    cache.write(page('ses-1', 60));
    await Promise.resolve(); // writes land in a microtask
    const snapshot = cache.read('ses-1' as KiloSessionId);
    expect(snapshot?.messages).toHaveLength(50);
    expect(snapshot?.messages[0].info.id).toBe('message-10');
    expect(snapshot?.messages.at(-1)?.info.id).toBe('message-59');
    expect(snapshot?.nextCursor).toBeNull();
    expect(snapshot?.omittedItemCount).toBe(0);
  });

  it('isolates provider scopes and session identities', async () => {
    const personal = createWebSessionTranscriptCache(queryClient, 'personal');
    const organization = createWebSessionTranscriptCache(queryClient, 'organization');
    personal.write(page('ses-1'));
    await Promise.resolve(); // writes land in a microtask
    expect(personal.read('ses-2' as KiloSessionId)).toBeNull();
    expect(organization.read('ses-1' as KiloSessionId)).toBeNull();
    expect(personal.read('ses-1' as KiloSessionId)).not.toBeNull();
  });

  it('evicts the oldest transcript after five cached sessions', async () => {
    const cache = createWebSessionTranscriptCache(queryClient, 'personal');
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
    const cache = createWebSessionTranscriptCache(queryClient, 'personal');
    cache.write(page('ses-1'));
    cache.write(page('ses-1', 1, 'x'.repeat(1_000_000)));
    await Promise.resolve(); // writes land in a microtask
    expect(cache.read('ses-1' as KiloSessionId)).toBeNull();
  });

  it('retains the latest write even when timestamps match', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1000);
    const cache = createWebSessionTranscriptCache(queryClient, 'personal');
    for (let index = 0; index < 6; index++) cache.write(page(`ses-${index}`));
    await Promise.resolve(); // writes land in a microtask
    expect(cache.read('ses-5' as KiloSessionId)).not.toBeNull();
    expect(cache.read('ses-0' as KiloSessionId)).toBeNull();
  });
});
