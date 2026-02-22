/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@/lib/drizzle';
import {
  payment_methods,
  kilocode_users,
  user_auth_provider,
  credit_transactions,
  kilo_pass_subscriptions,
  kilo_pass_issuances,
  kilo_pass_issuance_items,
  enrichment_data,
  referral_codes,
  referral_code_usages,
  organization_memberships,
  organization_user_limits,
  organization_user_usage,
  organization_audit_logs,
  organization_invitations,
  security_audit_log,
  free_model_usage,
  organizations,
  user_feedback,
  user_admin_notes,
  magic_link_tokens,
  stytch_fingerprints,
} from '@/db/schema';
import { eq, count } from 'drizzle-orm';
import { softDeleteUser, SoftDeletePreconditionError, findUserById, findUsersByIds } from './user';
import { createTestPaymentMethod } from '@/tests/helpers/payment-method.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { forceImmediateExpirationRecomputation } from '@/lib/balanceCache';
import { randomUUID } from 'crypto';
import {
  KiloPassCadence,
  KiloPassIssuanceItemKind,
  KiloPassIssuanceSource,
  KiloPassTier,
} from '@/lib/kilo-pass/enums';
import { SecurityAuditLogAction } from '@/lib/security-agent/core/enums';

describe('User', () => {
  // Shared cleanup for all tests in this suite to prevent data pollution
  afterEach(async () => {
    await db.delete(user_auth_provider);
    await db.delete(payment_methods);
    await db.delete(kilo_pass_issuance_items);
    await db.delete(kilo_pass_issuances);
    await db.delete(kilo_pass_subscriptions);
    await db.delete(credit_transactions);
    await db.delete(enrichment_data);
    await db.delete(referral_code_usages);
    await db.delete(referral_codes);
    await db.delete(organization_audit_logs);
    await db.delete(security_audit_log);
    await db.delete(organization_invitations);
    await db.delete(organization_user_usage);
    await db.delete(organization_user_limits);
    await db.delete(organization_memberships);
    await db.delete(free_model_usage);
    await db.delete(user_feedback);
    await db.delete(user_admin_notes);
    await db.delete(magic_link_tokens);
    await db.delete(stytch_fingerprints);
    await db.delete(organizations);
    await db.delete(kilocode_users);
  });

  describe('softDeleteUser', () => {
    it('should anonymize the user row and preserve it', async () => {
      const user = await insertTestUser({
        google_user_email: 'real-email@example.com',
        google_user_name: 'Real Name',
        google_user_image_url: 'https://example.com/avatar.png',
        linkedin_url: 'https://linkedin.com/in/testuser',
        github_url: 'https://github.com/testuser',
        is_admin: true,
      });

      await softDeleteUser(user.id);

      const softDeleted = await findUserById(user.id);
      expect(softDeleted).toBeDefined();
      expect(softDeleted!.google_user_email).toBe(`deleted+${user.id}@deleted.invalid`);
      expect(softDeleted!.google_user_name).toBe('Deleted User');
      expect(softDeleted!.google_user_image_url).toBe('');
      expect(softDeleted!.hosted_domain).toBeNull();
      expect(softDeleted!.linkedin_url).toBeNull();
      expect(softDeleted!.github_url).toBeNull();
      expect(softDeleted!.api_token_pepper).toBeNull();
      expect(softDeleted!.default_model).toBeNull();
      expect(softDeleted!.blocked_reason).toMatch(/^soft-deleted at \d{4}-\d{2}-\d{2}T/);
      expect(softDeleted!.auto_top_up_enabled).toBe(false);
      expect(softDeleted!.completed_welcome_form).toBe(false);
      expect(softDeleted!.is_admin).toBe(false);
      // Stripe customer ID should be preserved
      expect(softDeleted!.stripe_customer_id).toBe(user.stripe_customer_id);
    });

    it('should delete auth providers', async () => {
      const user = await insertTestUser();
      await db.insert(user_auth_provider).values({
        kilo_user_id: user.id,
        provider: 'google',
        provider_account_id: `google-${user.id}`,
        email: user.google_user_email,
        avatar_url: user.google_user_image_url,
      });

      await softDeleteUser(user.id);

      const providers = await db
        .select()
        .from(user_auth_provider)
        .where(eq(user_auth_provider.kilo_user_id, user.id));
      expect(providers).toHaveLength(0);
    });

    it('should delete enrichment_data for the user', async () => {
      const user1 = await insertTestUser();
      const user2 = await insertTestUser();

      await db.insert(enrichment_data).values([
        { user_id: user1.id, github_enrichment_data: { login: 'testuser1' } },
        { user_id: user2.id, github_enrichment_data: { login: 'testuser2' } },
      ]);

      await softDeleteUser(user1.id);

      expect(
        await db
          .select({ count: count() })
          .from(enrichment_data)
          .where(eq(enrichment_data.user_id, user1.id))
          .then(r => r[0].count)
      ).toBe(0);
      expect(
        await db
          .select({ count: count() })
          .from(enrichment_data)
          .where(eq(enrichment_data.user_id, user2.id))
          .then(r => r[0].count)
      ).toBe(1);
    });

    it('should delete admin notes about the user', async () => {
      const user = await insertTestUser();
      await db.insert(user_admin_notes).values({
        kilo_user_id: user.id,
        note_content: 'Some admin note',
      });

      await softDeleteUser(user.id);

      expect(
        await db
          .select({ count: count() })
          .from(user_admin_notes)
          .where(eq(user_admin_notes.kilo_user_id, user.id))
          .then(r => r[0].count)
      ).toBe(0);
    });

    it('should delete referral codes but keep referral_code_usages', async () => {
      const user1 = await insertTestUser();
      const user2 = await insertTestUser();

      await db.insert(referral_codes).values([
        { kilo_user_id: user1.id, code: 'USER1CODE' },
        { kilo_user_id: user2.id, code: 'USER2CODE' },
      ]);

      await db.insert(referral_code_usages).values({
        referring_kilo_user_id: user1.id,
        redeeming_kilo_user_id: user2.id,
        code: 'USER1CODE',
      });

      await softDeleteUser(user1.id);

      // User1's referral code should be deleted
      expect(
        await db
          .select({ count: count() })
          .from(referral_codes)
          .where(eq(referral_codes.kilo_user_id, user1.id))
          .then(r => r[0].count)
      ).toBe(0);

      // Referral usage should be preserved (references the now-anonymized user)
      expect((await db.select({ count: count() }).from(referral_code_usages))[0].count).toBe(1);

      // User2's referral code should remain
      expect(
        await db
          .select({ count: count() })
          .from(referral_codes)
          .where(eq(referral_codes.kilo_user_id, user2.id))
          .then(r => r[0].count)
      ).toBe(1);
    });

    it('should delete organization memberships and usage data', async () => {
      const user1 = await insertTestUser();
      const user2 = await insertTestUser();

      const orgId = randomUUID();
      await db.insert(organizations).values({
        id: orgId,
        name: 'Test Org',
        stripe_customer_id: `stripe-org-${orgId}`,
        created_by_kilo_user_id: user1.id,
        plan: 'enterprise',
      });

      await db.insert(organization_memberships).values([
        {
          organization_id: orgId,
          kilo_user_id: user1.id,
          role: 'owner',
          joined_at: new Date().toISOString(),
        },
        {
          organization_id: orgId,
          kilo_user_id: user2.id,
          role: 'member',
          joined_at: new Date().toISOString(),
        },
      ]);

      await db.insert(organization_user_limits).values({
        organization_id: orgId,
        kilo_user_id: user1.id,
        limit_type: 'daily',
        microdollar_limit: 10_000_000,
      });

      await db.insert(organization_user_usage).values({
        organization_id: orgId,
        kilo_user_id: user1.id,
        usage_date: '2025-01-15',
        limit_type: 'daily',
        microdollar_usage: 5_000_000,
      });

      await softDeleteUser(user1.id);

      // User1's membership and usage data should be gone
      expect(
        await db
          .select({ count: count() })
          .from(organization_memberships)
          .where(eq(organization_memberships.kilo_user_id, user1.id))
          .then(r => r[0].count)
      ).toBe(0);
      expect((await db.select({ count: count() }).from(organization_user_limits))[0].count).toBe(0);
      expect((await db.select({ count: count() }).from(organization_user_usage))[0].count).toBe(0);

      // User2's membership should remain
      expect(
        await db
          .select({ count: count() })
          .from(organization_memberships)
          .where(eq(organization_memberships.kilo_user_id, user2.id))
          .then(r => r[0].count)
      ).toBe(1);

      // User1 row should still exist (soft-deleted)
      expect(await findUserById(user1.id)).toBeDefined();
    });

    it('should delete organization invitations sent by and addressed to the user', async () => {
      const user1 = await insertTestUser({ google_user_email: 'invitee@example.com' });
      const user2 = await insertTestUser();

      const orgId = randomUUID();
      await db.insert(organizations).values({
        id: orgId,
        name: 'Test Org',
        stripe_customer_id: `stripe-org-${orgId}`,
        plan: 'teams',
      });

      const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();

      // Invitation sent BY user1
      await db.insert(organization_invitations).values({
        organization_id: orgId,
        email: 'someone@example.com',
        role: 'member',
        invited_by: user1.id,
        token: 'token-from-user1',
        expires_at: futureDate,
      });

      // Invitation sent TO user1's email (user1 is the invitee)
      await db.insert(organization_invitations).values({
        organization_id: orgId,
        email: 'invitee@example.com',
        role: 'member',
        invited_by: user2.id,
        token: 'token-to-user1',
        expires_at: futureDate,
      });

      // Invitation for user2 (should not be affected)
      await db.insert(organization_invitations).values({
        organization_id: orgId,
        email: user2.google_user_email,
        role: 'member',
        invited_by: user2.id,
        token: 'token-for-user2',
        expires_at: futureDate,
      });

      expect((await db.select({ count: count() }).from(organization_invitations))[0].count).toBe(3);

      await softDeleteUser(user1.id);

      // Both invitations involving user1 should be deleted
      const remaining = await db.select().from(organization_invitations);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].email).toBe(user2.google_user_email);
    });

    it('should anonymize organization audit logs', async () => {
      const user = await insertTestUser();
      const orgId = randomUUID();
      await db.insert(organizations).values({
        id: orgId,
        name: 'Test Org',
        stripe_customer_id: `stripe-org-${orgId}`,
        plan: 'teams',
      });

      await db.insert(organization_audit_logs).values({
        organization_id: orgId,
        action: 'organization.user.accept_invite',
        actor_id: user.id,
        actor_email: user.google_user_email,
        actor_name: user.google_user_name,
        message: 'User joined org',
      });

      await softDeleteUser(user.id);

      const logs = await db
        .select()
        .from(organization_audit_logs)
        .where(eq(organization_audit_logs.actor_id, user.id));
      expect(logs).toHaveLength(1);
      expect(logs[0].actor_email).toBeNull();
      expect(logs[0].actor_name).toBeNull();
      expect(logs[0].actor_id).toBe(user.id); // actor_id preserved for reference
      expect(logs[0].message).toBe('User joined org'); // message preserved
    });

    it('should anonymize security audit logs where user is actor', async () => {
      const user = await insertTestUser();
      const orgId = randomUUID();
      await db.insert(organizations).values({
        id: orgId,
        name: 'Test Org',
        stripe_customer_id: `stripe-org-${orgId}`,
        plan: 'teams',
      });

      await db.insert(security_audit_log).values({
        owned_by_organization_id: orgId,
        actor_id: user.id,
        actor_email: user.google_user_email,
        actor_name: user.google_user_name,
        action: SecurityAuditLogAction.FindingDismissed,
        resource_type: 'security_finding',
        resource_id: randomUUID(),
      });

      await softDeleteUser(user.id);

      const logs = await db
        .select()
        .from(security_audit_log)
        .where(eq(security_audit_log.actor_id, user.id));
      expect(logs).toHaveLength(1);
      expect(logs[0].actor_email).toBeNull();
      expect(logs[0].actor_name).toBeNull();
      expect(logs[0].actor_id).toBe(user.id); // actor_id preserved
      expect(logs[0].action).toBe(SecurityAuditLogAction.FindingDismissed); // action preserved
    });

    it('should soft-delete and anonymize payment methods', async () => {
      const user = await insertTestUser();
      const pm = createTestPaymentMethod(user.id);
      await db.insert(payment_methods).values({ ...pm, name: 'John Doe', address_city: 'NYC' });

      await softDeleteUser(user.id);

      const pms = await db
        .select()
        .from(payment_methods)
        .where(eq(payment_methods.user_id, user.id));
      expect(pms).toHaveLength(1);
      expect(pms[0].deleted_at).not.toBeNull();
      expect(pms[0].name).toBeNull();
      expect(pms[0].address_city).toBeNull();
      // stripe_fingerprint preserved for fraud detection
      expect(pms[0].stripe_fingerprint).toBe(pm.stripe_fingerprint);
    });

    it('should nullify user_feedback FK', async () => {
      const user = await insertTestUser();
      await db.insert(user_feedback).values({
        kilo_user_id: user.id,
        feedback_text: 'Great product!',
      });

      await softDeleteUser(user.id);

      const feedback = await db.select().from(user_feedback);
      expect(feedback).toHaveLength(1);
      expect(feedback[0].kilo_user_id).toBeNull();
      expect(feedback[0].feedback_text).toBe('Great product!');
    });

    it('should nullify free_model_usage FK', async () => {
      const user = await insertTestUser();

      await db.insert(free_model_usage).values([
        { ip_address: '1.2.3.4', model: 'test-model', kilo_user_id: user.id },
        { ip_address: '1.2.3.4', model: 'test-model', kilo_user_id: null },
      ]);

      await softDeleteUser(user.id);

      // User's free model usage should have kilo_user_id nulled, anonymous record untouched
      const usages = await db.select().from(free_model_usage);
      expect(usages).toHaveLength(2);
      expect(usages.every(u => u.kilo_user_id === null)).toBe(true);
    });

    it('should preserve credit transactions', async () => {
      const user = await insertTestUser();
      await db.insert(credit_transactions).values({
        kilo_user_id: user.id,
        amount_microdollars: 5_000_000,
        is_free: false,
        description: 'Test credits',
      });

      await softDeleteUser(user.id);

      expect(
        await db
          .select({ count: count() })
          .from(credit_transactions)
          .where(eq(credit_transactions.kilo_user_id, user.id))
          .then(r => r[0].count)
      ).toBe(1);
    });

    it('should preserve Kilo Pass subscriptions and issuance chain', async () => {
      const user = await insertTestUser();

      const creditTxId = randomUUID();
      await db.insert(credit_transactions).values({
        id: creditTxId,
        kilo_user_id: user.id,
        amount_microdollars: 19_000_000,
        is_free: false,
        description: 'Kilo Pass base credits',
        credit_category: 'kilo_pass_base',
      });

      const subId = randomUUID();
      await db.insert(kilo_pass_subscriptions).values({
        id: subId,
        kilo_user_id: user.id,
        stripe_subscription_id: `sub_test_${randomUUID()}`,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'canceled',
      });

      const issuanceId = randomUUID();
      await db.insert(kilo_pass_issuances).values({
        id: issuanceId,
        kilo_pass_subscription_id: subId,
        issue_month: '2025-01-01',
        source: KiloPassIssuanceSource.StripeInvoice,
        stripe_invoice_id: `inv_test_${randomUUID()}`,
      });

      await db.insert(kilo_pass_issuance_items).values({
        kilo_pass_issuance_id: issuanceId,
        kind: KiloPassIssuanceItemKind.Base,
        credit_transaction_id: creditTxId,
        amount_usd: 19,
      });

      await softDeleteUser(user.id);

      // All Kilo Pass records should be preserved
      expect((await db.select({ count: count() }).from(kilo_pass_subscriptions))[0].count).toBe(1);
      expect((await db.select({ count: count() }).from(kilo_pass_issuances))[0].count).toBe(1);
      expect((await db.select({ count: count() }).from(kilo_pass_issuance_items))[0].count).toBe(1);
      expect((await db.select({ count: count() }).from(credit_transactions))[0].count).toBe(1);
    });

    it('should preserve stytch_fingerprints for abuse detection', async () => {
      const user = await insertTestUser();
      await db.insert(stytch_fingerprints).values({
        kilo_user_id: user.id,
        visitor_fingerprint: 'vf_test',
        browser_fingerprint: 'bf_test',
        hardware_fingerprint: 'hf_test',
        network_fingerprint: 'nf_test',
        verdict_action: 'ALLOW',
        detected_device_type: 'DESKTOP',
        is_authentic_device: true,
        status_code: 200,
        fingerprint_data: {},
      });

      await softDeleteUser(user.id);

      expect(
        await db
          .select({ count: count() })
          .from(stytch_fingerprints)
          .where(eq(stytch_fingerprints.kilo_user_id, user.id))
          .then(r => r[0].count)
      ).toBe(1);
    });

    it('should throw SoftDeletePreconditionError for active subscription', async () => {
      const user = await insertTestUser();
      await db.insert(kilo_pass_subscriptions).values({
        kilo_user_id: user.id,
        stripe_subscription_id: `sub_test_${randomUUID()}`,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        cancel_at_period_end: false,
      });

      await expect(softDeleteUser(user.id)).rejects.toThrow(SoftDeletePreconditionError);
      // User should not be modified
      const userAfter = await findUserById(user.id);
      expect(userAfter!.google_user_email).toBe(user.google_user_email);
    });

    it('should allow soft-delete when subscription is pending cancellation', async () => {
      const user = await insertTestUser();
      await db.insert(kilo_pass_subscriptions).values({
        kilo_user_id: user.id,
        stripe_subscription_id: `sub_test_${randomUUID()}`,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        cancel_at_period_end: true, // Pending cancellation
      });

      await expect(softDeleteUser(user.id)).resolves.not.toThrow();

      const softDeleted = await findUserById(user.id);
      expect(softDeleted!.blocked_reason).toMatch(/^soft-deleted at \d{4}-\d{2}-\d{2}T/);
    });

    it('should handle soft-delete of non-existent user gracefully', async () => {
      const user = await insertTestUser();

      await expect(softDeleteUser('non-existent-user')).resolves.not.toThrow();

      // Existing user should be unchanged
      expect(await findUserById(user.id)).toBeDefined();
    });

    it('should not affect other users', async () => {
      const user1 = await insertTestUser();
      const user2 = await insertTestUser();

      const pm2 = createTestPaymentMethod(user2.id);
      await db.insert(payment_methods).values(pm2);

      await softDeleteUser(user1.id);

      // User2 should be completely untouched
      const user2After = await findUserById(user2.id);
      expect(user2After).toBeDefined();
      expect(user2After!.google_user_email).toBe(user2.google_user_email);

      const user2Pms = await db
        .select()
        .from(payment_methods)
        .where(eq(payment_methods.user_id, user2.id));
      expect(user2Pms).toHaveLength(1);
      expect(user2Pms[0].deleted_at).toBeNull();
    });

    it('should delete magic_link_tokens by original email', async () => {
      const user = await insertTestUser({ google_user_email: 'magic@example.com' });

      const futureDate = new Date(Date.now() + 1000 * 60 * 60).toISOString();
      await db.insert(magic_link_tokens).values({
        token_hash: 'test-token-hash',
        email: 'magic@example.com',
        expires_at: futureDate,
      });

      await softDeleteUser(user.id);

      expect((await db.select({ count: count() }).from(magic_link_tokens))[0].count).toBe(0);
    });
  });

  describe('forceImmediateExpirationRecomputation', () => {
    afterEach(async () => {
      await db.delete(kilocode_users);
    });

    it('should set next_credit_expiration_at to now for existing user', async () => {
      const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
      const user = await insertTestUser({
        next_credit_expiration_at: futureDate,
      });

      const userBefore = await findUserById(user.id);
      expect(userBefore).toBeDefined();
      expect(new Date(userBefore!.next_credit_expiration_at!).toISOString()).toBe(futureDate);

      await forceImmediateExpirationRecomputation(user.id);

      const userAfter = await findUserById(user.id);
      expect(userAfter).toBeDefined();
      expect(new Date(userAfter!.next_credit_expiration_at!).toISOString()).not.toBe(futureDate);
      expect(userAfter!.next_credit_expiration_at).not.toBeNull();
      // Should be roughly now
      const diff = Math.abs(new Date(userAfter!.next_credit_expiration_at!).getTime() - Date.now());
      expect(diff).toBeLessThan(5000); // within 5 seconds
      expect(userAfter!.updated_at).not.toBe(userBefore!.updated_at);
    });

    it('should handle non-existent user gracefully', async () => {
      await expect(
        forceImmediateExpirationRecomputation('non-existent-user')
      ).resolves.not.toThrow();
    });

    it('should work when next_credit_expiration_at is already null', async () => {
      const user = await insertTestUser({
        next_credit_expiration_at: null,
      });

      const userBefore = await findUserById(user.id);
      expect(userBefore).toBeDefined();
      expect(userBefore!.next_credit_expiration_at).toBeNull();

      await forceImmediateExpirationRecomputation(user.id);

      const userAfter = await findUserById(user.id);
      expect(userAfter).toBeDefined();
      expect(userAfter!.next_credit_expiration_at).not.toBeNull();
      expect(userAfter!.updated_at).not.toBe(userBefore!.updated_at);
    });

    it('should only affect the specified user', async () => {
      const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
      const user1 = await insertTestUser({
        next_credit_expiration_at: futureDate,
      });
      const user2 = await insertTestUser({
        next_credit_expiration_at: futureDate,
      });

      const user1Before = await findUserById(user1.id);
      const user2Before = await findUserById(user2.id);
      expect(new Date(user1Before!.next_credit_expiration_at!).toISOString()).toBe(futureDate);
      expect(new Date(user2Before!.next_credit_expiration_at!).toISOString()).toBe(futureDate);

      await forceImmediateExpirationRecomputation(user1.id);

      const user1After = await findUserById(user1.id);
      const user2After = await findUserById(user2.id);

      expect(new Date(user1After!.next_credit_expiration_at!).toISOString()).not.toBe(futureDate);
      expect(new Date(user2After!.next_credit_expiration_at!).toISOString()).toBe(futureDate);
    });
  });

  describe('findUsersByIds', () => {
    test('should return empty Map for empty input', async () => {
      const result = await findUsersByIds([]);
      expect(result.size).toBe(0);
      expect(result).toEqual(new Map());
    });

    test('should return single user for single ID', async () => {
      const testUser = await insertTestUser({
        google_user_name: 'Single User',
        google_user_email: 'single@example.com',
      });

      const result = await findUsersByIds([testUser.id]);

      expect(result.size).toBe(1);
      const user = result.get(testUser.id);
      expect(user?.id).toBe(testUser.id);
      expect(user?.google_user_name).toBe('Single User');
      expect(user?.google_user_email).toBe('single@example.com');
    });

    test('should return multiple users for multiple IDs', async () => {
      const user1 = await insertTestUser({
        google_user_name: 'User One',
        google_user_email: 'user1@example.com',
      });

      const user2 = await insertTestUser({
        google_user_name: 'User Two',
        google_user_email: 'user2@example.com',
      });

      const user3 = await insertTestUser({
        google_user_name: 'User Three',
        google_user_email: 'user3@example.com',
      });

      const result = await findUsersByIds([user1.id, user2.id, user3.id]);

      expect(result.size).toBe(3);

      const resultIds = Array.from(result.keys()).sort();
      const expectedIds = [user1.id, user2.id, user3.id].sort();
      expect(resultIds).toEqual(expectedIds);

      // Verify each user is returned correctly
      expect(result.get(user1.id)?.google_user_name).toBe('User One');
      expect(result.get(user2.id)?.google_user_name).toBe('User Two');
      expect(result.get(user3.id)?.google_user_name).toBe('User Three');
    });

    test('should handle mix of existing and non-existent IDs', async () => {
      const existingUser = await insertTestUser({
        google_user_name: 'Existing User',
        google_user_email: 'existing@example.com',
      });

      const result = await findUsersByIds([
        existingUser.id,
        'non-existent-id-1',
        'non-existent-id-2',
      ]);

      expect(result.size).toBe(1);
      const user = result.get(existingUser.id);
      expect(user?.id).toBe(existingUser.id);
      expect(user?.google_user_name).toBe('Existing User');
    });

    test('should handle duplicate IDs', async () => {
      const testUser = await insertTestUser({
        google_user_name: 'Duplicate Test User',
        google_user_email: 'duplicate@example.com',
      });

      const result = await findUsersByIds([testUser.id, testUser.id, testUser.id]);

      expect(result.size).toBe(1);
      const user = result.get(testUser.id);
      expect(user?.id).toBe(testUser.id);
      expect(user?.google_user_name).toBe('Duplicate Test User');
    });

    test('should return empty Map for all non-existent IDs', async () => {
      const result = await findUsersByIds(['non-existent-1', 'non-existent-2', 'non-existent-3']);

      expect(result.size).toBe(0);
      expect(result).toEqual(new Map());
    });
  });
});
