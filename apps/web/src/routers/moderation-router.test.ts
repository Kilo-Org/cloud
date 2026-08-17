import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import {
  content_moderation_reports,
  user_github_app_tokens,
  user_moderation_blocks,
  user_moderation_mutes,
  user_terms_acceptances,
} from '@kilocode/db/schema';
import { CURRENT_UGC_TERMS_VERSION } from '@kilocode/app-shared/moderation';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';

let user: User;

describe('moderation-router', () => {
  beforeAll(async () => {
    user = await insertTestUser({
      google_user_email: 'moderation-router@example.com',
      google_user_name: 'Moderation Router User',
    });
  });

  afterEach(async () => {
    await db.delete(content_moderation_reports).where(eq(content_moderation_reports.kilo_user_id, user.id));
    await db.delete(user_moderation_blocks).where(eq(user_moderation_blocks.blocker_user_id, user.id));
    await db.delete(user_moderation_mutes).where(eq(user_moderation_mutes.blocker_user_id, user.id));
    await db.delete(user_terms_acceptances).where(eq(user_terms_acceptances.kilo_user_id, user.id));
    await db.delete(user_github_app_tokens).where(eq(user_github_app_tokens.kilo_user_id, user.id));
  });

  it('reports content and returns a receipt with received triage', async () => {
    const caller = await createCallerForUser(user.id);

    const result = await caller.moderation.reportContent({
      surface: 'ai_output',
      targetKind: 'message',
      targetId: 'msg-123',
      modelId: 'openai/gpt-4.1',
      sessionId: 'ses_abc',
      reason: 'other',
      context: { platform: 'mobile', storefront: 'apple' },
    });

    expect(result).toEqual({ receiptId: expect.any(String), triageStatus: 'received' });

    const [row] = await db
      .select()
      .from(content_moderation_reports)
      .where(eq(content_moderation_reports.receipt_id, result.receiptId));
    expect(row).toBeDefined();
    expect(row.kilo_user_id).toBe(user.id);
    expect(row.target_kind).toBe('message');
    expect(row.target_id).toBe('msg-123');
    expect(row.context_json).toEqual({ platform: 'mobile', storefront: 'apple' });
  });

  it('allows a duplicate report of the same target with a new receipt', async () => {
    const caller = await createCallerForUser(user.id);
    const input = {
      surface: 'pr_discussion_content' as const,
      targetKind: 'comment' as const,
      targetId: '12345',
      reason: 'spam' as const,
      context: { platform: 'mobile' },
    };

    const first = await caller.moderation.reportContent(input);
    const second = await caller.moderation.reportContent(input);

    expect(second.receiptId).not.toBe(first.receiptId);
    expect(second.triageStatus).toBe('received');

    const rows = await db
      .select()
      .from(content_moderation_reports)
      .where(eq(content_moderation_reports.target_id, '12345'));
    expect(rows).toHaveLength(2);
  });

  it('rejects a report whose context carries a body key', async () => {
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.moderation.reportContent({
        surface: 'ai_output',
        targetKind: 'message',
        targetId: 'msg-456',
        reason: 'other',
        // @ts-expect-error — `body` is not an allowed context key.
        context: { platform: 'mobile', body: 'secret message text' },
      })
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it('rejects blocking the caller own GitHub login', async () => {
    await db.insert(user_github_app_tokens).values({
      kilo_user_id: user.id,
      github_app_type: 'standard',
      github_user_id: '101',
      github_login: 'octocat',
      access_token_encrypted: 'opaque-access-envelope',
      access_token_expires_at: '2030-01-01T00:00:00.000Z',
      refresh_token_encrypted: 'opaque-refresh-envelope',
      refresh_token_expires_at: '2030-01-01T00:00:00.000Z',
    });

    const caller = await createCallerForUser(user.id);

    await expect(caller.moderation.blockUser({ githubLogin: 'octocat' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('blocks and mutes other logins and lists hidden users', async () => {
    const caller = await createCallerForUser(user.id);

    await caller.moderation.blockUser({ githubLogin: 'alice' });
    await caller.moderation.muteUser({ githubLogin: 'bob' });

    const hidden = await caller.moderation.listHiddenUsers();
    expect(hidden.blockedLogins).toEqual(['alice']);
    expect(hidden.mutedLogins).toEqual(['bob']);

    await caller.moderation.unblockUser({ githubLogin: 'alice' });
    await caller.moderation.unmuteUser({ githubLogin: 'bob' });

    const after = await caller.moderation.listHiddenUsers();
    expect(after.blockedLogins).toEqual([]);
    expect(after.mutedLogins).toEqual([]);
  });

  it('rejects accepting a non-current terms version', async () => {
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.moderation.acceptTerms({ version: 'stale-version', agePosture: '13_plus' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('accepts the current terms and reports terms status', async () => {
    const caller = await createCallerForUser(user.id);

    const before = await caller.moderation.getTermsStatus();
    expect(before).toEqual({
      currentVersion: CURRENT_UGC_TERMS_VERSION,
      acceptedVersion: null,
      accepted: false,
      agePosture: null,
    });

    await caller.moderation.acceptTerms({
      version: CURRENT_UGC_TERMS_VERSION,
      agePosture: '13_plus',
    });

    const after = await caller.moderation.getTermsStatus();
    expect(after).toEqual({
      currentVersion: CURRENT_UGC_TERMS_VERSION,
      acceptedVersion: CURRENT_UGC_TERMS_VERSION,
      accepted: true,
      agePosture: '13_plus',
    });
  });

  it('submits an appeal only for an actioned or rejected report', async () => {
    const caller = await createCallerForUser(user.id);
    const { receiptId } = await caller.moderation.reportContent({
      surface: 'ai_output',
      targetKind: 'message',
      targetId: 'msg-789',
      reason: 'other',
      context: { platform: 'mobile' },
    });

    // A still-`received` report cannot be appealed.
    await expect(
      caller.moderation.appealReport({ receiptId, reason: 'I disagree' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await db
      .update(content_moderation_reports)
      .set({ triage_status: 'actioned' })
      .where(eq(content_moderation_reports.receipt_id, receiptId));

    const result = await caller.moderation.appealReport({ receiptId, reason: 'I disagree' });
    expect(result).toEqual({ appealStatus: 'submitted' });

    const receipt = await caller.moderation.getReportReceipt({ receiptId });
    expect(receipt).toEqual({
      receiptId,
      triageStatus: 'actioned',
      appealStatus: 'submitted',
    });
  });

  it('hides a receipt from a non-reporter', async () => {
    const otherUser = await insertTestUser();
    const caller = await createCallerForUser(user.id);
    const { receiptId } = await caller.moderation.reportContent({
      surface: 'ai_output',
      targetKind: 'message',
      targetId: 'msg-999',
      reason: 'other',
      context: { platform: 'mobile' },
    });

    const otherCaller = await createCallerForUser(otherUser.id);
    await expect(otherCaller.moderation.getReportReceipt({ receiptId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
