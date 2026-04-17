import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { ConversationDO } from '../do/conversation-do';

function getStub(convId: string): DurableObjectStub<ConversationDO> {
  const id = env.CONVERSATION_DO.idFromName(convId);
  return env.CONVERSATION_DO.get(id);
}

const BASE_PARAMS = {
  id: 'conv-test',
  title: 'Test Chat',
  createdBy: 'user-alice',
  createdAt: 1000,
  members: [
    { id: 'user-alice', kind: 'user' as const },
    { id: 'bot-1', kind: 'bot' as const },
  ],
};

describe('ConversationDO', () => {
  it('initialize + getInfo - creates conversation and returns correct info', async () => {
    const stub = getStub('conv-init-1');
    await stub.initialize(BASE_PARAMS);
    const info = await stub.getInfo();
    expect(info).not.toBeNull();
    expect(info!.id).toBe('conv-test');
    expect(info!.title).toBe('Test Chat');
    expect(info!.createdBy).toBe('user-alice');
    expect(info!.createdAt).toBe(1000);
    expect(info!.members).toHaveLength(2);
    expect(info!.members).toContainEqual({ id: 'user-alice', kind: 'user' });
    expect(info!.members).toContainEqual({ id: 'bot-1', kind: 'bot' });
  });

  it('isMember - true for member, false for non-member', async () => {
    const stub = getStub('conv-member-1');
    await stub.initialize(BASE_PARAMS);
    expect(await stub.isMember('user-alice')).toBe(true);
    expect(await stub.isMember('user-stranger')).toBe(false);
  });

  it('createMessage - creates message, returns ULID + version 1', async () => {
    const stub = getStub('conv-create-1');
    await stub.initialize(BASE_PARAMS);
    const result = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Hello!' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messageId).toMatch(/^[0-9A-Z]{26}$/);
      expect(result.version).toBe(1);
    }
  });

  it('createMessage - rejects non-member', async () => {
    const stub = getStub('conv-create-2');
    await stub.initialize(BASE_PARAMS);
    const result = await stub.createMessage({
      senderId: 'user-stranger',
      content: [{ type: 'text', text: 'Hello!' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('not a member');
    }
  });

  it('listMessages - reverse chronological order', async () => {
    const stub = getStub('conv-list-1');
    await stub.initialize(BASE_PARAMS);
    const r1 = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'First' }],
    });
    const r2 = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Second' }],
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    const { messages } = await stub.listMessages({ limit: 10 });
    expect(messages).toHaveLength(2);
    // Descending by id - second message first
    expect(messages[0].id).toBe(r2.messageId);
    expect(messages[1].id).toBe(r1.messageId);
  });

  it('listMessages - cursor pagination with before', async () => {
    const stub = getStub('conv-list-2');
    await stub.initialize(BASE_PARAMS);
    const r1 = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'First' }],
    });
    await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Second' }],
    });
    const r3 = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Third' }],
    });
    expect(r1.ok).toBe(true);
    expect(r3.ok).toBe(true);
    if (!r1.ok || !r3.ok) return;

    // Fetch page before r3 - should get r2 and r1
    const { messages } = await stub.listMessages({ limit: 10, before: r3.messageId });
    expect(messages).toHaveLength(2);
    expect(messages[0].id).not.toBe(r3.messageId);
    // All returned ids should be lexicographically less than r3
    for (const msg of messages) {
      expect(msg.id < r3.messageId).toBe(true);
    }
    // First message should NOT be included in a page before r1
    const { messages: page2 } = await stub.listMessages({ limit: 10, before: r1.messageId });
    expect(page2).toHaveLength(0);
  });

  it('editMessage - edits and increments version', async () => {
    const stub = getStub('conv-edit-1');
    await stub.initialize(BASE_PARAMS);
    const created = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Original' }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Send current version (1) — server auto-increments to 2
    const result = await stub.editMessage({
      messageId: created.messageId,
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Edited' }],
      version: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conflict).toBe(false);
    expect(result.version).toBe(2);

    const { messages } = await stub.listMessages({ limit: 10 });
    const msg = messages.find(m => m.id === created.messageId);
    expect(msg).toBeDefined();
    expect(JSON.parse(msg!.content)).toEqual([{ type: 'text', text: 'Edited' }]);
    expect(msg!.updatedAt).not.toBeNull();
  });

  it('editMessage - returns conflict on stale version', async () => {
    const stub = getStub('conv-edit-2');
    await stub.initialize(BASE_PARAMS);
    const created = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Original' }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Current version is 1, sending stale version 0 should conflict
    const result = await stub.editMessage({
      messageId: created.messageId,
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Stale edit' }],
      version: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conflict).toBe(true);
    expect(result.version).toBe(1);
  });

  it('editMessage - rejects non-sender', async () => {
    const stub = getStub('conv-edit-3');
    await stub.initialize(BASE_PARAMS);
    const created = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Original' }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await stub.editMessage({
      messageId: created.messageId,
      senderId: 'user-stranger',
      content: [{ type: 'text', text: 'Hacked' }],
      version: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('not the owner');
    }
  });

  it('deleteMessage - soft deletes', async () => {
    const stub = getStub('conv-delete-1');
    await stub.initialize(BASE_PARAMS);
    const created = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Delete me' }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await stub.deleteMessage({
      messageId: created.messageId,
      senderId: 'user-alice',
    });
    expect(result.ok).toBe(true);

    const { messages } = await stub.listMessages({ limit: 10 });
    const msg = messages.find(m => m.id === created.messageId);
    expect(msg).toBeDefined();
    expect(msg!.deleted).toBe(true);
    expect(msg!.updatedAt).not.toBeNull();
  });

  it('editMessage - rejects editing a deleted message', async () => {
    const stub = getStub('conv-edit-deleted');
    await stub.initialize(BASE_PARAMS);
    const created = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Secret info' }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await stub.deleteMessage({ messageId: created.messageId, senderId: 'user-alice' });

    // Editing a deleted message should fail
    const result = await stub.editMessage({
      messageId: created.messageId,
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Zombie edit' }],
      version: 1,
    });
    expect(result.ok).toBe(false);
  });

  it('listMessages - scrubs content of deleted messages', async () => {
    const stub = getStub('conv-delete-scrub');
    await stub.initialize(BASE_PARAMS);
    const created = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Sensitive content' }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await stub.deleteMessage({ messageId: created.messageId, senderId: 'user-alice' });

    const { messages } = await stub.listMessages({ limit: 10 });
    const msg = messages.find(m => m.id === created.messageId);
    expect(msg).toBeDefined();
    expect(msg!.deleted).toBe(true);
    // Content should be scrubbed — not contain original text
    expect(msg!.content).not.toContain('Sensitive content');
  });

  it('deleteMessage - rejects non-sender', async () => {
    const stub = getStub('conv-delete-2');
    await stub.initialize(BASE_PARAMS);
    const created = await stub.createMessage({
      senderId: 'user-alice',
      content: [{ type: 'text', text: 'Delete me' }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await stub.deleteMessage({
      messageId: created.messageId,
      senderId: 'user-stranger',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('not the owner');
    }
  });

  it('getBotMembersExcluding - returns bots except sender', async () => {
    const stub = getStub('conv-bots-1');
    await stub.initialize({
      id: 'conv-test',
      title: null,
      createdBy: 'user-alice',
      createdAt: 1000,
      members: [
        { id: 'user-alice', kind: 'user' },
        { id: 'bot-1', kind: 'bot' },
        { id: 'bot-2', kind: 'bot' },
      ],
    });
    const bots = await stub.getBotMembersExcluding('bot-1');
    expect(bots).toHaveLength(1);
    expect(bots[0].id).toBe('bot-2');
    expect(bots[0].kind).toBe('bot');

    // Should not include users
    const botsExcludingAlice = await stub.getBotMembersExcluding('user-alice');
    expect(botsExcludingAlice).toHaveLength(2);
    expect(botsExcludingAlice.every(b => b.kind === 'bot')).toBe(true);
  });

  describe('addReaction / removeReaction', () => {
    async function seed(convId: string) {
      const stub = getStub(convId);
      await stub.initialize({ ...BASE_PARAMS, id: convId });
      const created = await stub.createMessage({
        senderId: 'user-alice',
        content: [{ type: 'text', text: 'msg' }],
      });
      if (!created.ok) throw new Error('seed failed');
      return { stub, messageId: created.messageId };
    }

    it('addReaction on a fresh (message, member, emoji) returns { ok: true, added: true, id }', async () => {
      const { stub, messageId } = await seed('conv-rx-add-1');
      const r = await stub.addReaction({ messageId, memberId: 'user-alice', emoji: '👍' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.added).toBe(true);
        expect(r.id).toMatch(/^[0-9A-Z]{26}$/);
      }
    });

    it('addReaction is idempotent for a live tuple (returns { ok: true, added: false, id: original })', async () => {
      const { stub, messageId } = await seed('conv-rx-add-2');
      const first = await stub.addReaction({ messageId, memberId: 'user-alice', emoji: '👍' });
      const second = await stub.addReaction({ messageId, memberId: 'user-alice', emoji: '👍' });
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(second.added).toBe(false);
        expect(second.id).toBe(first.id);
      }
    });

    it('removeReaction on a live tuple returns { ok: true, removed: true, removed_id }', async () => {
      const { stub, messageId } = await seed('conv-rx-rem-1');
      await stub.addReaction({ messageId, memberId: 'user-alice', emoji: '👍' });
      const r = await stub.removeReaction({ messageId, memberId: 'user-alice', emoji: '👍' });
      expect(r.ok).toBe(true);
      if (r.ok && r.removed) {
        expect(r.removed_id).toMatch(/^[0-9A-Z]{26}$/);
      } else {
        throw new Error('Expected removed: true');
      }
    });

    it('removeReaction is idempotent when the tuple is absent', async () => {
      const { stub, messageId } = await seed('conv-rx-rem-2');
      const r = await stub.removeReaction({ messageId, memberId: 'user-alice', emoji: '👍' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.removed).toBe(false);
      }
    });

    it('add -> remove -> add re-activates the same row with a new id; removed_id cleared', async () => {
      const { stub, messageId } = await seed('conv-rx-cycle');
      const a1 = await stub.addReaction({ messageId, memberId: 'user-alice', emoji: '👍' });
      await stub.removeReaction({ messageId, memberId: 'user-alice', emoji: '👍' });
      const a2 = await stub.addReaction({ messageId, memberId: 'user-alice', emoji: '👍' });
      expect(a1.ok).toBe(true);
      expect(a2.ok).toBe(true);
      if (a1.ok && a2.ok) {
        expect(a2.added).toBe(true);
        expect(a2.id).not.toBe(a1.id);
      }
    });

    it('rejects reactions on non-existent messages (FK)', async () => {
      const stub = getStub('conv-rx-bad-msg');
      await stub.initialize({ ...BASE_PARAMS, id: 'conv-rx-bad-msg' });
      const result = await stub.addReaction({
        messageId: '00000000000000000000000000',
        memberId: 'user-alice',
        emoji: '👍',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/constraint|foreign key/i);
      }
    });

    it('rejects reactions from non-member (FK)', async () => {
      const { stub, messageId } = await seed('conv-rx-bad-mem');
      const result = await stub.addReaction({ messageId, memberId: 'user-nonmember', emoji: '👍' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/constraint|foreign key/i);
      }
    });
  });

  describe('listMessages reactions aggregation', () => {
    it('returns reactions grouped by emoji with counts and member ids', async () => {
      const stub = getStub('conv-agg-1');
      await stub.initialize({
        ...BASE_PARAMS,
        id: 'conv-agg-1',
        members: [
          { id: 'user-alice', kind: 'user' },
          { id: 'user-bob', kind: 'user' },
          { id: 'bot-1', kind: 'bot' },
        ],
      });
      const m = await stub.createMessage({
        senderId: 'user-alice',
        content: [{ type: 'text', text: 'hi' }],
      });
      if (!m.ok) throw new Error('create failed');

      const a1 = await stub.addReaction({
        messageId: m.messageId,
        memberId: 'user-alice',
        emoji: '👍',
      });
      const a2 = await stub.addReaction({
        messageId: m.messageId,
        memberId: 'user-bob',
        emoji: '👍',
      });
      const a3 = await stub.addReaction({ messageId: m.messageId, memberId: 'bot-1', emoji: '🎉' });
      if (!a1.ok || !a2.ok || !a3.ok) throw new Error('add failed');

      const { messages } = await stub.listMessages({ limit: 10 });
      const msg = messages.find(x => x.id === m.messageId)!;
      expect(msg.reactions).toHaveLength(2);
      const thumbs = msg.reactions.find(r => r.emoji === '👍')!;
      expect(thumbs.count).toBe(2);
      expect(thumbs.memberIds.sort()).toEqual(['user-alice', 'user-bob']);
      const party = msg.reactions.find(r => r.emoji === '🎉')!;
      expect(party.count).toBe(1);
      expect(party.memberIds).toEqual(['bot-1']);
    });

    it('omits dead reactions from the aggregation', async () => {
      const stub = getStub('conv-agg-2');
      await stub.initialize({ ...BASE_PARAMS, id: 'conv-agg-2' });
      const m = await stub.createMessage({
        senderId: 'user-alice',
        content: [{ type: 'text', text: 'hi' }],
      });
      if (!m.ok) throw new Error('create failed');
      await stub.addReaction({ messageId: m.messageId, memberId: 'user-alice', emoji: '👍' });
      await stub.removeReaction({ messageId: m.messageId, memberId: 'user-alice', emoji: '👍' });

      const { messages } = await stub.listMessages({ limit: 10 });
      expect(messages.find(x => x.id === m.messageId)!.reactions).toEqual([]);
    });

    it('messages without any reactions still have reactions: []', async () => {
      const stub = getStub('conv-agg-3');
      await stub.initialize({ ...BASE_PARAMS, id: 'conv-agg-3' });
      const m = await stub.createMessage({
        senderId: 'user-alice',
        content: [{ type: 'text', text: 'hi' }],
      });
      if (!m.ok) throw new Error('create failed');
      const { messages } = await stub.listMessages({ limit: 10 });
      expect(messages[0].reactions).toEqual([]);
    });
  });

  describe('SSE replay — messages + reactions interleaved', () => {
    /**
     * Read replay events from an SSE subscribe response.
     *
     * Replay bytes are written to the stream before the Response is
     * returned, so the first read() resolves immediately with all
     * buffered replay data. We read until no more replay data arrives,
     * then cancel the stream while no reader.read() is pending.
     *
     * The earlier version used Promise.race(reader.read(), timeout) in
     * a loop — when the timeout won, a dangling reader.read() promise
     * remained. Calling reader.cancel() then caused that pending read
     * to reject inside workerd's TransformStream RPC plumbing as an
     * unhandled "Stream was cancelled" rejection that JS cannot catch.
     *
     * This version avoids the problem by never leaving a pending read:
     * it reads in a loop until data stops arriving (the content check
     * or read-count limit breaks the loop), then cancels cleanly.
     */
    async function collectReplay(
      stub: DurableObjectStub<ConversationDO>,
      memberId: string,
      lastEventId: string
    ): Promise<string> {
      const url = `https://do/subscribe?memberId=${encodeURIComponent(memberId)}`;
      const res = await stub.fetch(new Request(url, { headers: { 'last-event-id': lastEventId } }));
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let out = '';

      // Replay data is pre-buffered — read chunks until the stream
      // would block (i.e. all buffered replay data is consumed).
      // The first read always resolves immediately with the replay
      // bytes. Once we have data, break and cancel with no pending read.
      const readLoop = async () => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done || value === undefined) break;
          out += decoder.decode(value);
          // Replay is written as a single chunk, so one successful
          // read is enough. Break to avoid blocking on live events.
          break;
        }
      };

      // Safety timeout in case the stream blocks unexpectedly.
      await Promise.race([readLoop(), new Promise<void>(r => setTimeout(r, 2000))]);

      // Cancel with no pending reader.read() — safe, no dangling promise.
      await reader.cancel().catch(() => {});
      return out;
    }

    it('replays reaction.added interleaved with messages in ULID order', async () => {
      const stub = getStub('conv-replay-rx-1');
      await stub.initialize({ ...BASE_PARAMS, id: 'conv-replay-rx-1' });
      const m1 = await stub.createMessage({
        senderId: 'user-alice',
        content: [{ type: 'text', text: 'a' }],
      });
      if (!m1.ok) throw new Error('create failed');
      const r1 = await stub.addReaction({
        messageId: m1.messageId,
        memberId: 'user-alice',
        emoji: '👍',
      });
      if (!r1.ok) throw new Error('add failed');

      const body = await collectReplay(stub, 'user-alice', '00000000000000000000000000');
      expect(body).toContain('event: message.created');
      expect(body).toContain(`id: ${m1.messageId}`);
      expect(body).toContain('event: reaction.added');
      expect(body).toContain(`id: ${r1.id}`);
      expect(body.indexOf(`id: ${m1.messageId}`)).toBeLessThan(body.indexOf(`id: ${r1.id}`));

      // Verify replayed reaction.added includes `at` timestamp (spec requirement)
      const addedEventMatch = body.match(
        new RegExp(`id: ${r1.id}\\nevent: reaction\\.added\\ndata: (.+)`)
      );
      expect(addedEventMatch).not.toBeNull();
      const payload = JSON.parse(addedEventMatch![1]) as { at: number; messageId: string };
      expect(payload.at).toEqual(expect.any(Number));
      expect(payload.messageId).toBe(m1.messageId);
    });

    it('replays reaction.removed using removed_id', async () => {
      const stub = getStub('conv-replay-rx-2');
      await stub.initialize({ ...BASE_PARAMS, id: 'conv-replay-rx-2' });
      const m = await stub.createMessage({
        senderId: 'user-alice',
        content: [{ type: 'text', text: 'x' }],
      });
      if (!m.ok) throw new Error('create failed');
      await stub.addReaction({ messageId: m.messageId, memberId: 'user-alice', emoji: '👍' });
      const rem = await stub.removeReaction({
        messageId: m.messageId,
        memberId: 'user-alice',
        emoji: '👍',
      });
      if (!rem.ok || !rem.removed) throw new Error('remove failed');

      const body = await collectReplay(stub, 'user-alice', '00000000000000000000000000');
      expect(body).toContain('event: reaction.removed');
      expect(body).toContain(`id: ${rem.removed_id}`);
    });

    it('for an add->remove->add cycle, old events are compacted (only the final add replays)', async () => {
      const stub = getStub('conv-replay-rx-3');
      await stub.initialize({ ...BASE_PARAMS, id: 'conv-replay-rx-3' });
      const m = await stub.createMessage({
        senderId: 'user-alice',
        content: [{ type: 'text', text: 'x' }],
      });
      if (!m.ok) throw new Error('create failed');
      const a1 = await stub.addReaction({
        messageId: m.messageId,
        memberId: 'user-alice',
        emoji: '👍',
      });
      await stub.removeReaction({
        messageId: m.messageId,
        memberId: 'user-alice',
        emoji: '👍',
      });
      const a2 = await stub.addReaction({
        messageId: m.messageId,
        memberId: 'user-alice',
        emoji: '👍',
      });
      if (!a1.ok || !a2.ok) throw new Error('add failed');

      const body = await collectReplay(stub, 'user-alice', '00000000000000000000000000');
      expect(body).toContain(`id: ${a2.id}`);
      expect(body).not.toContain(`id: ${a1.id}`);
    });
  });

  describe('schema constraints', () => {
    it('rejects a reply that points at a non-existent parent message (FK)', async () => {
      const stub = getStub('conv-fk-reply');
      await stub.initialize(BASE_PARAMS);
      const result = await stub.createMessage({
        senderId: 'user-alice',
        content: [{ type: 'text', text: 'reply' }],
        inReplyToMessageId: '00000000000000000000000000',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/foreign key|constraint/i);
      }
    });

    it('rejects a member kind outside ("user", "bot") (CHECK)', async () => {
      const stub = getStub('conv-check-kind');
      const result = await stub.initialize({
        ...BASE_PARAMS,
        id: 'conv-check-kind',
        members: [{ id: 'x', kind: 'admin' as 'user' }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/check constraint|constraint/i);
      }
    });
  });
});
