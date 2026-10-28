import 'server-only';
import {
  cli_sessions_v2,
  todo_item_sessions,
  todo_items,
  todo_lists,
  type TodoItemRow,
  type TodoListRow,
} from '@kilocode/db/schema';
import { TodoItemSessionOrigin } from '@kilocode/db/schema-types';
import { TRPCError } from '@trpc/server';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  max,
  min,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';
import * as z from 'zod';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { baseProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { sameGitProject } from '@/lib/todos/git-url-project';
import { positionBetween } from '@/lib/todos/position';

type Executor = typeof db | DrizzleTransaction;
type ProcedureContext = Parameters<typeof ensureOrganizationAccess>[0];

type TodoList = {
  id: string;
  organizationId: string | null;
  name: string;
  emoji: string | null;
  gitUrl: string | null;
  mode: string | null;
  model: string | null;
  variant: string | null;
  position: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  openCount: number;
};

type TodoLinkedSession = {
  sessionId: string;
  title: string | null;
  status: string | null;
  prUrl: string | null;
  prVerified: boolean;
  lastActivityAt: string | null;
  origin: TodoItemSessionOrigin;
  linkedAt: string;
};

type TodoItem = {
  id: string;
  listId: string;
  title: string;
  notes: string | null;
  doneAt: string | null;
  position: string;
  createdAt: string;
  updatedAt: string;
  sessions: TodoLinkedSession[];
};

const idSchema = z.uuid().transform(id => id.toLowerCase());
const organizationIdSchema = idSchema.nullable().optional();
const neighbourIdSchema = idSchema.nullable().optional();
const sessionIdSchema = z.string().min(1).max(200);
const nameSchema = z.string().trim().min(1).max(100);
const emojiSchema = z
  .string()
  .trim()
  .max(16)
  .nullable()
  .transform(emoji => emoji || null);
const repositorySchema = z.string().trim().min(1).max(500).nullable();
const sessionDefaultSchema = z.string().trim().min(1).max(200).nullable();
const titleSchema = z.string().trim().min(1).max(500);
const notesSchema = z
  .string()
  .max(10000)
  .nullable()
  .transform(notes => (notes?.trim() ? notes : null));
const originSchema = z.enum([TodoItemSessionOrigin.Started, TodoItemSessionOrigin.Linked]);

const moveInputSchema = z.object({
  id: idSchema,
  beforeId: neighbourIdSchema,
  afterId: neighbourIdSchema,
});

function toIso(value: string): string {
  return new Date(value).toISOString();
}

function notFound(message: string): TRPCError {
  return new TRPCError({ code: 'NOT_FOUND', message });
}

async function resolveOrganizationScope(
  ctx: ProcedureContext,
  organizationId: string | null | undefined
): Promise<string | null> {
  if (organizationId === undefined || organizationId === null) return null;
  await ensureOrganizationAccess(ctx, organizationId);
  return organizationId;
}

function listScopeCondition(userId: string, organizationId: string | null): SQL | undefined {
  return and(
    eq(todo_lists.kilo_user_id, userId),
    organizationId === null
      ? isNull(todo_lists.organization_id)
      : eq(todo_lists.organization_id, organizationId)
  );
}

// Serializes every ordering write for one user so concurrent creates and moves
// never compute the same fractional key.
async function lockPositions(tx: DrizzleTransaction, userId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('todo_positions'), hashtext(${userId}))`
  );
}

/**
 * The key for a row moved between `before` and `after`. The client names the
 * rows it shows around the drop point, but hidden rows (done to-dos,
 * archived lists) can sit between them: a `positionBetween` over a
 * non-adjacent pair can return a key an existing row already holds. Only a
 * truly adjacent `after` is used directly; anything else lands the row right
 * below `before`. Returns `null` when the client named no neighbour.
 */
async function positionForMove(
  before: string | null,
  after: string | null,
  adjacent: (direction: 'previous' | 'next', key: string) => Promise<string | null>
): Promise<string | null> {
  if (before !== null) {
    const next = await adjacent('next', before);
    if (after === null || after <= before || after !== next) {
      return positionBetween(before, next);
    }
    return positionBetween(before, after);
  }
  if (after !== null) {
    return positionBetween(await adjacent('previous', after), after);
  }
  return null;
}

function serializeList(row: TodoListRow, openCount: number): TodoList {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    emoji: row.emoji,
    gitUrl: row.git_url,
    mode: row.mode,
    model: row.model,
    variant: row.variant,
    position: row.position,
    archivedAt: row.archived_at === null ? null : toIso(row.archived_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    openCount,
  };
}

async function selectLists(executor: Executor, where: SQL | undefined): Promise<TodoList[]> {
  // A left join, not a correlated subquery: Drizzle writes an interpolated
  // column unqualified, so inside a subquery `todo_lists.id` would resolve to
  // the subquery's own `todo_items.id`.
  const rows = await executor
    .select({ list: todo_lists, openCount: count(todo_items.id) })
    .from(todo_lists)
    .leftJoin(
      todo_items,
      and(
        eq(todo_items.list_id, todo_lists.id),
        eq(todo_items.kilo_user_id, todo_lists.kilo_user_id),
        isNull(todo_items.done_at)
      )
    )
    .where(where)
    .groupBy(todo_lists.id)
    .orderBy(asc(todo_lists.position), asc(todo_lists.id));
  return rows.map(row => serializeList(row.list, Number(row.openCount)));
}

async function getList(executor: Executor, userId: string, id: string): Promise<TodoList> {
  const [list] = await selectLists(
    executor,
    and(eq(todo_lists.kilo_user_id, userId), eq(todo_lists.id, id))
  );
  if (!list) throw notFound('List not found');
  return list;
}

async function requireListRow(
  executor: Executor,
  userId: string,
  id: string
): Promise<TodoListRow> {
  const [row] = await executor
    .select()
    .from(todo_lists)
    .where(and(eq(todo_lists.kilo_user_id, userId), eq(todo_lists.id, id)));
  if (!row) throw notFound('List not found');
  return row;
}

async function requireItemRow(
  executor: Executor,
  userId: string,
  id: string
): Promise<TodoItemRow> {
  const [row] = await executor
    .select()
    .from(todo_items)
    .where(and(eq(todo_items.kilo_user_id, userId), eq(todo_items.id, id)));
  if (!row) throw notFound('To-do not found');
  return row;
}

async function loadLinkedSessions(
  executor: Executor,
  userId: string,
  itemIds: string[]
): Promise<Map<string, TodoLinkedSession[]>> {
  const sessionsByItem = new Map<string, TodoLinkedSession[]>();
  if (itemIds.length === 0) return sessionsByItem;
  const rows = await executor
    .select({
      todoItemId: todo_item_sessions.todo_item_id,
      sessionId: todo_item_sessions.session_id,
      origin: todo_item_sessions.origin,
      linkedAt: todo_item_sessions.linked_at,
      title: cli_sessions_v2.title,
      status: cli_sessions_v2.status,
      prUrl: cli_sessions_v2.pr_url,
      prLinkVerifiedAt: cli_sessions_v2.pr_link_verified_at,
      lastActivityAt: cli_sessions_v2.last_activity_at,
    })
    .from(todo_item_sessions)
    .innerJoin(
      cli_sessions_v2,
      and(
        eq(cli_sessions_v2.session_id, todo_item_sessions.session_id),
        eq(cli_sessions_v2.kilo_user_id, todo_item_sessions.kilo_user_id)
      )
    )
    .where(
      and(
        eq(todo_item_sessions.kilo_user_id, userId),
        inArray(todo_item_sessions.todo_item_id, itemIds)
      )
    )
    .orderBy(desc(todo_item_sessions.linked_at), asc(todo_item_sessions.session_id));

  for (const row of rows) {
    // An unverified PR link is a guess and is never surfaced.
    const prUrl = row.prLinkVerifiedAt === null ? null : row.prUrl;
    const session: TodoLinkedSession = {
      sessionId: row.sessionId,
      title: row.title,
      status: row.status,
      prUrl,
      prVerified: prUrl !== null,
      lastActivityAt: row.lastActivityAt === null ? null : toIso(row.lastActivityAt),
      origin: row.origin,
      linkedAt: toIso(row.linkedAt),
    };
    const sessions = sessionsByItem.get(row.todoItemId);
    if (sessions) sessions.push(session);
    else sessionsByItem.set(row.todoItemId, [session]);
  }
  return sessionsByItem;
}

async function serializeItems(
  executor: Executor,
  userId: string,
  rows: TodoItemRow[]
): Promise<TodoItem[]> {
  const sessionsByItem = await loadLinkedSessions(
    executor,
    userId,
    rows.map(row => row.id)
  );
  return rows.map(row => ({
    id: row.id,
    listId: row.list_id,
    title: row.title,
    notes: row.notes,
    doneAt: row.done_at === null ? null : toIso(row.done_at),
    position: row.position,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    sessions: sessionsByItem.get(row.id) ?? [],
  }));
}

async function getItem(executor: Executor, userId: string, id: string): Promise<TodoItem> {
  const [item] = await serializeItems(executor, userId, [
    await requireItemRow(executor, userId, id),
  ]);
  if (!item) throw notFound('To-do not found');
  return item;
}

async function selectOpenItemsWithList(
  userId: string,
  organizationId: string | null,
  limit?: number
) {
  const query = db
    .select({ item: todo_items, list: todo_lists })
    .from(todo_items)
    .innerJoin(
      todo_lists,
      and(
        eq(todo_lists.id, todo_items.list_id),
        eq(todo_lists.kilo_user_id, todo_items.kilo_user_id)
      )
    )
    .where(
      and(
        listScopeCondition(userId, organizationId),
        isNull(todo_lists.archived_at),
        isNull(todo_items.done_at)
      )
    )
    .orderBy(
      asc(todo_lists.position),
      asc(todo_lists.id),
      asc(todo_items.position),
      asc(todo_items.id)
    );
  const rows = limit === undefined ? await query : await query.limit(limit);
  const items = await serializeItems(
    db,
    userId,
    rows.map(row => row.item)
  );
  return rows.flatMap((row, index) => {
    const item = items[index];
    return item ? [{ item, list: row.list }] : [];
  });
}

const listsRouter = createTRPCRouter({
  list: baseProcedure
    .input(
      z.object({
        organizationId: organizationIdSchema,
        includeArchived: z.boolean().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const organizationId = await resolveOrganizationScope(ctx, input.organizationId);
      return selectLists(
        db,
        and(
          listScopeCondition(ctx.user.id, organizationId),
          input.includeArchived ? undefined : isNull(todo_lists.archived_at)
        )
      );
    }),

  create: baseProcedure
    .input(
      z.object({
        organizationId: organizationIdSchema,
        name: nameSchema,
        emoji: emojiSchema.optional(),
        gitUrl: repositorySchema.optional(),
        mode: sessionDefaultSchema.optional(),
        model: sessionDefaultSchema.optional(),
        variant: sessionDefaultSchema.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = await resolveOrganizationScope(ctx, input.organizationId);
      return db.transaction(async tx => {
        await lockPositions(tx, ctx.user.id);
        const [last] = await tx
          .select({ position: max(todo_lists.position) })
          .from(todo_lists)
          .where(listScopeCondition(ctx.user.id, organizationId));
        const [row] = await tx
          .insert(todo_lists)
          .values({
            kilo_user_id: ctx.user.id,
            organization_id: organizationId,
            name: input.name,
            emoji: input.emoji ?? null,
            git_url: input.gitUrl ?? null,
            mode: input.mode ?? null,
            model: input.model ?? null,
            variant: input.variant ?? null,
            position: positionBetween(last?.position ?? null, null),
          })
          .returning();
        if (!row) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'List creation failed' });
        }
        return serializeList(row, 0);
      });
    }),

  update: baseProcedure
    .input(
      z
        .object({
          id: idSchema,
          name: nameSchema.optional(),
          emoji: emojiSchema.optional(),
          gitUrl: repositorySchema.optional(),
          mode: sessionDefaultSchema.optional(),
          model: sessionDefaultSchema.optional(),
          variant: sessionDefaultSchema.optional(),
          archived: z.boolean().optional(),
        })
        .refine(
          input =>
            [
              input.name,
              input.emoji,
              input.gitUrl,
              input.mode,
              input.model,
              input.variant,
              input.archived,
            ].some(change => change !== undefined),
          { message: 'Provide at least one change' }
        )
    )
    .mutation(async ({ ctx, input }) => {
      const [row] = await db
        .update(todo_lists)
        .set({
          name: input.name,
          emoji: input.emoji,
          git_url: input.gitUrl,
          mode: input.mode,
          model: input.model,
          variant: input.variant,
          archived_at:
            input.archived === undefined
              ? undefined
              : input.archived
                ? sql`coalesce(${todo_lists.archived_at}, now())`
                : null,
        })
        .where(and(eq(todo_lists.kilo_user_id, ctx.user.id), eq(todo_lists.id, input.id)))
        .returning({ id: todo_lists.id });
      if (!row) throw notFound('List not found');
      return getList(db, ctx.user.id, row.id);
    }),

  move: baseProcedure.input(moveInputSchema).mutation(async ({ ctx, input }) =>
    db.transaction(async tx => {
      await lockPositions(tx, ctx.user.id);
      const moved = await requireListRow(tx, ctx.user.id, input.id);
      const siblings = and(
        listScopeCondition(ctx.user.id, moved.organization_id),
        ne(todo_lists.id, moved.id)
      );
      const neighbourPosition = async (id: string | null | undefined) => {
        if (!id) return null;
        const neighbour = await requireListRow(tx, ctx.user.id, id);
        if (neighbour.organization_id !== moved.organization_id || neighbour.id === moved.id) {
          throw notFound('List not found');
        }
        return neighbour.position;
      };
      const position = await positionForMove(
        await neighbourPosition(input.beforeId),
        await neighbourPosition(input.afterId),
        async (direction, key) => {
          const [row] = await tx
            .select({
              position: direction === 'next' ? min(todo_lists.position) : max(todo_lists.position),
            })
            .from(todo_lists)
            .where(
              and(
                siblings,
                direction === 'next' ? gt(todo_lists.position, key) : lt(todo_lists.position, key)
              )
            );
          return row?.position ?? null;
        }
      );
      if (position !== null) {
        await tx.update(todo_lists).set({ position }).where(eq(todo_lists.id, moved.id));
      }
      return getList(tx, ctx.user.id, moved.id);
    })
  ),

  delete: baseProcedure.input(z.object({ id: idSchema })).mutation(async ({ ctx, input }) => {
    const [row] = await db
      .delete(todo_lists)
      .where(and(eq(todo_lists.kilo_user_id, ctx.user.id), eq(todo_lists.id, input.id)))
      .returning({ id: todo_lists.id });
    if (!row) throw notFound('List not found');
    return { id: row.id };
  }),
});

const itemsRouter = createTRPCRouter({
  list: baseProcedure.input(z.object({ listId: idSchema })).query(async ({ ctx, input }) => {
    await requireListRow(db, ctx.user.id, input.listId);
    const rows = await db
      .select()
      .from(todo_items)
      .where(and(eq(todo_items.kilo_user_id, ctx.user.id), eq(todo_items.list_id, input.listId)))
      .orderBy(
        sql`${todo_items.done_at} IS NOT NULL`,
        desc(todo_items.done_at),
        asc(todo_items.position),
        asc(todo_items.id)
      );
    return serializeItems(db, ctx.user.id, rows);
  }),

  upNext: baseProcedure
    .input(
      z.object({
        organizationId: organizationIdSchema,
        limit: z.number().int().min(1).max(10).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const organizationId = await resolveOrganizationScope(ctx, input.organizationId);
      const rows = await selectOpenItemsWithList(ctx.user.id, organizationId, input.limit ?? 3);
      return rows.map(({ item, list }) => ({
        ...item,
        listName: list.name,
        listEmoji: list.emoji,
      }));
    }),

  get: baseProcedure.input(z.object({ id: idSchema })).query(async ({ ctx, input }) => {
    const item = await getItem(db, ctx.user.id, input.id);
    return { ...item, list: await getList(db, ctx.user.id, item.listId) };
  }),

  create: baseProcedure
    .input(z.object({ listId: idSchema, title: titleSchema, notes: notesSchema.optional() }))
    .mutation(async ({ ctx, input }) =>
      db.transaction(async tx => {
        await lockPositions(tx, ctx.user.id);
        await requireListRow(tx, ctx.user.id, input.listId);
        const [first] = await tx
          .select({ position: min(todo_items.position) })
          .from(todo_items)
          .where(
            and(eq(todo_items.kilo_user_id, ctx.user.id), eq(todo_items.list_id, input.listId))
          );
        const [row] = await tx
          .insert(todo_items)
          .values({
            list_id: input.listId,
            kilo_user_id: ctx.user.id,
            title: input.title,
            notes: input.notes ?? null,
            position: positionBetween(null, first?.position ?? null),
          })
          .returning();
        if (!row) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'To-do creation failed' });
        }
        const [item] = await serializeItems(tx, ctx.user.id, [row]);
        if (!item) throw notFound('To-do not found');
        return item;
      })
    ),

  update: baseProcedure
    .input(
      z
        .object({
          id: idSchema,
          title: titleSchema.optional(),
          notes: notesSchema.optional(),
          done: z.boolean().optional(),
        })
        .refine(
          input =>
            input.title !== undefined || input.notes !== undefined || input.done !== undefined,
          { message: 'Provide at least one change' }
        )
    )
    .mutation(async ({ ctx, input }) => {
      const [row] = await db
        .update(todo_items)
        .set({
          title: input.title,
          notes: input.notes,
          done_at:
            input.done === undefined
              ? undefined
              : input.done
                ? sql`coalesce(${todo_items.done_at}, now())`
                : null,
        })
        .where(and(eq(todo_items.kilo_user_id, ctx.user.id), eq(todo_items.id, input.id)))
        .returning({ id: todo_items.id });
      if (!row) throw notFound('To-do not found');
      return getItem(db, ctx.user.id, row.id);
    }),

  move: baseProcedure.input(moveInputSchema).mutation(async ({ ctx, input }) =>
    db.transaction(async tx => {
      await lockPositions(tx, ctx.user.id);
      const moved = await requireItemRow(tx, ctx.user.id, input.id);
      const siblings = and(
        eq(todo_items.kilo_user_id, ctx.user.id),
        eq(todo_items.list_id, moved.list_id),
        ne(todo_items.id, moved.id)
      );
      const neighbourPosition = async (id: string | null | undefined) => {
        if (!id) return null;
        const neighbour = await requireItemRow(tx, ctx.user.id, id);
        if (neighbour.list_id !== moved.list_id || neighbour.id === moved.id) {
          throw notFound('To-do not found');
        }
        return neighbour.position;
      };
      const position = await positionForMove(
        await neighbourPosition(input.beforeId),
        await neighbourPosition(input.afterId),
        async (direction, key) => {
          const [row] = await tx
            .select({
              position: direction === 'next' ? min(todo_items.position) : max(todo_items.position),
            })
            .from(todo_items)
            .where(
              and(
                siblings,
                direction === 'next' ? gt(todo_items.position, key) : lt(todo_items.position, key)
              )
            );
          return row?.position ?? null;
        }
      );
      if (position !== null) {
        await tx.update(todo_items).set({ position }).where(eq(todo_items.id, moved.id));
      }
      return getItem(tx, ctx.user.id, moved.id);
    })
  ),

  delete: baseProcedure.input(z.object({ id: idSchema })).mutation(async ({ ctx, input }) => {
    const [row] = await db
      .delete(todo_items)
      .where(and(eq(todo_items.kilo_user_id, ctx.user.id), eq(todo_items.id, input.id)))
      .returning({ id: todo_items.id });
    if (!row) throw notFound('To-do not found');
    return { id: row.id };
  }),

  linkSession: baseProcedure
    .input(z.object({ id: idSchema, sessionId: sessionIdSchema, origin: originSchema }))
    .mutation(async ({ ctx, input }) =>
      db.transaction(async tx => {
        const item = await requireItemRow(tx, ctx.user.id, input.id);
        const [session] = await tx
          .select({ sessionId: cli_sessions_v2.session_id })
          .from(cli_sessions_v2)
          .where(
            and(
              eq(cli_sessions_v2.kilo_user_id, ctx.user.id),
              eq(cli_sessions_v2.session_id, input.sessionId)
            )
          );
        if (!session) throw notFound('Session not found');
        await tx
          .insert(todo_item_sessions)
          .values({
            todo_item_id: item.id,
            session_id: session.sessionId,
            kilo_user_id: ctx.user.id,
            origin: input.origin,
          })
          .onConflictDoUpdate({
            target: [todo_item_sessions.session_id, todo_item_sessions.kilo_user_id],
            set: { todo_item_id: item.id, origin: input.origin, linked_at: sql`now()` },
            setWhere: ne(todo_item_sessions.todo_item_id, item.id),
          });
        return getItem(tx, ctx.user.id, item.id);
      })
    ),

  unlinkSession: baseProcedure
    .input(z.object({ id: idSchema, sessionId: sessionIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const item = await requireItemRow(db, ctx.user.id, input.id);
      await db
        .delete(todo_item_sessions)
        .where(
          and(
            eq(todo_item_sessions.kilo_user_id, ctx.user.id),
            eq(todo_item_sessions.session_id, input.sessionId),
            eq(todo_item_sessions.todo_item_id, item.id)
          )
        );
      return getItem(db, ctx.user.id, item.id);
    }),

  forSession: baseProcedure
    .input(z.object({ sessionId: sessionIdSchema }))
    .query(async ({ ctx, input }) => {
      const [row] = await db
        .select({
          id: todo_items.id,
          title: todo_items.title,
          listId: todo_lists.id,
          listName: todo_lists.name,
        })
        .from(todo_item_sessions)
        .innerJoin(
          todo_items,
          and(
            eq(todo_items.id, todo_item_sessions.todo_item_id),
            eq(todo_items.kilo_user_id, todo_item_sessions.kilo_user_id)
          )
        )
        .innerJoin(
          todo_lists,
          and(
            eq(todo_lists.id, todo_items.list_id),
            eq(todo_lists.kilo_user_id, todo_items.kilo_user_id)
          )
        )
        .where(
          and(
            eq(todo_item_sessions.kilo_user_id, ctx.user.id),
            eq(todo_item_sessions.session_id, input.sessionId)
          )
        );
      return row ?? null;
    }),

  candidatesForSession: baseProcedure
    .input(z.object({ sessionId: sessionIdSchema, organizationId: organizationIdSchema }))
    .query(async ({ ctx, input }) => {
      const [session] = await db
        .select({
          gitUrl: cli_sessions_v2.git_url,
          organizationId: cli_sessions_v2.organization_id,
        })
        .from(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.kilo_user_id, ctx.user.id),
            eq(cli_sessions_v2.session_id, input.sessionId)
          )
        );
      if (!session) throw notFound('Session not found');
      const organizationId =
        input.organizationId === undefined
          ? session.organizationId
          : await resolveOrganizationScope(ctx, input.organizationId);
      const rows = await selectOpenItemsWithList(ctx.user.id, organizationId);
      const candidates = rows.map(({ item, list }) => ({
        ...item,
        listName: list.name,
        sameRepo:
          session.gitUrl !== null &&
          list.git_url !== null &&
          sameGitProject(session.gitUrl, list.git_url),
      }));
      return [
        ...candidates.filter(candidate => candidate.sameRepo),
        ...candidates.filter(candidate => !candidate.sameRepo),
      ];
    }),
});

export const todosRouter = createTRPCRouter({
  lists: listsRouter,
  items: itemsRouter,
});
