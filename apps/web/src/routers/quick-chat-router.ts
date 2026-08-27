import 'server-only';

import { TRPCError } from '@trpc/server';
import { and, desc, eq, isNull, lt, or, type SQL } from 'drizzle-orm';
import * as z from 'zod';
import { db } from '@/lib/drizzle';
import { baseProcedure, createTRPCRouter, type TRPCContext } from '@/lib/trpc/init';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import {
  quick_chat_messages,
  quick_chat_threads,
  type QuickChatMessage,
  type QuickChatThread,
} from '@kilocode/db/schema';

const threadScopeInput = z.object({
  organizationId: z.uuid().nullable(),
});

const messageInput = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
  clientId: z.string().min(1).optional(),
});

const listMessagesInput = threadScopeInput.extend({
  cursor: z.string().min(1).optional(),
  limit: z.number().min(1).max(50).default(50),
});

const appendMessagesInput = threadScopeInput.extend({
  messages: z.array(messageInput).min(1),
});

function serializeThread(thread: QuickChatThread) {
  return {
    id: thread.id,
    organizationId: thread.organization_id,
    createdAt: new Date(thread.created_at).toISOString(),
  };
}

function serializeMessage(message: QuickChatMessage) {
  return {
    id: message.id,
    role: messageInput.shape.role.parse(message.role),
    content: message.content,
    clientId: message.client_id,
    createdAt: new Date(message.created_at).toISOString(),
  };
}

const messagesCursorSchema = z.object({
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
});

/**
 * Encodes the last row of a page as an opaque keyset cursor. The `created_at`
 * value is normalized to UTC ISO so the cursor round-trips deterministically
 * through the client even though the stored column can be PostgreSQL-shaped
 * (e.g. `2026-04-29 01:16:12.945+00`).
 */
function encodeMessagesCursor(row: { created_at: string; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: new Date(row.created_at).toISOString(), id: row.id }),
    'utf8'
  ).toString('base64url');
}

function decodeMessagesCursor(cursor: string): z.infer<typeof messagesCursorSchema> {
  try {
    return messagesCursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    );
  } catch {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid message cursor' });
  }
}

function isUniqueViolation(error: unknown): boolean {
  const pgCodeFrom = (e: unknown): string | undefined =>
    e && typeof e === 'object' && 'code' in e
      ? ((e as { code?: unknown }).code as string | undefined)
      : undefined;
  if (pgCodeFrom(error) === '23505') return true;
  const cause =
    error && typeof error === 'object' && 'cause' in error
      ? (error as { cause?: unknown }).cause
      : undefined;
  if (pgCodeFrom(cause) === '23505') return true;
  return false;
}

/**
 * Authorises an organization scope (when present) and returns the scope filter
 * for `quick_chat_threads`. A null scope is the caller's personal thread and
 * needs no membership check.
 */
async function resolveThreadScope(ctx: TRPCContext, organizationId: string | null): Promise<SQL> {
  if (organizationId !== null) {
    await ensureOrganizationAccess(ctx, organizationId);
  }
  return organizationId === null
    ? isNull(quick_chat_threads.organization_id)
    : eq(quick_chat_threads.organization_id, organizationId);
}

async function getOrCreateThread(
  ctx: TRPCContext,
  organizationId: string | null
): Promise<QuickChatThread> {
  const where = and(
    eq(quick_chat_threads.user_id, ctx.user.id),
    await resolveThreadScope(ctx, organizationId)
  );

  const [existing] = await db.select().from(quick_chat_threads).where(where).limit(1);
  if (existing) return existing;

  try {
    const [created] = await db
      .insert(quick_chat_threads)
      .values({ user_id: ctx.user.id, organization_id: organizationId })
      .returning();
    if (!created) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to create quick chat thread',
      });
    }
    return created;
  } catch (error) {
    // A concurrent request created the same thread first; resolve it rather
    // than surfacing the unique-constraint violation.
    if (isUniqueViolation(error)) {
      const [raced] = await db.select().from(quick_chat_threads).where(where).limit(1);
      if (raced) return raced;
    }
    throw error;
  }
}

export const quickChatRouter = createTRPCRouter({
  getOrCreateThread: baseProcedure.input(threadScopeInput).mutation(async ({ ctx, input }) => {
    const thread = await getOrCreateThread(ctx, input.organizationId);
    return serializeThread(thread);
  }),

  listMessages: baseProcedure.input(listMessagesInput).query(async ({ ctx, input }) => {
    const cursor = input.cursor ? decodeMessagesCursor(input.cursor) : null;
    const where = and(
      eq(quick_chat_threads.user_id, ctx.user.id),
      await resolveThreadScope(ctx, input.organizationId)
    );
    const [thread] = await db
      .select({ id: quick_chat_threads.id })
      .from(quick_chat_threads)
      .where(where)
      .limit(1);
    if (!thread) return { messages: [], nextCursor: null };

    const pageFilters = [
      eq(quick_chat_messages.thread_id, thread.id),
      ...(cursor
        ? [
            or(
              lt(quick_chat_messages.created_at, cursor.createdAt),
              and(
                eq(quick_chat_messages.created_at, cursor.createdAt),
                lt(quick_chat_messages.id, cursor.id)
              )
            ),
          ]
        : []),
    ];
    const rows = await db
      .select()
      .from(quick_chat_messages)
      .where(and(...pageFilters))
      .orderBy(desc(quick_chat_messages.created_at), desc(quick_chat_messages.id))
      .limit(input.limit + 1);

    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    const nextCursor = hasMore ? encodeMessagesCursor(page[page.length - 1]) : null;

    return {
      messages: page.reverse().map(serializeMessage),
      nextCursor,
    };
  }),

  appendMessages: baseProcedure.input(appendMessagesInput).mutation(async ({ ctx, input }) => {
    const thread = await getOrCreateThread(ctx, input.organizationId);
    // A single INSERT assigns every row the same `now()`, so `listMessages`
    // would tie-break on the random `id` and return this batch in random order.
    // Give each row a strictly-increasing `created_at` so the append order is
    // deterministic.
    const base = Date.now();
    const inserted = await db
      .insert(quick_chat_messages)
      .values(
        input.messages.map((message, i) => ({
          thread_id: thread.id,
          role: message.role,
          content: message.content,
          client_id: message.clientId ?? null,
          created_at: new Date(base + i).toISOString(),
        }))
      )
      .returning();
    return inserted.map(serializeMessage);
  }),
});
