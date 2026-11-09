import { afterEach, describe, test, expect, jest } from '@jest/globals';
import { eq } from 'drizzle-orm';
import {
  admin_action_audit_logs,
  kilo_pass_subscriptions,
  kilocode_users,
  organizations,
  user_admin_notes,
  user_auth_provider,
} from '@kilocode/db/schema';
import {
  createDeletionInProgressBlockedReason,
  createSoftDeletedBlockedReason,
} from '@kilocode/db/user-soft-delete';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { client as stripeClient } from '@kilocode/web-shared/lib/stripe-client';
import { KiloPassCadence, KiloPassTier } from '@kilocode/web-shared/lib/kilo-pass/enums';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';
import { getAllUserProviders } from '@/lib/user';
import { hosted_domain_specials } from '@kilocode/web-shared/lib/auth/constants';
import { createOrganization } from '@kilocode/web-shared/lib/organizations/organizations';

async function kiloPassAuditRows(targetUserId: string) {
  const rows = await db
    .select()
    .from(admin_action_audit_logs)
    .where(eq(admin_action_audit_logs.action, 'kilo_pass.cancel_refund'));
  return rows.filter(row => row.target_id === targetUserId);
}

async function getBlockState(id: string) {
  return db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, id),
    columns: {
      blocked_reason: true,
      blocked_at: true,
      blocked_by_kilo_user_id: true,
      api_token_pepper: true,
    },
  });
}

describe('admin.users.updateBlockStatus', () => {
  test('blocking a user rotates the api_token_pepper', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser({ api_token_pepper: 'initial-pepper' });

    const caller = await createCallerForUser(admin.id);
    const result = await caller.admin.users.updateBlockStatus({
      userId: user.id,
      blocked_reason: 'manual admin block',
    });
    expect(result).toEqual({ success: true });

    const after = await getBlockState(user.id);
    expect(after?.blocked_reason).toBe('manual admin block');
    expect(after?.blocked_by_kilo_user_id).toBe(admin.id);
    expect(after?.blocked_at).not.toBeNull();
    expect(after?.api_token_pepper).toEqual(expect.any(String));
    expect(after?.api_token_pepper).not.toBe('initial-pepper');
  });

  test('unblocking clears block fields and leaves the pepper untouched', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser({
      api_token_pepper: 'blocked-pepper',
      blocked_reason: 'previously blocked',
      blocked_at: new Date().toISOString(),
    });

    const caller = await createCallerForUser(admin.id);
    const result = await caller.admin.users.updateBlockStatus({
      userId: user.id,
      blocked_reason: null,
    });
    expect(result).toEqual({ success: true });

    const after = await getBlockState(user.id);
    expect(after?.blocked_reason).toBeNull();
    expect(after?.blocked_at).toBeNull();
    expect(after?.blocked_by_kilo_user_id).toBeNull();
    // Unblock must not rotate the pepper (it is not a revocation event).
    expect(after?.api_token_pepper).toBe('blocked-pepper');
  });

  test('blocking an already-blocked user preserves the original block and pepper', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser({
      api_token_pepper: 'first-block-pepper',
      blocked_reason: 'first reason',
      blocked_at: new Date().toISOString(),
    });

    const caller = await createCallerForUser(admin.id);
    await caller.admin.users.updateBlockStatus({
      userId: user.id,
      blocked_reason: 'second reason',
    });

    const after = await getBlockState(user.id);
    // Existing block is never overwritten; the original reason and pepper stand.
    expect(after?.blocked_reason).toBe('first reason');
    expect(after?.api_token_pepper).toBe('first-block-pepper');
  });

  test('unblocking a deletion-in-progress user is refused and leaves fields intact', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const blockedAt = new Date().toISOString();
    const blockedReason = createDeletionInProgressBlockedReason(new Date(blockedAt));
    const user = await insertTestUser({
      api_token_pepper: 'deleting-pepper',
      blocked_reason: blockedReason,
      blocked_at: blockedAt,
      blocked_by_kilo_user_id: admin.id,
    });

    const caller = await createCallerForUser(admin.id);
    await expect(
      caller.admin.users.updateBlockStatus({
        userId: user.id,
        blocked_reason: null,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const after = await getBlockState(user.id);
    expect(after?.blocked_reason).toBe(blockedReason);
    expect(after?.blocked_at).not.toBeNull();
    expect(after?.blocked_by_kilo_user_id).toBe(admin.id);
    expect(after?.api_token_pepper).toBe('deleting-pepper');
  });

  test('unblocking a soft-deleted user is refused and leaves fields intact', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const blockedAt = new Date().toISOString();
    const blockedReason = createSoftDeletedBlockedReason(new Date(blockedAt));
    const user = await insertTestUser({
      api_token_pepper: 'deleted-pepper',
      blocked_reason: blockedReason,
      blocked_at: blockedAt,
      blocked_by_kilo_user_id: admin.id,
    });

    const caller = await createCallerForUser(admin.id);
    await expect(
      caller.admin.users.updateBlockStatus({
        userId: user.id,
        blocked_reason: null,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const after = await getBlockState(user.id);
    expect(after?.blocked_reason).toBe(blockedReason);
    expect(after?.blocked_at).not.toBeNull();
    expect(after?.blocked_by_kilo_user_id).toBe(admin.id);
    expect(after?.api_token_pepper).toBe('deleted-pepper');
  });
});

async function getAdminActionAudits(actorId: string) {
  return db
    .select()
    .from(admin_action_audit_logs)
    .where(eq(admin_action_audit_logs.actor_id, actorId));
}

describe('admin action audit logging', () => {
  test('unblocking records who lifted the block and the block it replaced', async () => {
    const blocker = await insertTestUser({ is_admin: true });
    const admin = await insertTestUser({ is_admin: true });
    const blockedAt = new Date().toISOString();
    const user = await insertTestUser({
      blocked_reason: 'abuse',
      blocked_at: blockedAt,
      blocked_by_kilo_user_id: blocker.id,
    });

    const caller = await createCallerForUser(admin.id);
    await caller.admin.users.updateBlockStatus({ userId: user.id, blocked_reason: null });

    const audits = await getAdminActionAudits(admin.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'user.unblock',
      target_type: 'user',
      target_id: user.id,
      metadata: {
        previousBlockedReason: 'abuse',
        previousBlockedByKiloUserId: blocker.id,
      },
    });
    expect(audits[0]?.metadata?.previousBlockedAt).toEqual(expect.any(String));
  });

  test('blocking and no-op unblocks do not write unblock audits', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser();

    const caller = await createCallerForUser(admin.id);
    await caller.admin.users.updateBlockStatus({ userId: user.id, blocked_reason: null });
    await caller.admin.users.updateBlockStatus({ userId: user.id, blocked_reason: 'abuse' });

    expect(await getAdminActionAudits(admin.id)).toHaveLength(0);
  });

  test('bulk unblock records one audit row per unblocked user', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const blockedAt = '2026-01-15T12:00:00.000Z';
    const users = await Promise.all(
      [0, 1].map(() =>
        insertTestUser({
          blocked_reason: 'bulk spam wave',
          blocked_at: blockedAt,
          blocked_by_kilo_user_id: admin.id,
        })
      )
    );

    const caller = await createCallerForUser(admin.id);
    const result = await caller.admin.bulkBlock.unblockRecentBlock({
      blocked_reason: 'bulk spam wave',
      date: '2026-01-15',
      blocked_by_kilo_user_id: admin.id,
    });
    expect(result).toEqual({ updatedCount: 2 });

    const audits = await getAdminActionAudits(admin.id);
    expect(audits.map(audit => audit.target_id).sort()).toEqual(users.map(u => u.id).sort());
    expect(audits.every(audit => audit.action === 'user.unblock')).toBe(true);
  });

  test('API key reset and session sign-out are recorded against the target user', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser();

    const caller = await createCallerForUser(admin.id);
    await caller.admin.users.resetAPIKey({ userId: user.id });
    await caller.admin.users.signOutBrowserSessions({ userId: user.id });

    const audits = await getAdminActionAudits(admin.id);
    expect(audits.map(audit => audit.action).sort()).toEqual([
      'user.api_key.reset',
      'user.browser_sessions.revoke',
    ]);
    expect(audits.every(audit => audit.target_id === user.id)).toBe(true);
  });
});

describe('admin.users.releaseEmailAddress', () => {
  test.each([false, true])(
    'releases a rowless duplicate with normalized email stored: %s and preserves the retained account',
    async hasNormalizedEmail => {
      const email = `Retained.${crypto.randomUUID()}@example.com`;
      const normalizedEmail = email.toLowerCase();
      const admin = await insertTestUser({ is_admin: true });
      const retained = await insertTestUser({
        id: crypto.randomUUID(),
        google_user_email: email,
        normalized_email: normalizedEmail,
        hosted_domain: hosted_domain_specials.email,
      });
      const duplicate = await insertTestUser({
        id: hasNormalizedEmail ? crypto.randomUUID() : 'rowless-email-account',
        google_user_email: email.toUpperCase(),
        normalized_email: hasNormalizedEmail ? normalizedEmail : null,
        email_domain: 'example.com',
        hosted_domain: hosted_domain_specials.email,
        api_token_pepper: 'unchanged-key',
      });

      await expect(getAllUserProviders(normalizedEmail)).resolves.toEqual({
        kind: 'ambiguous',
      });

      const caller = await createCallerForUser(admin.id);
      await expect(
        caller.admin.users.releaseEmailAddress({
          userId: duplicate.id,
          expectedEmail: duplicate.google_user_email,
        })
      ).resolves.toEqual({ success: true });

      const released = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, duplicate.id),
      });
      expect(released).toBeDefined();
      if (!released) throw new Error('Released user not found');
      expect(released).toEqual({
        ...duplicate,
        google_user_email: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@released\.invalid$/
        ),
        normalized_email: null,
        email_domain: 'released.invalid',
        updated_at: expect.any(String),
      });
      await expect(
        db.query.kilocode_users.findFirst({ where: eq(kilocode_users.id, retained.id) })
      ).resolves.toEqual(retained);
      await expect(getAllUserProviders(normalizedEmail)).resolves.toMatchObject({
        kind: 'found',
        user: { kiloUserId: retained.id },
      });
    }
  );

  test('refuses a duplicate with a linked provider without changing its email', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const duplicate = await insertTestUser({
      google_user_email: 'linked-duplicate@example.com',
      normalized_email: 'linked-duplicate@example.com',
    });
    await insertTestUser({ normalized_email: 'linked-duplicate@example.com' });
    await db.insert(user_auth_provider).values({
      kilo_user_id: duplicate.id,
      provider: 'google',
      provider_account_id: `google-${duplicate.id}`,
      email: duplicate.google_user_email,
      avatar_url: '',
      hosted_domain: null,
    });

    const caller = await createCallerForUser(admin.id);
    await expect(
      caller.admin.users.releaseEmailAddress({
        userId: duplicate.id,
        expectedEmail: duplicate.google_user_email,
      })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringMatching(/linked provider/),
    });

    await expect(
      db.query.kilocode_users.findFirst({ where: eq(kilocode_users.id, duplicate.id) })
    ).resolves.toMatchObject({ google_user_email: 'linked-duplicate@example.com' });
  });

  test('rejects a stale confirmation without changing the account', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const duplicate = await insertTestUser({
      google_user_email: 'stale-original@example.com',
      normalized_email: 'stale-original@example.com',
    });
    await insertTestUser({ normalized_email: 'stale-current@example.com' });
    await db
      .update(kilocode_users)
      .set({
        google_user_email: 'stale-current@example.com',
        normalized_email: 'stale-current@example.com',
      })
      .where(eq(kilocode_users.id, duplicate.id));

    const caller = await createCallerForUser(admin.id);
    await expect(
      caller.admin.users.releaseEmailAddress({
        userId: duplicate.id,
        expectedEmail: 'stale-original@example.com',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/changed/) });

    await expect(
      db.query.kilocode_users.findFirst({ where: eq(kilocode_users.id, duplicate.id) })
    ).resolves.toMatchObject({
      google_user_email: 'stale-current@example.com',
      normalized_email: 'stale-current@example.com',
    });
  });

  test('refuses an account with a non-email inferred login method', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const duplicate = await insertTestUser({
      google_user_email: 'inferred-google@example.com',
      normalized_email: 'inferred-google@example.com',
      hosted_domain: hosted_domain_specials.non_workspace_google_account,
    });
    await insertTestUser({ normalized_email: 'inferred-google@example.com' });

    const caller = await createCallerForUser(admin.id);
    await expect(
      caller.admin.users.releaseEmailAddress({
        userId: duplicate.id,
        expectedEmail: duplicate.google_user_email,
      })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringMatching(/inferred email/),
    });
  });

  test('requires a current cross-account email conflict', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const target = await insertTestUser({
      hosted_domain: hosted_domain_specials.email,
      normalized_email: 'no-conflict@example.com',
    });
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.users.releaseEmailAddress({
        userId: target.id,
        expectedEmail: target.google_user_email,
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/does not conflict/),
    });

    await expect(
      db.query.kilocode_users.findFirst({ where: eq(kilocode_users.id, target.id) })
    ).resolves.toMatchObject({ google_user_email: target.google_user_email });
  });

  test('serializes simultaneous releases for the same normalized email', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const first = await insertTestUser({
      id: crypto.randomUUID(),
      google_user_email: 'First.Candidate@gmail.com',
      normalized_email: 'firstcandidate@gmail.com',
      hosted_domain: hosted_domain_specials.email,
    });
    const second = await insertTestUser({
      id: crypto.randomUUID(),
      google_user_email: 'FIRSTCANDIDATE@gmail.com',
      normalized_email: 'firstcandidate@gmail.com',
      hosted_domain: hosted_domain_specials.email,
    });
    const caller = await createCallerForUser(admin.id);
    const results = await Promise.allSettled([
      caller.admin.users.releaseEmailAddress({
        userId: first.id,
        expectedEmail: first.google_user_email,
      }),
      caller.admin.users.releaseEmailAddress({
        userId: second.id,
        expectedEmail: second.google_user_email,
      }),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'BAD_REQUEST' });
    const candidates = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(eq(kilocode_users.normalized_email, 'firstcandidate@gmail.com'));
    expect(candidates).toHaveLength(1);
    expect([first.id, second.id]).toContain(candidates[0]?.id);
  });

  test('refuses self-targeting and missing users', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.users.releaseEmailAddress({
        userId: admin.id,
        expectedEmail: admin.google_user_email,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/own email/) });
    await expect(
      caller.admin.users.releaseEmailAddress({
        userId: 'missing-release-email-user',
        expectedEmail: 'missing@example.com',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'User not found' });
  });

  test.each([
    ['deleting', createDeletionInProgressBlockedReason(new Date())],
    ['deleted', createSoftDeletedBlockedReason(new Date())],
  ])('refuses a %s user', async (_state, blocked_reason) => {
    const admin = await insertTestUser({ is_admin: true });
    const target = await insertTestUser({
      google_user_email: `release-${crypto.randomUUID()}@example.com`,
      hosted_domain: hosted_domain_specials.email,
      blocked_reason,
    });
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.users.releaseEmailAddress({
        userId: target.id,
        expectedEmail: target.google_user_email,
      })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringMatching(/deleted or deleting/),
    });
  });

  test('refuses an already released email address', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const target = await insertTestUser({
      google_user_email: `${crypto.randomUUID()}@released.invalid`,
      normalized_email: null,
      email_domain: 'released.invalid',
      hosted_domain: hosted_domain_specials.email,
    });
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.users.releaseEmailAddress({
        userId: target.id,
        expectedEmail: target.google_user_email,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'Email address is already released' });
  });

  test('refuses an email address managed by organization SSO', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const organization = await createOrganization(
      `Release email SSO ${crypto.randomUUID()}`,
      admin.id
    );
    await db
      .update(organizations)
      .set({ sso_domain: 'sso-release.example.com' })
      .where(eq(organizations.id, organization.id));
    const target = await insertTestUser({
      google_user_email: 'member@sso-release.example.com',
      normalized_email: 'member@sso-release.example.com',
      hosted_domain: hosted_domain_specials.email,
    });
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.users.releaseEmailAddress({
        userId: target.id,
        expectedEmail: target.google_user_email,
      })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringMatching(/organization SSO/),
    });
  });

  test('requires admin access', async () => {
    const nonAdmin = await insertTestUser({ is_admin: false });
    const target = await insertTestUser();
    const caller = await createCallerForUser(nonAdmin.id);

    await expect(
      caller.admin.users.releaseEmailAddress({
        userId: target.id,
        expectedEmail: target.google_user_email,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Admin access required' });
  });
});

describe('admin.cancelAndRefundKiloPass', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function insertActiveKiloPass(kiloUserId: string, stripeSubscriptionId: string) {
    await db.insert(kilo_pass_subscriptions).values({
      kilo_user_id: kiloUserId,
      provider_subscription_id: stripeSubscriptionId,
      stripe_subscription_id: stripeSubscriptionId,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
      status: 'active',
      cancel_at_period_end: false,
      current_streak_months: 1,
      started_at: new Date().toISOString(),
      ended_at: null,
      next_yearly_issue_at: null,
    });
  }

  test('refuses a platform admin who is not a superadmin', async () => {
    const platformAdmin = await insertTestUser({ is_admin: true });
    const target = await insertTestUser();
    await insertActiveKiloPass(target.id, `sub_guard_${crypto.randomUUID()}`);

    const caller = await createCallerForUser(platformAdmin.id);
    await expect(
      caller.admin.users.cancelAndRefundKiloPass({ userId: target.id, reason: 'policy' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Superadmin access required' });

    const [subRow] = await db
      .select()
      .from(kilo_pass_subscriptions)
      .where(eq(kilo_pass_subscriptions.kilo_user_id, target.id));
    expect(subRow?.status).toBe('active');
    expect(await kiloPassAuditRows(target.id)).toEqual([]);
  });

  test('a superadmin cancels and refunds, and the refund is attributed', async () => {
    const superadmin = await insertTestUser({ is_admin: true, is_super_admin: true });
    const target = await insertTestUser();
    const subscriptionId = `sub_refund_${crypto.randomUUID()}`;
    await insertActiveKiloPass(target.id, subscriptionId);

    jest.spyOn(stripeClient.subscriptions, 'cancel').mockResolvedValue({} as never);
    jest.spyOn(stripeClient.invoices, 'list').mockResolvedValue({
      data: [{ id: 'in_admin_router' }],
    } as never);
    jest.spyOn(stripeClient.invoicePayments, 'list').mockResolvedValue({
      data: [{ payment: { payment_intent: 'pi_admin_router' } }],
    } as never);
    jest.spyOn(stripeClient.refunds, 'create').mockResolvedValue({ amount: 1900 } as never);

    const caller = await createCallerForUser(superadmin.id);
    const result = await caller.admin.users.cancelAndRefundKiloPass({
      userId: target.id,
      reason: 'chargeback reported by victim@example.com',
    });

    expect(result).toEqual({
      success: true,
      refundedAmountCents: 1900,
      balanceResetAmountUsd: null,
      alreadyBlocked: false,
    });

    const audits = await kiloPassAuditRows(target.id);
    expect(audits).toEqual([
      expect.objectContaining({
        actor_id: superadmin.id,
        target_type: 'user',
        target_id: target.id,
        message: 'Cancelled Kilo Pass and refunded the latest payment',
        metadata: expect.objectContaining({ reason: 'chargeback reported by [redacted-email]' }),
      }),
    ]);
    expect(JSON.stringify(audits[0]?.metadata)).not.toContain('example.com');

    // The block reason and the admin note hold the same text an admin can read,
    // so they carry the same replaced address.
    const blockState = await getBlockState(target.id);
    expect(blockState?.blocked_reason).toBe('chargeback reported by [redacted-email]');
    const notes = await db
      .select()
      .from(user_admin_notes)
      .where(eq(user_admin_notes.kilo_user_id, target.id));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.note_content).toContain('Reason: chargeback reported by [redacted-email]');
    expect(notes[0]?.note_content).not.toContain('victim@example.com');
  });

  test('a cancellation with no refundable payment is recorded as such', async () => {
    const superadmin = await insertTestUser({ is_admin: true, is_super_admin: true });
    const target = await insertTestUser();
    await insertActiveKiloPass(target.id, `sub_no_invoice_${crypto.randomUUID()}`);

    jest.spyOn(stripeClient.subscriptions, 'cancel').mockResolvedValue({} as never);
    jest.spyOn(stripeClient.invoices, 'list').mockResolvedValue({ data: [] } as never);

    const caller = await createCallerForUser(superadmin.id);
    const result = await caller.admin.users.cancelAndRefundKiloPass({
      userId: target.id,
      reason: 'policy',
    });
    expect(result).toEqual({
      success: true,
      refundedAmountCents: null,
      balanceResetAmountUsd: null,
      alreadyBlocked: false,
    });

    const audits = await kiloPassAuditRows(target.id);
    expect(audits).toEqual([
      expect.objectContaining({
        actor_id: superadmin.id,
        message: 'Cancelled Kilo Pass with no refundable payment',
      }),
    ]);
  });

  test('a refund that fails after the subscription was cancelled is still attributed', async () => {
    const superadmin = await insertTestUser({ is_admin: true, is_super_admin: true });
    const target = await insertTestUser();
    await insertActiveKiloPass(target.id, `sub_fail_${crypto.randomUUID()}`);

    jest.spyOn(stripeClient.subscriptions, 'cancel').mockResolvedValue({} as never);
    jest.spyOn(stripeClient.invoices, 'list').mockResolvedValue({
      data: [{ id: 'in_admin_router_fail' }],
    } as never);
    jest.spyOn(stripeClient.invoicePayments, 'list').mockResolvedValue({
      data: [{ payment: { payment_intent: 'pi_admin_router_fail' } }],
    } as never);
    jest.spyOn(stripeClient.refunds, 'create').mockRejectedValue(new Error('Stripe boom'));

    const caller = await createCallerForUser(superadmin.id);
    await expect(
      caller.admin.users.cancelAndRefundKiloPass({ userId: target.id, reason: 'chargeback' })
    ).rejects.toThrow('Stripe boom');

    const audits = await kiloPassAuditRows(target.id);
    expect(audits).toEqual([
      expect.objectContaining({
        actor_id: superadmin.id,
        target_id: target.id,
        message: 'Kilo Pass cancel attempted with unknown outcome',
      }),
    ]);
  });

  test('rejects a reason longer than the bounded length', async () => {
    const superadmin = await insertTestUser({ is_admin: true, is_super_admin: true });

    const caller = await createCallerForUser(superadmin.id);
    await expect(
      caller.admin.users.cancelAndRefundKiloPass({
        userId: 'length-bound-target',
        reason: 'x'.repeat(501),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(await kiloPassAuditRows('length-bound-target')).toEqual([]);
  });
});

describe('admin.syncProviders manual sync', () => {
  const originalVercelEnv = process.env.VERCEL_ENV;

  afterEach(() => {
    if (originalVercelEnv === undefined) {
      delete process.env.VERCEL_ENV;
    } else {
      process.env.VERCEL_ENV = originalVercelEnv;
    }
  });

  test('is disabled in production', async () => {
    process.env.VERCEL_ENV = 'production';
    const admin = await insertTestUser({ is_admin: true });
    const caller = await createCallerForUser(admin.id);

    await expect(caller.admin.syncProviders.getManualSyncEnabled()).resolves.toBe(false);
    await expect(caller.admin.syncProviders.triggerSync()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller.admin.syncProviders.triggerDirectByokSync()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller.admin.syncProviders.triggerMetadataCacheRefresh()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  test.each(['preview', 'development'])('is enabled when VERCEL_ENV is %s', async vercelEnv => {
    process.env.VERCEL_ENV = vercelEnv;
    const admin = await insertTestUser({ is_admin: true });
    const caller = await createCallerForUser(admin.id);

    await expect(caller.admin.syncProviders.getManualSyncEnabled()).resolves.toBe(true);
  });
});
