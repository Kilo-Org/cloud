import 'server-only';

import * as z from 'zod';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';

import { baseProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  content_moderation_reports,
  user_github_app_tokens,
  user_moderation_blocks,
  user_moderation_mutes,
  user_terms_acceptances,
} from '@kilocode/db/schema';
import {
  CURRENT_UGC_TERMS_VERSION,
  MODERATION_REASONS,
  MODERATION_SURFACES,
  UGC_AGE_POSTURE,
} from '@kilocode/app-shared/moderation';

/**
 * Maximum lengths enforced on the report metadata this router stores. The caps
 * cover the longest values the reporting clients send: UUID message ids,
 * numeric discussion comment ids, provider-prefixed model ids, cloud-agent
 * session ids, and short client labels such as `mobile`/`apple`.
 */
const TARGET_ID_MAX_LENGTH = 255;
const MODEL_ID_MAX_LENGTH = 200;
const SESSION_ID_MAX_LENGTH = 255;
const CONTEXT_VALUE_MAX_LENGTH = 64;

/**
 * Report context is minimized by construction: only `platform` and an optional
 * `storefront` are accepted. `.strict()` rejects any other key (notably a
 * `body`) so a message or comment body can never be persisted.
 */
const ReportContextSchema = z
  .object({
    platform: z.string().max(CONTEXT_VALUE_MAX_LENGTH),
    storefront: z.string().max(CONTEXT_VALUE_MAX_LENGTH).optional(),
  })
  .strict();

const ReportContentInput = z.object({
  surface: z.enum(MODERATION_SURFACES),
  targetKind: z.enum(['message', 'comment']),
  targetId: z.string().max(TARGET_ID_MAX_LENGTH),
  modelId: z.string().max(MODEL_ID_MAX_LENGTH).nullable().optional(),
  sessionId: z.string().max(SESSION_ID_MAX_LENGTH).nullable().optional(),
  reason: z.enum(MODERATION_REASONS),
  context: ReportContextSchema,
});

const ReportUserInput = z.object({
  targetId: z.string().max(TARGET_ID_MAX_LENGTH),
  reason: z.enum(MODERATION_REASONS),
});

const ReceiptInput = z.object({ receiptId: z.uuid() });

const AppealInput = z.object({ receiptId: z.uuid() });

const HiddenUserInput = z.object({ githubLogin: z.string().min(1) });

const AcceptTermsInput = z.object({
  version: z.string(),
  agePosture: z.literal('13_plus'),
});

/** Reads the caller's stored GitHub login without any GitHub HTTP call. */
async function getStoredGitHubLogin(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ github_login: user_github_app_tokens.github_login })
    .from(user_github_app_tokens)
    .where(eq(user_github_app_tokens.kilo_user_id, userId))
    .limit(1);
  return row?.github_login ?? null;
}

/** Rejects a block/mute of the caller's own GitHub login. */
async function assertNotSelf(userId: string, githubLogin: string): Promise<void> {
  const storedLogin = await getStoredGitHubLogin(userId);
  if (storedLogin && storedLogin.toLowerCase() === githubLogin.toLowerCase()) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'cannot_target_self' });
  }
}

/** Returns the report row for a receipt, or throws if absent or not the reporter. */
async function getOwnedReport(receiptId: string, userId: string) {
  const [row] = await db
    .select()
    .from(content_moderation_reports)
    .where(eq(content_moderation_reports.receipt_id, receiptId));
  if (!row || row.kilo_user_id !== userId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'receipt_not_found' });
  }
  return row;
}

const REPORT_RECEIPTS_DEFAULT_PAGE_SIZE = 30;
const REPORT_RECEIPTS_MAX_PAGE_SIZE = 50;

/**
 * Cursor for one page of report receipts: the last row's `(created_at, id)`
 * verbatim, in the same `created_at|id` shape the notification history uses.
 * `created_at` is a timestamptz returned as text with microsecond precision, so
 * it travels through the cursor untouched: normalizing it through
 * `new Date(...).toISOString()` would truncate microseconds and silently skip
 * rows that share a millisecond.
 */
const REPORT_RECEIPT_CURSOR_SEPARATOR = '|';
const REPORT_RECEIPT_ROW_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeReportReceiptCursor(row: { created_at: string; id: string }): string {
  return `${row.created_at}${REPORT_RECEIPT_CURSOR_SEPARATOR}${row.id}`;
}

function decodeReportReceiptCursor(cursor: string): { createdAt: string; id: string } | null {
  const separatorIndex = cursor.indexOf(REPORT_RECEIPT_CURSOR_SEPARATOR);
  if (separatorIndex <= 0) return null;
  const createdAt = cursor.slice(0, separatorIndex);
  const id = cursor.slice(separatorIndex + 1);
  if (!REPORT_RECEIPT_ROW_ID_PATTERN.test(id)) return null;
  if (Number.isNaN(new Date(createdAt).getTime())) return null;
  return { createdAt, id };
}

/**
 * Newest-first, keyset-paginated page of the caller's own report receipts.
 *
 * Owner scoping lives in the WHERE clause instead of a post-fetch check, so a
 * receipt that belongs to someone else can never appear in the result set, not
 * even transiently. The keyset compares `(created_at, id)` against the last row
 * rather than using an offset, so a page stays stable while new reports arrive:
 * a report created after the first page was read lands ahead of the cursor and
 * never shifts the rows a client is paging through.
 */
async function listOwnedReports(input: {
  userId: string;
  cursor?: string;
  limit?: number;
}): Promise<{
  items: {
    receiptId: string;
    triageStatus: string;
    appealStatus: string;
    createdAt: string;
  }[];
  nextCursor: string | null;
}> {
  const limit = Math.min(
    Math.max(1, input.limit ?? REPORT_RECEIPTS_DEFAULT_PAGE_SIZE),
    REPORT_RECEIPTS_MAX_PAGE_SIZE
  );

  const conditions = [eq(content_moderation_reports.kilo_user_id, input.userId)];
  if (input.cursor !== undefined) {
    const cursor = decodeReportReceiptCursor(input.cursor);
    if (!cursor) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid report receipt cursor.' });
    }
    const cursorPredicate = or(
      lt(content_moderation_reports.created_at, cursor.createdAt),
      and(
        eq(content_moderation_reports.created_at, cursor.createdAt),
        lt(content_moderation_reports.id, cursor.id)
      )
    );
    if (cursorPredicate) conditions.push(cursorPredicate);
  }

  const rows = await db
    .select({
      id: content_moderation_reports.id,
      receipt_id: content_moderation_reports.receipt_id,
      triage_status: content_moderation_reports.triage_status,
      appeal_status: content_moderation_reports.appeal_status,
      created_at: content_moderation_reports.created_at,
    })
    .from(content_moderation_reports)
    .where(and(...conditions))
    .orderBy(desc(content_moderation_reports.created_at), desc(content_moderation_reports.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return {
    items: page.map(row => ({
      receiptId: row.receipt_id,
      triageStatus: row.triage_status,
      appealStatus: row.appeal_status,
      createdAt: row.created_at,
    })),
    nextCursor: hasMore && last ? encodeReportReceiptCursor(last) : null,
  };
}

export const moderationRouter = createTRPCRouter({
  reportContent: baseProcedure.input(ReportContentInput).mutation(async ({ ctx, input }) => {
    const [row] = await db
      .insert(content_moderation_reports)
      .values({
        kilo_user_id: ctx.user.id,
        surface: input.surface,
        target_kind: input.targetKind,
        target_id: input.targetId,
        model_id: input.modelId ?? null,
        session_id: input.sessionId ?? null,
        reason: input.reason,
        context_json: input.context,
      })
      .returning({ receipt_id: content_moderation_reports.receipt_id });

    if (!row) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'report_insert_failed' });
    }

    return { receiptId: row.receipt_id, triageStatus: 'received' as const };
  }),

  reportUser: baseProcedure.input(ReportUserInput).mutation(async ({ ctx, input }) => {
    const [row] = await db
      .insert(content_moderation_reports)
      .values({
        kilo_user_id: ctx.user.id,
        surface: 'pr_discussion_user',
        target_kind: 'user',
        target_id: input.targetId,
        reason: input.reason,
        context_json: {},
      })
      .returning({ receipt_id: content_moderation_reports.receipt_id });

    if (!row) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'report_insert_failed' });
    }

    return { receiptId: row.receipt_id, triageStatus: 'received' as const };
  }),

  getReportReceipt: baseProcedure.input(ReceiptInput).query(async ({ ctx, input }) => {
    const row = await getOwnedReport(input.receiptId, ctx.user.id);
    return {
      receiptId: row.receipt_id,
      triageStatus: row.triage_status,
      appealStatus: row.appeal_status,
    };
  }),

  listReportReceipts: baseProcedure
    .input(
      z.object({
        /** Opaque cursor from a previous page's `nextCursor`. */
        cursor: z.string().min(1).max(512).optional(),
        limit: z.number().int().min(1).max(REPORT_RECEIPTS_MAX_PAGE_SIZE).optional(),
      })
    )
    .query(({ ctx, input }) =>
      listOwnedReports({ userId: ctx.user.id, cursor: input.cursor, limit: input.limit })
    ),

  appealReport: baseProcedure.input(AppealInput).mutation(async ({ ctx, input }) => {
    const row = await getOwnedReport(input.receiptId, ctx.user.id);

    const appealable =
      row.appeal_status === 'none' &&
      (row.triage_status === 'actioned' || row.triage_status === 'rejected');
    if (!appealable) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'appeal_not_allowed' });
    }

    await db
      .update(content_moderation_reports)
      .set({ appeal_status: 'submitted' })
      .where(eq(content_moderation_reports.receipt_id, input.receiptId));

    return { appealStatus: 'submitted' as const };
  }),

  blockUser: baseProcedure.input(HiddenUserInput).mutation(async ({ ctx, input }) => {
    await assertNotSelf(ctx.user.id, input.githubLogin);
    await db
      .insert(user_moderation_blocks)
      .values({
        blocker_user_id: ctx.user.id,
        blocked_github_login: input.githubLogin.toLowerCase(),
      })
      .onConflictDoNothing();
    return { ok: true };
  }),

  unblockUser: baseProcedure.input(HiddenUserInput).mutation(async ({ ctx, input }) => {
    await db
      .delete(user_moderation_blocks)
      .where(
        and(
          eq(user_moderation_blocks.blocker_user_id, ctx.user.id),
          eq(user_moderation_blocks.blocked_github_login, input.githubLogin.toLowerCase())
        )
      );
    return { ok: true };
  }),

  muteUser: baseProcedure.input(HiddenUserInput).mutation(async ({ ctx, input }) => {
    await assertNotSelf(ctx.user.id, input.githubLogin);
    await db
      .insert(user_moderation_mutes)
      .values({ blocker_user_id: ctx.user.id, muted_github_login: input.githubLogin.toLowerCase() })
      .onConflictDoNothing();
    return { ok: true };
  }),

  unmuteUser: baseProcedure.input(HiddenUserInput).mutation(async ({ ctx, input }) => {
    await db
      .delete(user_moderation_mutes)
      .where(
        and(
          eq(user_moderation_mutes.blocker_user_id, ctx.user.id),
          eq(user_moderation_mutes.muted_github_login, input.githubLogin.toLowerCase())
        )
      );
    return { ok: true };
  }),

  listHiddenUsers: baseProcedure.query(async ({ ctx }) => {
    const [blocks, mutes] = await Promise.all([
      db
        .select({ login: user_moderation_blocks.blocked_github_login })
        .from(user_moderation_blocks)
        .where(eq(user_moderation_blocks.blocker_user_id, ctx.user.id)),
      db
        .select({ login: user_moderation_mutes.muted_github_login })
        .from(user_moderation_mutes)
        .where(eq(user_moderation_mutes.blocker_user_id, ctx.user.id)),
    ]);
    return {
      blockedLogins: blocks.map(b => b.login),
      mutedLogins: mutes.map(m => m.login),
    };
  }),

  getTermsStatus: baseProcedure.query(async ({ ctx }) => {
    const [row] = await db
      .select()
      .from(user_terms_acceptances)
      .where(
        and(
          eq(user_terms_acceptances.kilo_user_id, ctx.user.id),
          eq(user_terms_acceptances.terms_version, CURRENT_UGC_TERMS_VERSION)
        )
      );
    return {
      currentVersion: CURRENT_UGC_TERMS_VERSION,
      acceptedVersion: row?.terms_version ?? null,
      accepted: row != null,
      agePosture: row?.age_posture ?? null,
    };
  }),

  acceptTerms: baseProcedure.input(AcceptTermsInput).mutation(async ({ ctx, input }) => {
    if (input.version !== CURRENT_UGC_TERMS_VERSION || input.agePosture !== UGC_AGE_POSTURE) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'invalid_terms' });
    }

    await db
      .insert(user_terms_acceptances)
      .values({
        kilo_user_id: ctx.user.id,
        terms_version: input.version,
        age_posture: input.agePosture,
      })
      .onConflictDoUpdate({
        target: [user_terms_acceptances.kilo_user_id, user_terms_acceptances.terms_version],
        set: { age_posture: input.agePosture, accepted_at: sql`now()` },
      });

    return { ok: true };
  }),
});
