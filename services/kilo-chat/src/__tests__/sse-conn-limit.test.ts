import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { ConversationDO } from '../do/conversation-do';
import { MAX_SSE_PER_MEMBER } from '../do/conversation-do';

function getStub(convId: string): DurableObjectStub<ConversationDO> {
  return env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(convId));
}

// This file tests SSE connection limits. All tests open streaming responses,
// so every test must cancel all response bodies before returning.

describe('SSE per-member connection limit', () => {
  it('rejects SSE connections from the same member beyond the per-member limit', async () => {
    const stub = getStub('do-sse-conn-limit');
    await stub.initialize({
      id: 'do-sse-conv-conn-limit',
      title: null,
      createdBy: 'user-1',
      createdAt: 1000,
      members: [{ id: 'user-1', kind: 'user' }],
    });

    const responses: Response[] = [];

    // Open MAX_SSE_PER_MEMBER + 1 connections sequentially
    for (let i = 0; i <= MAX_SSE_PER_MEMBER; i++) {
      const res = await stub.fetch('https://do/subscribe?memberId=user-1');
      responses.push(res);
    }

    // First MAX_SSE_PER_MEMBER should be 200
    for (let i = 0; i < MAX_SSE_PER_MEMBER; i++) {
      expect(responses[i].status).toBe(200);
    }

    // The one beyond the limit should be 429
    expect(responses[MAX_SSE_PER_MEMBER].status).toBe(429);

    // Clean up all streams
    for (const res of responses) {
      await res.body?.cancel().catch(() => {});
    }
  });
});
