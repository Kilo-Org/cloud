import { beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { createCallerFactory, createTRPCRouter } from '@/lib/trpc/init';
import { quickChatRouter } from '@/routers/quick-chat-router';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { quick_chat_messages, quick_chat_threads } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

const createCaller = createCallerFactory(createTRPCRouter({ quickChat: quickChatRouter }));

describe('quickChatRouter', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('is idempotent for a personal null-org thread', async () => {
    const user = await insertTestUser();
    const caller = createCaller({ user });

    const first = await caller.quickChat.getOrCreateThread({ organizationId: null });
    const second = await caller.quickChat.getOrCreateThread({ organizationId: null });

    expect(second.id).toBe(first.id);
    expect(first.organizationId).toBeNull();

    const threads = await db
      .select()
      .from(quick_chat_threads)
      .where(eq(quick_chat_threads.user_id, user.id));
    expect(threads).toHaveLength(1);
  });

  it('keeps an organization thread separate from the personal thread', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Quick Chat Org', user.id, 0);
    const caller = createCaller({ user });

    const personal = await caller.quickChat.getOrCreateThread({ organizationId: null });
    const orgThread = await caller.quickChat.getOrCreateThread({
      organizationId: organization.id,
    });

    expect(orgThread.id).not.toBe(personal.id);
    expect(orgThread.organizationId).toBe(organization.id);

    const threads = await db
      .select()
      .from(quick_chat_threads)
      .where(eq(quick_chat_threads.user_id, user.id));
    expect(threads).toHaveLength(2);
  });

  it('returns an empty list when the user has no thread', async () => {
    const user = await insertTestUser();
    const caller = createCaller({ user });

    const result = await caller.quickChat.listMessages({ organizationId: null });

    expect(result).toEqual({ messages: [], nextCursor: null });
  });

  it('returns appended messages from list', async () => {
    const user = await insertTestUser();
    const caller = createCaller({ user });

    await caller.quickChat.appendMessages({
      organizationId: null,
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi', clientId: 'client-1' },
      ],
    });

    const result = await caller.quickChat.listMessages({ organizationId: null });
    expect(result.messages).toHaveLength(2);
    expect(result.messages.map(message => message.content)).toEqual(['hello', 'hi']);
    const roles: ('user' | 'assistant')[] = result.messages.map(message => message.role);
    expect(roles).toEqual(['user', 'assistant']);
    expect(result.messages[1]?.clientId).toBe('client-1');
  });

  it('rejects an invalid stored message role', async () => {
    const user = await insertTestUser();
    const caller = createCaller({ user });
    const thread = await caller.quickChat.getOrCreateThread({ organizationId: null });
    await db.insert(quick_chat_messages).values({
      thread_id: thread.id,
      role: 'tool',
      content: 'Invalid role',
    });

    await expect(caller.quickChat.listMessages({ organizationId: null })).rejects.toThrow();
  });

  it('pages older messages through nextCursor', async () => {
    const user = await insertTestUser();
    const caller = createCaller({ user });

    const thread = await caller.quickChat.getOrCreateThread({ organizationId: null });
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const times = Array.from({ length: 5 }, (_, i) => new Date(base + i * 1000).toISOString());
    for (let i = 0; i < times.length; i++) {
      await db.insert(quick_chat_messages).values({
        thread_id: thread.id,
        role: 'user',
        content: `msg-${i}`,
        created_at: times[i],
      });
    }

    const page1 = await caller.quickChat.listMessages({ organizationId: null, limit: 2 });
    expect(page1.messages.map(message => message.content)).toEqual(['msg-3', 'msg-4']);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.nextCursor).not.toBe(times[3]);

    const page2 = await caller.quickChat.listMessages({
      organizationId: null,
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.messages.map(message => message.content)).toEqual(['msg-1', 'msg-2']);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await caller.quickChat.listMessages({
      organizationId: null,
      limit: 2,
      cursor: page2.nextCursor!,
    });
    expect(page3.messages.map(message => message.content)).toEqual(['msg-0']);
    expect(page3.nextCursor).toBeNull();
  });

  it('pages two messages that share a created_at without skipping one', async () => {
    const user = await insertTestUser();
    const caller = createCaller({ user });

    const thread = await caller.quickChat.getOrCreateThread({ organizationId: null });
    const sharedTime = '2026-02-02T00:00:00.000Z';
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    for (let i = 0; i < ids.length; i++) {
      await db.insert(quick_chat_messages).values({
        id: ids[i],
        thread_id: thread.id,
        role: 'user',
        content: `msg-${i}`,
        created_at: sharedTime,
      });
    }

    const page1 = await caller.quickChat.listMessages({ organizationId: null, limit: 1 });
    expect(page1.messages).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await caller.quickChat.listMessages({
      organizationId: null,
      limit: 1,
      cursor: page1.nextCursor!,
    });
    expect(page2.messages).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const contents = [page1.messages[0]!.content, page2.messages[0]!.content].sort();
    expect(contents).toEqual(['msg-0', 'msg-1']);
  });

  it('does not let a second user read the first user thread', async () => {
    const user = await insertTestUser();
    const otherUser = await insertTestUser();
    const caller = createCaller({ user });
    const otherCaller = createCaller({ user: otherUser });

    await caller.quickChat.getOrCreateThread({ organizationId: null });
    await caller.quickChat.appendMessages({
      organizationId: null,
      messages: [{ role: 'user', content: 'secret' }],
    });

    const result = await otherCaller.quickChat.listMessages({ organizationId: null });
    expect(result.messages).toHaveLength(0);

    const otherThread = await otherCaller.quickChat.getOrCreateThread({ organizationId: null });
    const [firstThread] = await db
      .select()
      .from(quick_chat_threads)
      .where(eq(quick_chat_threads.user_id, user.id));
    expect(otherThread.id).not.toBe(firstThread.id);
  });
});
