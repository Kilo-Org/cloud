import 'server-only';

import * as z from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';

import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
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
 * Report context is minimized by construction: only `platform` and an optional
 * `storefront` are accepted. `.strict()` rejects any other key (notably a
 * `body`) so a message or comment body can never be persisted.
 */
const ReportContextSchema = z
  .object({
    platform: z.string(),
    storefront: z.string().optional(),
  })
  .strict();

const ReportContentInput = z.object({
  surface: z.enum(MODERATION_SURFACES),
  targetKind: z.enum(['message', 'comment']),
  targetId: z.string(),
  modelId: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  reason: z.enum(MODERATION_REASONS),
  context: ReportContextSchema,
});

const ReportUserInput = z.object({
  targetId: z.string(),
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
