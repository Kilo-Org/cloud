/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@/lib/drizzle';
import {
  payment_methods,
  kilocode_users,
  user_affiliate_attributions,
  user_affiliate_events,
  user_auth_provider,
  credit_transactions,
  kilo_pass_store_events,
  kilo_pass_store_purchases,
  kilo_pass_subscriptions,
  kilo_pass_issuances,
  kilo_pass_issuance_items,
  kilo_pass_welcome_promo_payment_fingerprint_claims,
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
  cloud_agent_feedback,
  user_admin_notes,
  magic_link_tokens,
  stytch_fingerprints,
  kiloclaw_instances,
  kiloclaw_google_oauth_connections,
  kiloclaw_inbound_email_aliases,
  kiloclaw_inbound_email_reserved_aliases,
  kiloclaw_version_pins,
  kiloclaw_image_catalog,
  security_findings,
  security_analysis_queue,
  security_analysis_owner_state,
  kiloclaw_earlybird_purchases,
  kiloclaw_subscriptions,
  kiloclaw_email_log,
  transactional_email_log,
  kiloclaw_cli_runs,
  bot_requests,
  bot_request_cloud_agent_sessions,
  kiloclaw_admin_audit_logs,
  kiloclaw_scheduled_actions,
  kiloclaw_scheduled_action_stages,
  kiloclaw_scheduled_action_targets,
  user_push_tokens,
  security_advisor_scans,
  credit_campaigns,
  agent_environment_profiles,
  agent_environment_profile_mcp_servers,
  agent_environment_profile_skills,
  deleted_user_email_tombstones,
  impact_attribution_touches,
  impact_advocate_participants,
  impact_advocate_registration_attempts,
  impact_referrals,
  impact_referral_conversions,
  impact_referral_reward_decisions,
  impact_referral_rewards,
  impact_referral_reward_applications,
  impact_advocate_reward_redemptions,
  impact_conversion_reports,
  github_branch_pull_requests,
  user_github_app_tokens,
  model_eval_ingestions,
  microdollar_usage,
  model_experiment,
  model_experiment_variant,
  model_experiment_variant_version,
  model_experiment_request,
  stripe_early_fraud_warning_cases,
  stripe_early_fraud_warning_actions,
  coding_plan_availability_intents,
  coding_plan_key_inventory,
  coding_plan_subscriptions,
  byok_api_keys,
} from '@kilocode/db/schema';

import { eq, count, sql } from 'drizzle-orm';
import {
  softDeleteUser,
  SoftDeletePreconditionError,
  findUserById,
  findUsersByIds,
  createOrUpdateUser,
} from '@/lib/user';
import { hashNormalizedEmailForDeletionTombstone } from '@/lib/impact/referral';
import { createTestPaymentMethod } from '@/tests/helpers/payment-method.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { forceImmediateExpirationRecomputation } from '@/lib/balanceCache';
import { randomUUID } from 'crypto';
import {
  KiloPassCadence,
  KiloPassIssuanceItemKind,
  KiloPassIssuanceSource,
  KiloPassPaymentProvider,
  KiloPassTier,
  KiloPassWelcomePromoPaymentFingerprintType,
} from '@/lib/kilo-pass/enums';
import { SecurityAuditLogAction } from '@/lib/security-agent/core/enums';
import { recordAffiliateAttributionAndQueueParentEvent } from '@/lib/impact/affiliate-events';

jest.mock('@/lib/stripe-client', () => ({
  createStripeCustomer: jest.fn(async ({ metadata }: { metadata: { kiloUserId: string } }) => ({
    id: `cus_${metadata.kiloUserId}`,
  })),
  deleteStripeCustomer: jest.fn(async () => {}),
}));

jest.mock('@/lib/impact/affiliate-events', () => ({
  recordAffiliateAttributionAndQueueParentEvent: jest.fn(async () => null),
}));

const mockRecordAffiliateAttributionAndQueueParentEvent = jest.mocked(
  recordAffiliateAttributionAndQueueParentEvent
);

describe('User', () => {
  // Shared cleanup for all tests in this suite to prevent data pollution
  afterEach(async () => {
    await db.delete(user_auth_provider);
    await db.delete(user_affiliate_attributions);
    await db.delete(user_affiliate_events);
    await db.delete(impact_attribution_touches);
    await db.delete(impact_advocate_registration_attempts);
    await db.delete(impact_advocate_participants);
    await db.delete(impact_conversion_reports);
    await db.delete(impact_advocate_reward_redemptions);
    await db.delete(impact_referral_reward_applications);
    await db.delete(impact_referral_rewards);
    await db.delete(impact_referral_reward_decisions);
    await db.delete(impact_referral_conversions);
    await db.delete(impact_referrals);
    await db.delete(deleted_user_email_tombstones);
    await db.delete(stripe_early_fraud_warning_actions);
    await db.delete(stripe_early_fraud_warning_cases);
    await db.delete(payment_methods);
    await db.delete(kilo_pass_store_events);
    await db.delete(kilo_pass_store_purchases);
    await db.delete(kilo_pass_issuance_items);
    await db.delete(kilo_pass_issuances);
    await db.delete(kilo_pass_subscriptions);
    await db.delete(credit_transactions);
    await db.delete(enrichment_data);
    await db.delete(referral_code_usages);
    await db.delete(referral_codes);
    await db.delete(organization_audit_logs);
    await db.delete(security_audit_log);
    await db.delete(kiloclaw_admin_audit_logs);
    await db.delete(model_eval_ingestions);
    await db.delete(kiloclaw_scheduled_action_targets);
    await db.delete(kiloclaw_scheduled_action_stages);
    await db.delete(kiloclaw_scheduled_actions);
    await db.delete(credit_campaigns);
    await db.delete(kiloclaw_google_oauth_connections);
    await db.delete(kiloclaw_inbound_email_aliases);
    await db.delete(security_analysis_queue);
    await db.delete(security_findings);
    await db.delete(security_analysis_owner_state);
    await db.delete(organization_invitations);
    await db.delete(organization_user_usage);
    await db.delete(organization_user_limits);
    await db.delete(organization_memberships);
    await db.delete(free_model_usage);
    await db.delete(model_experiment_request);
    await db.delete(model_experiment_variant_version);
    await db.delete(model_experiment_variant);
    await db.delete(model_experiment);
    await db.delete(microdollar_usage);
    await db.delete(user_feedback);
    await db.delete(cloud_agent_feedback);
    await db.delete(user_admin_notes);
    await db.delete(magic_link_tokens);
    await db.delete(bot_request_cloud_agent_sessions);
    await db.delete(bot_requests);
    await db.delete(coding_plan_availability_intents);
    await db.delete(coding_plan_subscriptions);
    await db.delete(byok_api_keys);
    await db.delete(coding_plan_key_inventory);
    await db.delete(stytch_fingerprints);
    await db.delete(kiloclaw_cli_runs);
    await db.delete(kiloclaw_email_log);
    await db.delete(transactional_email_log);
    await db.delete(kiloclaw_version_pins);
    await db.delete(kiloclaw_image_catalog);
    await db.delete(kiloclaw_subscriptions);
    await db.delete(kiloclaw_earlybird_purchases);
    await db.delete(kiloclaw_instances);
    await db.delete(agent_environment_profile_skills);
    await db.delete(agent_environment_profile_mcp_servers);
    await db.delete(agent_environment_profiles);
    await db.delete(github_branch_pull_requests);
    await db.delete(user_github_app_tokens);
    await db.delete(organizations);
    await db.delete(kilocode_users);
  });

  describe('createOrUpdateUser', () => {
    beforeEach(() => {
      mockRecordAffiliateAttributionAndQueueParentEvent.mockResolvedValue(null);
    });

    it('stores the signup IP for new users', async () => {
      const headers = new Headers({ 'x-forwarded-for': '203.0.113.25, 10.0.0.1' });

      const result = await createOrUpdateUser(
        {
          google_user_email: 'signup-ip@example.com',
          google_user_name: 'Signup IP',
          google_user_image_url: 'https://example.com/avatar.png',
          hosted_domain: null,
          provider: 'google',
          provider_account_id: 'google-signup-ip',
        },
        undefined,
        false,
        headers
      );

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.user.signup_ip).toBe('203.0.113.25');
    });

    it('rejects new signups after the per-IP burst threshold (100/24h)', async () => {
      const signupIp = '203.0.113.50';
      for (let i = 1; i <= 100; i++) {
        await insertTestUser({ id: `ip-burst-${i}`, signup_ip: signupIp });
      }

      const result = await createOrUpdateUser(
        {
          google_user_email: 'limited@example.com',
          google_user_name: 'Limited User',
          google_user_image_url: 'https://example.com/avatar.png',
          hosted_domain: null,
          provider: 'google',
          provider_account_id: 'google-limited',
        },
        undefined,
        false,
        new Headers({ 'x-forwarded-for': signupIp })
      );

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBe('SIGNUP-RATE-LIMITED');
    });

    it('allows up to 99 signups in 24h from a single IP (burst below threshold)', async () => {
      const signupIp = '203.0.113.51';
      for (let i = 1; i <= 99; i++) {
        await insertTestUser({ id: `ip-burst-ok-${i}`, signup_ip: signupIp });
      }

      const result = await createOrUpdateUser(
        {
          google_user_email: 'burst-ok@example.com',
          google_user_name: 'Burst OK',
          google_user_image_url: 'https://example.com/avatar.png',
          hosted_domain: null,
          provider: 'google',
          provider_account_id: 'google-burst-ok',
        },
        undefined,
        false,
        new Headers({ 'x-forwarded-for': signupIp })
      );

      expect(result.success).toBe(true);
    });

    it('rejects new signups after the per-IP sustained threshold (150/30d)', async () => {
      const signupIp = '203.0.113.52';
      const now = Date.now();
      // 99 signups yesterday — under the 24h burst threshold.
      const yesterday = new Date(now - 2 * 60 * 60 * 1000).toISOString();
      for (let i = 1; i <= 99; i++) {
        await insertTestUser({
          id: `ip-sustained-recent-${i}`,
          signup_ip: signupIp,
          created_at: yesterday,
        });
      }
      // 51 more signups 10 days ago — outside the 24h window, inside 30d.
      const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
      for (let i = 1; i <= 51; i++) {
        await insertTestUser({
          id: `ip-sustained-old-${i}`,
          signup_ip: signupIp,
          created_at: tenDaysAgo,
        });
      }

      const result = await createOrUpdateUser(
        {
          google_user_email: 'sustained-limited@example.com',
          google_user_name: 'Sustained Limited',
          google_user_image_url: 'https://example.com/avatar.png',
          hosted_domain: null,
          provider: 'google',
          provider_account_id: 'google-sustained-limited',
        },
        undefined,
        false,
        new Headers({ 'x-forwarded-for': signupIp })
      );

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBe('SIGNUP-RATE-LIMITED');
    });

    it('ignores signups older than 30 days when evaluating the sustained limit', async () => {
      const signupIp = '203.0.113.53';
      const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
      for (let i = 1; i <= 200; i++) {
        await insertTestUser({
          id: `ip-sustained-expired-${i}`,
          signup_ip: signupIp,
          created_at: longAgo,
        });
      }

      const result = await createOrUpdateUser(
        {
          google_user_email: 'sustained-expired@example.com',
          google_user_name: 'Sustained Expired',
          google_user_image_url: 'https://example.com/avatar.png',
          hosted_domain: null,
          provider: 'google',
          provider_account_id: 'google-sustained-expired',
        },
        undefined,
        false,
        new Headers({ 'x-forwarded-for': signupIp })
      );

      expect(result.success).toBe(true);
    });

    it('rejects new signups whose normalized_email is already in use', async () => {
      await insertTestUser({
        id: 'existing-normalized',
        google_user_email: 'dedup.user@gmail.com',
        normalized_email: 'dedupuser@gmail.com',
      });

      // New signup with a different raw email but same normalized form
      // (Gmail dots + plus-alias both collapse to dedupuser@gmail.com).
      const result = await createOrUpdateUser(
        {
          google_user_email: 'dedup.user+alias@gmail.com',
          google_user_name: 'Dedup User',
          google_user_image_url: 'https://example.com/avatar.png',
          hosted_domain: null,
          provider: 'github',
          provider_account_id: 'github-dedup',
        },
        undefined,
        false
      );

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBe('EMAIL-ALREADY-USED');
    });

    it('keeps signup available when affiliate attribution persistence fails', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockRecordAffiliateAttributionAndQueueParentEvent.mockImplementationOnce(async args => {
        if (args.database) {
          await args.database.execute(sql`select * from missing_affiliate_attribution_test_table`);
        }
        throw new Error('affiliate attribution unavailable');
      });

      const result = await createOrUpdateUser(
        {
          google_user_email: 'affiliate-failure@example.com',
          google_user_name: 'Affiliate Failure',
          google_user_image_url: 'https://example.com/avatar.png',
          hosted_domain: null,
          provider: 'google',
          provider_account_id: 'google-affiliate-failure',
        },
        undefined,
        false,
        undefined,
        'impact-click-123'
      );

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.user.google_user_email).toBe('affiliate-failure@example.com');
      expect(mockRecordAffiliateAttributionAndQueueParentEvent).toHaveBeenCalledTimes(1);
      expect(
        mockRecordAffiliateAttributionAndQueueParentEvent.mock.calls[0]?.[0]
      ).not.toHaveProperty('database');
      expect(
        await db.query.kilocode_users.findFirst({
          where: eq(kilocode_users.id, result.user.id),
        })
      ).toBeDefined();
      expect(consoleError).toHaveBeenCalledWith(
        '[user] failed to persist affiliate attribution during signup',
        expect.objectContaining({
          userId: result.user.id,
          error: 'affiliate attribution unavailable',
        })
      );
      consoleError.mockRestore();
    });
  });

  describe('softDeleteUser', () => {
    it('should anonymize the user row and preserve it', async () => {
      const user = await insertTestUser({
        google_user_email: 'real-email@example.com',
        normalized_email: 'real-email@example.com',
        email_domain: 'example.com',
        google_user_name: 'Real Name',
        google_user_image_url: 'https://example.com/avatar.png',
        linkedin_url: 'https://linkedin.com/in/testuser',
        github_url: 'https://github.com/testuser',
        openrouter_upstream_safety_identifier: 'openrouter_upstream_safety_identifier',
        vercel_downstream_safety_identifier: 'vercel_downstream_safety_identifier',
        customer_source: 'A YouTube video',
        signup_ip: '203.0.113.10',
        api_token_pepper: 'api-token-pepper',
        web_session_pepper: 'web-session-pepper',
        blocked_at: '2026-01-15T12:00:00.000Z',
        blocked_by_kilo_user_id: 'admin-user-id',
        is_admin: true,
      });

      await softDeleteUser(user.id);

      const softDeleted = await findUserById(user.id);
      expect(softDeleted).toBeDefined();
      expect(softDeleted!.google_user_email).toBe(`deleted+${user.id}@deleted.invalid`);
      expect(softDeleted!.normalized_email).toBeNull();
      expect(softDeleted!.email_domain).toBeNull();
      expect(softDeleted!.google_user_name).toBe('Deleted User');
      expect(softDeleted!.google_user_image_url).toBe('');
      expect(softDeleted!.hosted_domain).toBeNull();
      expect(softDeleted!.linkedin_url).toBeNull();
      expect(softDeleted!.github_url).toBeNull();
      expect(softDeleted!.discord_server_membership_verified_at).toBeNull();
      expect(softDeleted!.openrouter_upstream_safety_identifier).toBe(
        'openrouter_upstream_safety_identifier'
      );
      expect(softDeleted!.vercel_downstream_safety_identifier).toBe(
        'vercel_downstream_safety_identifier'
      );
      expect(softDeleted!.customer_source).toBeNull();
      expect(softDeleted!.signup_ip).toBeNull();
      expect(softDeleted!.api_token_pepper).toEqual(expect.any(String));
      expect(softDeleted!.api_token_pepper).not.toBe('api-token-pepper');
      expect(softDeleted!.web_session_pepper).toEqual(expect.any(String));
      expect(softDeleted!.web_session_pepper).not.toBe('web-session-pepper');
      expect(softDeleted!.default_model).toBeNull();
      expect(softDeleted!.blocked_reason).toMatch(/^soft-deleted at \d{4}-\d{2}-\d{2}T/);
      expect(softDeleted!.blocked_at).toBeNull();
      expect(softDeleted!.blocked_by_kilo_user_id).toBeNull();
      expect(softDeleted!.auto_top_up_enabled).toBe(false);
      expect(softDeleted!.completed_welcome_form).toBe(false);
      expect(softDeleted!.is_admin).toBe(false);
      // Stripe customer ID should be preserved
      expect(softDeleted!.stripe_customer_id).toBe(user.stripe_customer_id);
    });

    it('should rotate and scrub App Store account-linked Kilo Pass data', async () => {
      const user = await insertTestUser({
        google_user_email: 'app-store-delete@example.com',
      });
      const otherUser = await insertTestUser({
        google_user_email: 'app-store-delete-other@example.com',
      });
      const originalAppStoreAccountToken = user.app_store_account_token;
      const providerSubscriptionId = 'orig-soft-delete';
      const providerTransactionId = 'tx-soft-delete';
      const [subscription] = await db
        .insert(kilo_pass_subscriptions)
        .values({
          kilo_user_id: user.id,
          payment_provider: KiloPassPaymentProvider.AppStore,
          provider_subscription_id: providerSubscriptionId,
          stripe_subscription_id: null,
          tier: KiloPassTier.Tier19,
          cadence: KiloPassCadence.Monthly,
          status: 'canceled',
          cancel_at_period_end: false,
          started_at: '2026-01-01T00:00:00.000Z',
          ended_at: '2026-02-01T00:00:00.000Z',
        })
        .returning({ id: kilo_pass_subscriptions.id });

      if (!subscription) {
        throw new Error('Failed to insert App Store subscription for soft delete test');
      }

      await db.insert(kilo_pass_store_purchases).values({
        kilo_pass_subscription_id: subscription.id,
        kilo_user_id: user.id,
        payment_provider: KiloPassPaymentProvider.AppStore,
        product_id: 'kilopass.tier19.monthly.v1',
        provider_subscription_id: providerSubscriptionId,
        provider_transaction_id: providerTransactionId,
        provider_original_transaction_id: providerSubscriptionId,
        app_account_token: originalAppStoreAccountToken,
        purchase_token: 'signed-transaction-jws',
        environment: 'Sandbox',
        purchased_at: '2026-01-01T00:00:00.000Z',
        expires_at: '2026-02-01T00:00:00.000Z',
        raw_payload_json: {
          appAccountToken: originalAppStoreAccountToken,
          purchaseToken: 'signed-transaction-jws',
          signedTransactionInfo: 'signed-transaction-info',
          transactionId: providerTransactionId,
          originalTransactionId: providerSubscriptionId,
          nested: {
            appAccountToken: originalAppStoreAccountToken,
            providerTransactionId,
          },
        },
      });

      await db.insert(kilo_pass_store_events).values([
        {
          payment_provider: KiloPassPaymentProvider.AppStore,
          event_id: 'event-soft-delete',
          provider_subscription_id: providerSubscriptionId,
          provider_transaction_id: providerTransactionId,
          app_account_token: originalAppStoreAccountToken,
          product_id: 'kilopass.tier19.monthly.v1',
          environment: 'Sandbox',
          payload_json: {
            notificationType: 'DID_RENEW',
            signedTransactionInfo: 'signed-transaction-info',
            transaction: {
              appAccountToken: originalAppStoreAccountToken,
              providerSubscriptionId,
              providerTransactionId,
            },
            rawTransaction: {
              appAccountToken: originalAppStoreAccountToken,
              transactionId: providerTransactionId,
            },
          },
        },
        {
          payment_provider: KiloPassPaymentProvider.AppStore,
          event_id: 'event-other-user',
          provider_subscription_id: 'orig-other-user',
          provider_transaction_id: 'tx-other-user',
          app_account_token: otherUser.app_store_account_token,
          product_id: 'kilopass.tier19.monthly.v1',
          environment: 'Sandbox',
          payload_json: {
            transaction: {
              appAccountToken: otherUser.app_store_account_token,
              providerTransactionId: 'tx-other-user',
            },
          },
        },
      ]);

      await softDeleteUser(user.id);

      const softDeleted = await findUserById(user.id);
      expect(softDeleted?.app_store_account_token).toEqual(expect.any(String));
      expect(softDeleted?.app_store_account_token).not.toBe(originalAppStoreAccountToken);

      const [purchase] = await db
        .select()
        .from(kilo_pass_store_purchases)
        .where(eq(kilo_pass_store_purchases.kilo_user_id, user.id));
      expect(purchase?.app_account_token).toBeNull();
      expect(purchase?.purchase_token).toBeNull();
      expect(purchase?.provider_subscription_id).toBe(providerSubscriptionId);
      expect(purchase?.provider_transaction_id).toBe(providerTransactionId);

      const rawPurchasePayload = purchase?.raw_payload_json as Record<string, unknown>;
      expect(rawPurchasePayload.appAccountToken).toBeNull();
      expect(rawPurchasePayload.purchaseToken).toBeNull();
      expect(rawPurchasePayload.signedTransactionInfo).toBeNull();
      expect(rawPurchasePayload.transactionId).toBe(providerTransactionId);
      expect((rawPurchasePayload.nested as Record<string, unknown>).appAccountToken).toBeNull();

      const [event] = await db
        .select()
        .from(kilo_pass_store_events)
        .where(eq(kilo_pass_store_events.event_id, 'event-soft-delete'));
      expect(event?.app_account_token).toBeNull();
      expect(event?.provider_subscription_id).toBe(providerSubscriptionId);
      expect(event?.provider_transaction_id).toBe(providerTransactionId);

      const eventPayload = event?.payload_json as Record<string, unknown>;
      expect(eventPayload.signedTransactionInfo).toBeNull();
      expect((eventPayload.transaction as Record<string, unknown>).appAccountToken).toBeNull();
      expect((eventPayload.rawTransaction as Record<string, unknown>).appAccountToken).toBeNull();
      expect((eventPayload.transaction as Record<string, unknown>).providerTransactionId).toBe(
        providerTransactionId
      );

      const [otherEvent] = await db
        .select()
        .from(kilo_pass_store_events)
        .where(eq(kilo_pass_store_events.event_id, 'event-other-user'));
      if (!otherEvent) {
        throw new Error('Expected other user store event');
      }
      expect(otherEvent?.app_account_token).toBe(otherUser.app_store_account_token);
      expect(
        (
          (otherEvent.payload_json as Record<string, unknown>).transaction as Record<
            string,
            unknown
          >
        ).appAccountToken
      ).toBe(otherUser.app_store_account_token);
    });

    it('should clear block attribution on other users', async () => {
      const admin = await insertTestUser({ is_admin: true });
      const blockedUser = await insertTestUser();

      await db
        .update(kilocode_users)
        .set({
          blocked_reason: 'manual block',
          blocked_at: '2026-01-15T12:00:00.000Z',
          blocked_by_kilo_user_id: admin.id,
        })
        .where(eq(kilocode_users.id, blockedUser.id));

      await softDeleteUser(admin.id);

      const blockedUserAfter = await findUserById(blockedUser.id);
      expect(blockedUserAfter!.blocked_reason).toBe('manual block');
      expect(new Date(blockedUserAfter!.blocked_at ?? '').toISOString()).toBe(
        '2026-01-15T12:00:00.000Z'
      );
      expect(blockedUserAfter!.blocked_by_kilo_user_id).toBeNull();
    });

    it('should tombstone normalized email hashes and delete referral program records', async () => {
      const referrer = await insertTestUser({
        id: 'referrer-user',
        google_user_email: 'referrer@example.com',
        normalized_email: 'referrer@example.com',
      });
      const user = await insertTestUser({
        id: 'referee-user',
        google_user_email: 'referee@example.com',
        normalized_email: 'referee@example.com',
      });
      const touchId = randomUUID();
      const participantId = randomUUID();
      const conversionId = randomUUID();
      const decisionId = randomUUID();
      const rewardId = randomUUID();

      await db.insert(impact_attribution_touches).values({
        id: touchId,
        dedupe_key: 'touch-dedupe',
        user_id: user.id,
        touch_type: 'referral',
        provider: 'impact_advocate',
        opaque_tracking_value: 'sq-cookie',
        tracking_value_length: 9,
        is_tracking_value_accepted: true,
        touched_at: '2026-04-23T00:00:00.000Z',
        expires_at: '2026-05-23T00:00:00.000Z',
      });
      await db.insert(impact_advocate_participants).values({
        id: participantId,
        user_id: user.id,
        advocate_id: user.id,
        advocate_account_id: user.id,
        contact_email: user.google_user_email,
        registration_state: 'pending',
      });
      await db.insert(impact_advocate_registration_attempts).values({
        participant_id: participantId,
        dedupe_key: 'registration-dedupe',
        opaque_cookie_value: 'sq-cookie',
        cookie_value_length: 9,
        delivery_state: 'queued',
      });
      await db.insert(impact_referrals).values({
        referee_user_id: user.id,
        referrer_user_id: referrer.id,
        source_touch_id: touchId,
      });
      await db.insert(impact_referral_conversions).values({
        id: conversionId,
        referee_user_id: user.id,
        referrer_user_id: referrer.id,
        source_touch_id: touchId,
        winning_touch_type: 'referral',
        source_payment_id: 'payment-123',
        qualified: true,
        converted_at: '2026-04-23T00:00:00.000Z',
      });
      await db.insert(impact_referral_reward_decisions).values({
        id: decisionId,
        conversion_id: conversionId,
        beneficiary_user_id: user.id,
        beneficiary_role: 'referee',
        outcome: 'granted',
        months_granted: 1,
      });
      await db.insert(impact_referral_rewards).values({
        id: rewardId,
        conversion_id: conversionId,
        decision_id: decisionId,
        beneficiary_user_id: user.id,
        beneficiary_role: 'referee',
        months_granted: 1,
        status: 'pending',
        earned_at: '2026-04-23T00:00:00.000Z',
      });
      await db.insert(impact_referral_reward_applications).values({
        reward_id: rewardId,
        beneficiary_user_id: user.id,
        previous_renewal_boundary: '2026-05-01T00:00:00.000Z',
        new_renewal_boundary: '2026-06-01T00:00:00.000Z',
        applied_at: '2026-04-23T00:00:00.000Z',
      });
      await db.insert(impact_advocate_reward_redemptions).values({
        reward_id: rewardId,
        dedupe_key: 'reward-redemption-dedupe',
        beneficiary_user_id: user.id,
        state: 'queued',
        request_payload: {
          lookup: {
            accountId: user.google_user_email,
            userId: user.google_user_email,
            rewardTypeFilter: 'CREDIT',
          },
          redemption: { amount: 1, unit: 'MONTH' },
        },
      });
      await db.insert(impact_conversion_reports).values({
        conversion_id: conversionId,
        dedupe_key: 'impact-report-dedupe',
        action_tracker_id: 71659,
        order_id: 'payment-123',
        state: 'queued',
      });

      await softDeleteUser(user.id);

      const [tombstone] = await db
        .select()
        .from(deleted_user_email_tombstones)
        .where(
          eq(
            deleted_user_email_tombstones.normalized_email_hash,
            hashNormalizedEmailForDeletionTombstone('referee@example.com')
          )
        );
      expect(tombstone).toBeDefined();

      const [touchCount] = await db
        .select({ count: count() })
        .from(impact_attribution_touches)
        .where(eq(impact_attribution_touches.user_id, user.id));
      expect(touchCount.count).toBe(0);

      const [participantCount] = await db
        .select({ count: count() })
        .from(impact_advocate_participants)
        .where(eq(impact_advocate_participants.user_id, user.id));
      expect(participantCount.count).toBe(0);

      const [redemptionCount] = await db
        .select({ count: count() })
        .from(impact_advocate_reward_redemptions)
        .where(eq(impact_advocate_reward_redemptions.beneficiary_user_id, user.id));
      expect(redemptionCount.count).toBe(0);

      const [conversionCount] = await db
        .select({ count: count() })
        .from(impact_referral_conversions)
        .where(eq(impact_referral_conversions.referee_user_id, user.id));
      expect(conversionCount.count).toBe(0);
    });

    it('falls back to google_user_email when normalized_email is null', async () => {
      // Pre-0090 users can have NULL normalized_email but a real google_user_email.
      // Soft-delete must still record a tombstone so a re-registration of the
      // same email cannot bypass the previously-deleted-referee guard.
      const legacyUser = await insertTestUser({
        google_user_email: 'legacy-no-normalized@example.com',
        normalized_email: null,
      });

      await softDeleteUser(legacyUser.id);

      const [tombstone] = await db
        .select()
        .from(deleted_user_email_tombstones)
        .where(
          eq(
            deleted_user_email_tombstones.normalized_email_hash,
            hashNormalizedEmailForDeletionTombstone('legacy-no-normalized@example.com')
          )
        );
      expect(tombstone).toBeDefined();
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

    it('should delete affiliate attributions for the user', async () => {
      const user1 = await insertTestUser();
      const user2 = await insertTestUser();

      await db.insert(user_affiliate_attributions).values([
        { user_id: user1.id, provider: 'impact', tracking_id: 'im_ref_user_1' },
        { user_id: user2.id, provider: 'impact', tracking_id: 'im_ref_user_2' },
      ]);

      await softDeleteUser(user1.id);

      expect(
        await db
          .select({ count: count() })
          .from(user_affiliate_attributions)
          .where(eq(user_affiliate_attributions.user_id, user1.id))
          .then(r => r[0].count)
      ).toBe(0);
      expect(
        await db
          .select({ count: count() })
          .from(user_affiliate_attributions)
          .where(eq(user_affiliate_attributions.user_id, user2.id))
          .then(r => r[0].count)
      ).toBe(1);
    });

    it('should delete affiliate events for the user', async () => {
      const user1 = await insertTestUser();
      const user2 = await insertTestUser();

      await db.insert(user_affiliate_events).values([
        {
          user_id: user1.id,
          provider: 'impact',
          event_type: 'signup',
          dedupe_key: `affiliate:impact:signup:${user1.id}`,
          delivery_state: 'queued',
          payload_json: {
            trackingId: 'impact-user-1',
            customerId: user1.id,
            customerEmailHash: 'hash-1',
            orderId: 'IR_AN_64_TS',
            eventDate: new Date().toISOString(),
          },
        },
        {
          user_id: user2.id,
          provider: 'impact',
          event_type: 'signup',
          dedupe_key: `affiliate:impact:signup:${user2.id}`,
          delivery_state: 'queued',
          payload_json: {
            trackingId: 'impact-user-2',
            customerId: user2.id,
            customerEmailHash: 'hash-2',
            orderId: 'IR_AN_64_TS',
            eventDate: new Date().toISOString(),
          },
        },
      ]);

      await softDeleteUser(user1.id);

      expect(
        await db
          .select({ count: count() })
          .from(user_affiliate_events)
          .where(eq(user_affiliate_events.user_id, user1.id))
          .then(r => r[0].count)
      ).toBe(0);
      expect(
        await db
          .select({ count: count() })
          .from(user_affiliate_events)
          .where(eq(user_affiliate_events.user_id, user2.id))
          .then(r => r[0].count)
      ).toBe(1);
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

    it('should anonymize kiloclaw admin audit logs where user is actor', async () => {
      const user = await insertTestUser();

      await db.insert(kiloclaw_admin_audit_logs).values({
        action: 'kiloclaw.volume.reassociate',
        actor_id: user.id,
        actor_email: user.google_user_email,
        actor_name: user.google_user_name,
        target_user_id: 'some-other-user',
        message: 'Volume reassociated',
      });

      await softDeleteUser(user.id);

      const logs = await db
        .select()
        .from(kiloclaw_admin_audit_logs)
        .where(eq(kiloclaw_admin_audit_logs.actor_id, user.id));
      expect(logs).toHaveLength(1);
      expect(logs[0].actor_email).toBeNull();
      expect(logs[0].actor_name).toBeNull();
      expect(logs[0].actor_id).toBe(user.id);
      expect(logs[0].target_user_id).toBe('some-other-user'); // not anonymized (different user)
    });

    it('should anonymize model eval ingest promoter email', async () => {
      const promoter = await insertTestUser();
      const otherPromoter = await insertTestUser();

      await db.insert(model_eval_ingestions).values([
        {
          bench_eval_name: 'soft-delete-promoter-eval',
          bench_eval_url: 'https://bench.example.com/jobs/soft-delete-promoter-eval',
          provider: 'kilo',
          model: 'kilo/openai/gpt-5.5',
          variant: null,
          task_source: 'terminal-bench',
          n_total_trials: 4,
          total_score: 1.5,
          overall_score: 0.375,
          n_errored: 0,
          promoted_at: new Date('2026-05-14T10:00:00.000Z').toISOString(),
          promoted_by_email: promoter.google_user_email,
          promotion_note: null,
        },
        {
          bench_eval_name: 'retained-promoter-eval',
          bench_eval_url: 'https://bench.example.com/jobs/retained-promoter-eval',
          provider: 'kilo',
          model: 'kilo/openai/gpt-5.5',
          variant: null,
          task_source: 'swebench-verified',
          n_total_trials: 4,
          total_score: 2,
          overall_score: 0.5,
          n_errored: 0,
          promoted_at: new Date('2026-05-14T11:00:00.000Z').toISOString(),
          promoted_by_email: otherPromoter.google_user_email,
          promotion_note: null,
        },
      ]);

      await softDeleteUser(promoter.id);

      const rows = await db
        .select({
          benchEvalName: model_eval_ingestions.bench_eval_name,
          promoterEmail: model_eval_ingestions.promoted_by_email,
        })
        .from(model_eval_ingestions);
      const anonymized = rows.find(row => row.benchEvalName === 'soft-delete-promoter-eval');
      const retained = rows.find(row => row.benchEvalName === 'retained-promoter-eval');

      expect(anonymized?.promoterEmail).toBe(`deleted+${promoter.id}@deleted.invalid`);
      expect(retained?.promoterEmail).toBe(otherPromoter.google_user_email);
    });

    it('should anonymize kiloclaw admin audit logs where user is target', async () => {
      const targetUser = await insertTestUser();
      const adminUser = await insertTestUser();

      await db.insert(kiloclaw_admin_audit_logs).values({
        action: 'kiloclaw.volume.reassociate',
        actor_id: adminUser.id,
        actor_email: adminUser.google_user_email,
        actor_name: adminUser.google_user_name,
        target_user_id: targetUser.id,
        message: 'Volume reassociated',
      });

      await softDeleteUser(targetUser.id);

      const logs = await db
        .select()
        .from(kiloclaw_admin_audit_logs)
        .where(eq(kiloclaw_admin_audit_logs.actor_id, adminUser.id));
      expect(logs).toHaveLength(1);
      expect(logs[0].target_user_id).toBe('deleted-user');
      expect(logs[0].actor_email).toBe(adminUser.google_user_email); // admin not anonymized
    });

    it('should retain kiloclaw_scheduled_action_targets after soft-delete (anonymized FK)', async () => {
      // Per the GDPR policy in softDeleteUser's doc-comment, scheduled
      // action targets are retained operational records. The user_id FK
      // continues to reference the (now anonymized) kilocode_users row.
      // No PII is stored directly on the target row.
      const user = await insertTestUser();
      const adminUser = await insertTestUser();

      const [instance] = await db
        .insert(kiloclaw_instances)
        .values({
          user_id: user.id,
          sandbox_id: `test-sdu-scheduled-${Date.now()}`,
        })
        .returning({ id: kiloclaw_instances.id });

      // Mark destroyed so softDeleteUser preconditions pass.
      await db
        .update(kiloclaw_instances)
        .set({ destroyed_at: new Date().toISOString() })
        .where(eq(kiloclaw_instances.id, instance.id));

      const [action] = await db
        .insert(kiloclaw_scheduled_actions)
        .values({
          action_type: 'scheduled_restart',
          status: 'completed',
          created_by: adminUser.id,
          total_count: 1,
          applied_count: 1,
          completed_at: new Date().toISOString(),
        })
        .returning({ id: kiloclaw_scheduled_actions.id });

      const [stage] = await db
        .insert(kiloclaw_scheduled_action_stages)
        .values({
          scheduled_action_id: action.id,
          stage_index: 0,
          scheduled_at: new Date().toISOString(),
          status: 'completed',
          applied_count: 1,
        })
        .returning({ id: kiloclaw_scheduled_action_stages.id });

      await db.insert(kiloclaw_scheduled_action_targets).values({
        scheduled_action_id: action.id,
        stage_id: stage.id,
        instance_id: instance.id,
        user_id: user.id,
        status: 'applied',
      });

      await expect(softDeleteUser(user.id)).resolves.toBeUndefined();

      // Target row still references the (now anonymized) user. The FK is
      // intentionally retained — no scrub on this table.
      const targets = await db
        .select()
        .from(kiloclaw_scheduled_action_targets)
        .where(eq(kiloclaw_scheduled_action_targets.user_id, user.id));
      expect(targets).toHaveLength(1);
      expect(targets[0].status).toBe('applied');
    });

    it('should clear admin_size_override on the deleted user\u2019s destroyed instances and on instances where the deleted user was the admin actor', async () => {
      // The kiloclaw_instances.admin_size_override JSONB carries the admin's
      // email and free-form reason text — both PII. Clear it on:
      //   (a) the deleted user's own destroyed instances (retained for audit)
      //   (b) ANY instance where the deleted user was the admin actor —
      //       their email/reason is their PII regardless of which user's
      //       instance it targeted.
      const targetUser = await insertTestUser();
      const adminUser = await insertTestUser();
      const otherCustomer = await insertTestUser();

      // (a) target user's own destroyed instance with an override set
      const [targetInstance] = await db
        .insert(kiloclaw_instances)
        .values({
          user_id: targetUser.id,
          sandbox_id: `test-sdu-override-target-${Date.now()}`,
          destroyed_at: new Date().toISOString(),
          admin_size_override: {
            size: { cpus: 4, memory_mb: 8192, cpu_kind: 'performance' },
            reason: 'OOM ticket #1234 mentioning sensitive context',
            actorId: adminUser.id,
            actorEmail: adminUser.google_user_email,
            setAt: 1700000000000,
          },
        })
        .returning({ id: kiloclaw_instances.id });

      // (b) someone else's active instance where adminUser was the actor
      const [otherInstance] = await db
        .insert(kiloclaw_instances)
        .values({
          user_id: otherCustomer.id,
          sandbox_id: `test-sdu-override-other-${Date.now()}`,
          admin_size_override: {
            size: { cpus: 4, memory_mb: 16384, cpu_kind: 'performance' },
            reason: 'support upgrade by adminUser',
            actorId: adminUser.id,
            actorEmail: adminUser.google_user_email,
            setAt: 1700000000000,
          },
        })
        .returning({ id: kiloclaw_instances.id });

      // Control: an unrelated instance with a different admin actor.
      const unrelatedAdmin = await insertTestUser();
      const [unrelatedInstance] = await db
        .insert(kiloclaw_instances)
        .values({
          user_id: otherCustomer.id,
          sandbox_id: `test-sdu-override-unrelated-${Date.now()}`,
          admin_size_override: {
            size: { cpus: 4, memory_mb: 8192, cpu_kind: 'performance' },
            reason: 'unrelated override',
            actorId: unrelatedAdmin.id,
            actorEmail: unrelatedAdmin.google_user_email,
            setAt: 1700000000001,
          },
        })
        .returning({ id: kiloclaw_instances.id });

      // Soft-delete the target user (case a) AND the admin user (case b).
      await softDeleteUser(targetUser.id);
      await softDeleteUser(adminUser.id);

      const [targetRow] = await db
        .select({ override: kiloclaw_instances.admin_size_override })
        .from(kiloclaw_instances)
        .where(eq(kiloclaw_instances.id, targetInstance.id));
      expect(targetRow?.override).toBeNull();

      const [otherRow] = await db
        .select({ override: kiloclaw_instances.admin_size_override })
        .from(kiloclaw_instances)
        .where(eq(kiloclaw_instances.id, otherInstance.id));
      expect(otherRow?.override).toBeNull();

      // Control row's override is untouched — different admin actor.
      const [unrelatedRow] = await db
        .select({ override: kiloclaw_instances.admin_size_override })
        .from(kiloclaw_instances)
        .where(eq(kiloclaw_instances.id, unrelatedInstance.id));
      expect(unrelatedRow).toBeDefined();
      expect(unrelatedRow.override).not.toBeNull();
      const unrelatedOverride = unrelatedRow.override as { actorId: string };
      expect(unrelatedOverride.actorId).toBe(unrelatedAdmin.id);
    });

    it('should anonymize credit_campaigns created_by_kilo_user_id', async () => {
      const creator = await insertTestUser();
      const otherAdmin = await insertTestUser();

      await db.insert(credit_campaigns).values([
        {
          slug: 'sdu-mine',
          credit_category: 'c-sdu-mine',
          amount_microdollars: 1_000_000,
          total_redemptions_allowed: 10,
          description: 'campaign created by soft-deleted user',
          created_by_kilo_user_id: creator.id,
        },
        {
          slug: 'sdu-other',
          credit_category: 'c-sdu-other',
          amount_microdollars: 1_000_000,
          total_redemptions_allowed: 10,
          description: 'campaign created by another admin',
          created_by_kilo_user_id: otherAdmin.id,
        },
      ]);

      await softDeleteUser(creator.id);

      const mine = await db
        .select()
        .from(credit_campaigns)
        .where(eq(credit_campaigns.slug, 'sdu-mine'));
      expect(mine[0].created_by_kilo_user_id).toBe('deleted-user');

      const other = await db
        .select()
        .from(credit_campaigns)
        .where(eq(credit_campaigns.slug, 'sdu-other'));
      expect(other[0].created_by_kilo_user_id).toBe(otherAdmin.id);
    });

    it('should delete security_analysis_owner_state rows for the user', async () => {
      const user1 = await insertTestUser();
      const user2 = await insertTestUser();

      await db.insert(security_analysis_owner_state).values([
        {
          owned_by_user_id: user1.id,
          auto_analysis_enabled_at: new Date().toISOString(),
        },
        {
          owned_by_user_id: user2.id,
          auto_analysis_enabled_at: new Date().toISOString(),
        },
      ]);

      await softDeleteUser(user1.id);

      expect(
        await db
          .select({ count: count() })
          .from(security_analysis_owner_state)
          .where(eq(security_analysis_owner_state.owned_by_user_id, user1.id))
          .then(r => r[0].count)
      ).toBe(0);
      expect(
        await db
          .select({ count: count() })
          .from(security_analysis_owner_state)
          .where(eq(security_analysis_owner_state.owned_by_user_id, user2.id))
          .then(r => r[0].count)
      ).toBe(1);
    });

    it('should remove security_analysis_queue rows via security_findings cascade', async () => {
      const user1 = await insertTestUser();
      const user2 = await insertTestUser();

      const [finding1] = await db
        .insert(security_findings)
        .values({
          owned_by_user_id: user1.id,
          repo_full_name: 'kilo-org/cloud-user-1',
          source: 'dependabot',
          source_id: `source-${randomUUID()}`,
          severity: 'high',
          package_name: 'zod',
          package_ecosystem: 'npm',
          title: 'User1 finding',
        })
        .returning();

      const [finding2] = await db
        .insert(security_findings)
        .values({
          owned_by_user_id: user2.id,
          repo_full_name: 'kilo-org/cloud-user-2',
          source: 'dependabot',
          source_id: `source-${randomUUID()}`,
          severity: 'medium',
          package_name: 'drizzle-orm',
          package_ecosystem: 'npm',
          title: 'User2 finding',
        })
        .returning();

      await db.insert(security_analysis_queue).values([
        {
          finding_id: finding1.id,
          owned_by_user_id: user1.id,
          queue_status: 'queued',
          severity_rank: 1,
          queued_at: new Date().toISOString(),
        },
        {
          finding_id: finding2.id,
          owned_by_user_id: user2.id,
          queue_status: 'queued',
          severity_rank: 2,
          queued_at: new Date().toISOString(),
        },
      ]);

      await softDeleteUser(user1.id);

      expect(
        await db
          .select({ count: count() })
          .from(security_findings)
          .where(eq(security_findings.owned_by_user_id, user1.id))
          .then(r => r[0].count)
      ).toBe(0);
      expect(
        await db
          .select({ count: count() })
          .from(security_analysis_queue)
          .where(eq(security_analysis_queue.finding_id, finding1.id))
          .then(r => r[0].count)
      ).toBe(0);

      expect(
        await db
          .select({ count: count() })
          .from(security_findings)
          .where(eq(security_findings.owned_by_user_id, user2.id))
          .then(r => r[0].count)
      ).toBe(1);
      expect(
        await db
          .select({ count: count() })
          .from(security_analysis_queue)
          .where(eq(security_analysis_queue.finding_id, finding2.id))
          .then(r => r[0].count)
      ).toBe(1);
    });

    it('should delete bot_requests and cascade child sessions for the user', async () => {
      const user1 = await insertTestUser();
      const user2 = await insertTestUser();

      const [br1] = await db
        .insert(bot_requests)
        .values({
          created_by: user1.id,
          platform: 'slack',
          platform_thread_id: 'slack:T123:C456:thread1',
          platform_message_id: 'slack:T123:C456:msg1',
          user_message: 'Hello from user1',
          status: 'completed',
        })
        .returning({ id: bot_requests.id });

      await db.insert(bot_requests).values({
        created_by: user2.id,
        platform: 'slack',
        platform_thread_id: 'slack:T123:C456:thread2',
        platform_message_id: 'slack:T123:C456:msg2',
        user_message: 'Hello from user2',
        status: 'completed',
      });

      await db.insert(bot_request_cloud_agent_sessions).values({
        bot_request_id: br1.id,
        cloud_agent_session_id: 'cas-gdpr-test-session',
        status: 'completed',
        final_message: 'PII-like final result should cascade with the bot request',
        final_message_fetched_at: new Date('2026-01-05T06:07:08.000Z').toISOString(),
        final_message_error: 'PII-like result fetch error should cascade with the bot request',
      });

      await softDeleteUser(user1.id);

      expect(
        await db
          .select({ count: count() })
          .from(bot_requests)
          .where(eq(bot_requests.created_by, user1.id))
          .then(r => r[0].count)
      ).toBe(0);
      expect(
        await db
          .select({ count: count() })
          .from(bot_request_cloud_agent_sessions)
          .where(eq(bot_request_cloud_agent_sessions.bot_request_id, br1.id))
          .then(r => r[0].count)
      ).toBe(0);
      expect(
        await db
          .select({ count: count() })
          .from(bot_requests)
          .where(eq(bot_requests.created_by, user2.id))
          .then(r => r[0].count)
      ).toBe(1);
    });

    it('should allow multiple child sessions per bot request', async () => {
      const user = await insertTestUser();

      const [br] = await db
        .insert(bot_requests)
        .values({
          created_by: user.id,
          platform: 'slack',
          platform_thread_id: 'slack:T123:C456:multi-child',
          platform_message_id: 'slack:T123:C456:multi-child:msg',
          user_message: 'multi-session test',
          status: 'pending',
        })
        .returning({ id: bot_requests.id });

      await db.insert(bot_request_cloud_agent_sessions).values([
        {
          bot_request_id: br.id,
          cloud_agent_session_id: 'cas-multi-1',
          status: 'running',
        },
        {
          bot_request_id: br.id,
          cloud_agent_session_id: 'cas-multi-2',
          status: 'completed',
        },
      ]);

      const rows = await db
        .select()
        .from(bot_request_cloud_agent_sessions)
        .where(eq(bot_request_cloud_agent_sessions.bot_request_id, br.id));

      expect(rows).toHaveLength(2);
      expect(rows.map(r => r.cloud_agent_session_id).sort()).toEqual([
        'cas-multi-1',
        'cas-multi-2',
      ]);
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

    it('should retain minimal Kilo Pass payment-fingerprint evidence for repeat-offer enforcement', async () => {
      const user = await insertTestUser();
      const stripeFingerprint = `fp_deleted_user_${randomUUID()}`;
      const sourceStripeInvoiceId = `in_deleted_user_${randomUUID()}`;
      await db.insert(kilo_pass_welcome_promo_payment_fingerprint_claims).values({
        stripe_payment_method_type: KiloPassWelcomePromoPaymentFingerprintType.Card,
        stripe_fingerprint: stripeFingerprint,
        source_stripe_invoice_id: sourceStripeInvoiceId,
      });

      await softDeleteUser(user.id);

      const claim = await db.query.kilo_pass_welcome_promo_payment_fingerprint_claims.findFirst({
        where: eq(
          kilo_pass_welcome_promo_payment_fingerprint_claims.stripe_fingerprint,
          stripeFingerprint
        ),
      });
      expect(claim?.stripe_fingerprint).toBe(stripeFingerprint);
      expect(claim?.source_stripe_invoice_id).toBe(sourceStripeInvoiceId);
    });

    it('should cascade-delete agent environment profile MCPs and skills', async () => {
      const user = await insertTestUser();

      const [profile] = await db
        .insert(agent_environment_profiles)
        .values({
          owned_by_user_id: user.id,
          name: 'test-profile',
        })
        .returning();

      const [mcpServer] = await db
        .insert(agent_environment_profile_mcp_servers)
        .values({
          profile_id: profile.id,
          name: 'demo',
          type: 'local',
          enabled: true,
          config: {
            command: ['node', 'server.js'],
            environment: {
              API_KEY: {
                encryptedData: 'ciphertext',
                encryptedDEK: 'key',
                algorithm: 'rsa-aes-256-gcm',
                version: 1,
              },
            },
          },
        })
        .returning();

      await db.insert(agent_environment_profile_skills).values({
        profile_id: profile.id,
        name: 'test-skill',
        source_type: 'custom',
        raw_markdown: '---\nname: test-skill\n---\nBody',
      });

      await softDeleteUser(user.id);

      const profiles = await db
        .select()
        .from(agent_environment_profiles)
        .where(eq(agent_environment_profiles.owned_by_user_id, user.id));
      expect(profiles).toHaveLength(0);

      const mcpServers = await db
        .select()
        .from(agent_environment_profile_mcp_servers)
        .where(eq(agent_environment_profile_mcp_servers.id, mcpServer.id));
      expect(mcpServers).toHaveLength(0);

      const skills = await db
        .select()
        .from(agent_environment_profile_skills)
        .where(eq(agent_environment_profile_skills.profile_id, profile.id));
      expect(skills).toHaveLength(0);
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

    it('should nullify cloud_agent_feedback FK', async () => {
      const user = await insertTestUser();
      await db.insert(cloud_agent_feedback).values({
        kilo_user_id: user.id,
        feedback_text: 'Cloud agent is great!',
      });

      await softDeleteUser(user.id);

      const feedback = await db.select().from(cloud_agent_feedback);
      expect(feedback).toHaveLength(1);
      expect(feedback[0].kilo_user_id).toBeNull();
      expect(feedback[0].feedback_text).toBe('Cloud agent is great!');
    });

    it('should nullify Stripe EFW case owner links while retaining enforcement audit history', async () => {
      const user = await insertTestUser();
      const unaffectedUser = await insertTestUser();
      const [fraudCase] = await db
        .insert(stripe_early_fraud_warning_cases)
        .values({
          stripe_early_fraud_warning_id: 'issfr_deleted_user',
          stripe_event_id: 'evt_deleted_user',
          stripe_charge_id: 'ch_deleted_user',
          stripe_payment_intent_id: 'pi_deleted_user',
          stripe_customer_id: user.stripe_customer_id,
          amount_minor_units: 1900,
          currency: 'usd',
          owner_classification: 'personal',
          kilo_user_id: user.id,
          status: 'completed',
          reason: 'automatic_personal_enforcement',
        })
        .returning({ id: stripe_early_fraud_warning_cases.id });
      const [unaffectedCase] = await db
        .insert(stripe_early_fraud_warning_cases)
        .values({
          stripe_early_fraud_warning_id: 'issfr_unaffected_user',
          stripe_event_id: 'evt_unaffected_user',
          stripe_charge_id: 'ch_unaffected_user',
          stripe_customer_id: unaffectedUser.stripe_customer_id,
          amount_minor_units: 4900,
          currency: 'usd',
          owner_classification: 'personal',
          kilo_user_id: unaffectedUser.id,
          status: 'completed',
        })
        .returning({ id: stripe_early_fraud_warning_cases.id });

      await db.insert(stripe_early_fraud_warning_actions).values({
        case_id: fraudCase.id,
        action_type: 'refund',
        target_key: 'charge:ch_deleted_user',
        status: 'completed',
        result_code: 'refunded',
        result_reference_id: 're_deleted_user',
      });

      await softDeleteUser(user.id);

      const retainedCase = await db
        .select()
        .from(stripe_early_fraud_warning_cases)
        .where(eq(stripe_early_fraud_warning_cases.id, fraudCase.id));
      expect(retainedCase).toHaveLength(1);
      expect(retainedCase[0].kilo_user_id).toBeNull();
      expect(retainedCase[0].stripe_early_fraud_warning_id).toBe('issfr_deleted_user');
      expect(retainedCase[0].stripe_charge_id).toBe('ch_deleted_user');

      const retainedActions = await db
        .select()
        .from(stripe_early_fraud_warning_actions)
        .where(eq(stripe_early_fraud_warning_actions.case_id, fraudCase.id));
      expect(retainedActions).toHaveLength(1);
      expect(retainedActions[0].result_reference_id).toBe('re_deleted_user');

      const unaffectedCaseRows = await db
        .select()
        .from(stripe_early_fraud_warning_cases)
        .where(eq(stripe_early_fraud_warning_cases.id, unaffectedCase.id));
      expect(unaffectedCaseRows[0].kilo_user_id).toBe(unaffectedUser.id);
    });

    it('should delete user_push_tokens', async () => {
      const user = await insertTestUser();
      await db.insert(user_push_tokens).values({
        user_id: user.id,
        token: 'ExponentPushToken[test-token-123]',
        platform: 'ios',
      });

      await softDeleteUser(user.id);

      const tokens = await db
        .select()
        .from(user_push_tokens)
        .where(eq(user_push_tokens.user_id, user.id));
      expect(tokens).toHaveLength(0);
    });

    it('should delete Coding Plan availability notification intents', async () => {
      const user = await insertTestUser();
      await db.insert(coding_plan_availability_intents).values({
        user_id: user.id,
        plan_id: 'minimax-token-plan-plus',
      });

      await softDeleteUser(user.id);

      const intents = await db
        .select()
        .from(coding_plan_availability_intents)
        .where(eq(coding_plan_availability_intents.user_id, user.id));
      expect(intents).toHaveLength(0);
    });

    it('should delete github_branch_pull_requests owned by user', async () => {
      const user = await insertTestUser();
      await db.insert(github_branch_pull_requests).values({
        git_url: 'https://github.com/acme/repo',
        git_branch: 'main',
        owned_by_user_id: user.id,
        owned_by_organization_id: null,
      });

      await softDeleteUser(user.id);

      const rows = await db
        .select()
        .from(github_branch_pull_requests)
        .where(eq(github_branch_pull_requests.owned_by_user_id, user.id));
      expect(rows).toHaveLength(0);
    });

    it('should delete stored GitHub user authorization credentials', async () => {
      const user = await insertTestUser();
      const otherUser = await insertTestUser();

      await db.insert(user_github_app_tokens).values([
        {
          kilo_user_id: user.id,
          github_app_type: 'standard',
          github_user_id: '101',
          github_login: 'deleted-user',
          access_token_encrypted: 'encrypted-access-deleted',
          access_token_expires_at: '2026-06-01T00:00:00.000Z',
          refresh_token_encrypted: 'encrypted-refresh-deleted',
          refresh_token_expires_at: '2026-11-01T00:00:00.000Z',
        },
        {
          kilo_user_id: otherUser.id,
          github_app_type: 'standard',
          github_user_id: '102',
          github_login: 'retained-user',
          access_token_encrypted: 'encrypted-access-retained',
          access_token_expires_at: '2026-06-01T00:00:00.000Z',
          refresh_token_encrypted: 'encrypted-refresh-retained',
          refresh_token_expires_at: '2026-11-01T00:00:00.000Z',
        },
      ]);

      await softDeleteUser(user.id);

      const deletedCredentials = await db
        .select()
        .from(user_github_app_tokens)
        .where(eq(user_github_app_tokens.kilo_user_id, user.id));
      const retainedCredentials = await db
        .select()
        .from(user_github_app_tokens)
        .where(eq(user_github_app_tokens.kilo_user_id, otherUser.id));

      expect(deletedCredentials).toHaveLength(0);
      expect(retainedCredentials).toHaveLength(1);
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

    it('should anonymize security_advisor_scans and null public_ip', async () => {
      const user = await insertTestUser();

      await db.insert(security_advisor_scans).values({
        kilo_user_id: user.id,
        source_platform: 'openclaw',
        source_method: 'plugin',
        public_ip: '203.0.113.42',
        findings_critical: 1,
        findings_warn: 0,
        findings_info: 0,
      });

      await softDeleteUser(user.id);

      const scans = await db.select().from(security_advisor_scans);
      expect(scans).toHaveLength(1);
      expect(scans[0].kilo_user_id).toBe('deleted');
      expect(scans[0].public_ip).toBeNull();
      // Analytics fields preserved
      expect(scans[0].source_platform).toBe('openclaw');
      expect(scans[0].findings_critical).toBe(1);
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

    it('should preserve model experiment attribution and prompt hashes', async () => {
      const user = await insertTestUser();
      const usageId = randomUUID();
      const createdAt = '2026-05-25T12:00:00.000Z';
      const requestBodySha256 = 'a'.repeat(64);

      await db.insert(microdollar_usage).values({
        id: usageId,
        kilo_user_id: user.id,
        cost: 0,
        input_tokens: 100,
        output_tokens: 50,
        cache_write_tokens: 0,
        cache_hit_tokens: 0,
        created_at: createdAt,
        provider: 'custom',
        model: 'partner/checkpoint-rc1',
        requested_model: 'kilo/preview-experiment-test',
        has_error: false,
      });

      const [experiment] = await db
        .insert(model_experiment)
        .values({
          public_model_id: 'kilo/preview-experiment-test',
          name: 'Soft-delete retention test',
          status: 'active',
          created_by_user_id: user.id,
        })
        .returning({ id: model_experiment.id });
      if (!experiment) throw new Error('Failed to insert model experiment');

      const [variant] = await db
        .insert(model_experiment_variant)
        .values({
          experiment_id: experiment.id,
          label: 'A',
          weight: 1,
        })
        .returning({ id: model_experiment_variant.id });
      if (!variant) throw new Error('Failed to insert model experiment variant');

      const [variantVersion] = await db
        .insert(model_experiment_variant_version)
        .values({
          variant_id: variant.id,
          upstream: {
            internal_id: 'partner/checkpoint-rc1',
            base_url: 'https://partner.example.com/v1',
          },
          encrypted_api_key: { iv: 'iv', data: 'data', authTag: 'authTag' },
          created_by: user.id,
        })
        .returning({ id: model_experiment_variant_version.id });
      if (!variantVersion) throw new Error('Failed to insert model experiment variant version');

      await db.insert(model_experiment_request).values({
        usage_id: usageId,
        variant_version_id: variantVersion.id,
        allocation_subject: 'user',
        client_request_id: 'client-message-id',
        request_kind: 'chat_completions',
        request_body_sha256: requestBodySha256,
        was_truncated: false,
        created_at: createdAt,
      });

      await softDeleteUser(user.id);

      const [usage] = await db
        .select()
        .from(microdollar_usage)
        .where(eq(microdollar_usage.id, usageId));
      expect(usage?.kilo_user_id).toBe(user.id);

      const [attribution] = await db
        .select()
        .from(model_experiment_request)
        .where(eq(model_experiment_request.usage_id, usageId));
      if (!attribution) throw new Error('Expected model experiment attribution to be retained');
      expect(attribution.request_body_sha256).toBe(requestBodySha256);
      expect(attribution.client_request_id).toBe('client-message-id');
      expect(new Date(attribution.created_at).toISOString()).toBe(createdAt);
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
      const stripeSubscriptionId = `sub_test_${randomUUID()}`;
      await db.insert(kilo_pass_subscriptions).values({
        id: subId,
        kilo_user_id: user.id,
        provider_subscription_id: stripeSubscriptionId,
        stripe_subscription_id: stripeSubscriptionId,
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
      const stripeSubscriptionId = `sub_test_${randomUUID()}`;
      await db.insert(kilo_pass_subscriptions).values({
        kilo_user_id: user.id,
        provider_subscription_id: stripeSubscriptionId,
        stripe_subscription_id: stripeSubscriptionId,
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
      const stripeSubscriptionId = `sub_test_${randomUUID()}`;
      await db.insert(kilo_pass_subscriptions).values({
        kilo_user_id: user.id,
        provider_subscription_id: stripeSubscriptionId,
        stripe_subscription_id: stripeSubscriptionId,
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

    it('should retain kiloclaw_version_pins for the user', async () => {
      const user = await insertTestUser();
      const adminUser = await insertTestUser({ is_admin: true });

      // Create a catalog entry for the FK
      const testTag = `test-gdpr-${Date.now()}`;
      await db.insert(kiloclaw_image_catalog).values({
        openclaw_version: '2026.1.1',
        variant: 'default',
        image_tag: testTag,
        status: 'available',
        published_at: new Date().toISOString(),
      });

      const [instance] = await db
        .insert(kiloclaw_instances)
        .values({
          user_id: user.id,
          sandbox_id: `test-gdpr-pin-${Date.now()}`,
        })
        .returning({ id: kiloclaw_instances.id });

      await db.insert(kiloclaw_version_pins).values({
        instance_id: instance.id,
        image_tag: testTag,
        pinned_by: adminUser.id,
        reason: 'test pin',
      });

      await db
        .update(kiloclaw_instances)
        .set({ destroyed_at: new Date().toISOString() })
        .where(eq(kiloclaw_instances.id, instance.id));

      await softDeleteUser(user.id);

      expect(
        await db
          .select({ count: count() })
          .from(kiloclaw_version_pins)
          .where(eq(kiloclaw_version_pins.instance_id, instance.id))
          .then(r => r[0].count)
      ).toBe(1);
    });

    it('should retain kiloclaw_earlybird_purchases for the user', async () => {
      const user = await insertTestUser();

      await db.insert(kiloclaw_earlybird_purchases).values({
        user_id: user.id,
        stripe_charge_id: `ch_test_gdpr_${Date.now()}`,
        amount_cents: 2500,
      });

      await softDeleteUser(user.id);

      expect(
        await db
          .select({ count: count() })
          .from(kiloclaw_earlybird_purchases)
          .where(eq(kiloclaw_earlybird_purchases.user_id, user.id))
          .then(r => r[0].count)
      ).toBe(1);
    });

    it('should delete kiloclaw_cli_runs for the user', async () => {
      const user = await insertTestUser();

      await db.insert(kiloclaw_cli_runs).values({
        user_id: user.id,
        prompt: 'fix the gateway',
        status: 'completed',
      });

      await softDeleteUser(user.id);

      expect(
        await db
          .select({ count: count() })
          .from(kiloclaw_cli_runs)
          .where(eq(kiloclaw_cli_runs.user_id, user.id))
          .then(r => r[0].count)
      ).toBe(0);
    });

    it('should clear kiloclaw_cli_runs initiated by the deleted admin', async () => {
      const admin = await insertTestUser({ is_admin: true });
      const user = await insertTestUser();

      const [run] = await db
        .insert(kiloclaw_cli_runs)
        .values({
          user_id: user.id,
          initiated_by_admin_id: admin.id,
          prompt: 'admin run',
          status: 'completed',
        })
        .returning({ id: kiloclaw_cli_runs.id });

      await softDeleteUser(admin.id);

      expect(
        await db
          .select({ initiated_by_admin_id: kiloclaw_cli_runs.initiated_by_admin_id })
          .from(kiloclaw_cli_runs)
          .where(eq(kiloclaw_cli_runs.id, run.id))
          .then(r => r[0].initiated_by_admin_id)
      ).toBeNull();
    });

    it('should retain kiloclaw_subscriptions for the user', async () => {
      const user = await insertTestUser();

      await db.insert(kiloclaw_subscriptions).values({
        user_id: user.id,
        plan: 'standard',
        status: 'canceled',
      });

      await softDeleteUser(user.id);

      expect(
        await db
          .select({ count: count() })
          .from(kiloclaw_subscriptions)
          .where(eq(kiloclaw_subscriptions.user_id, user.id))
          .then(r => r[0].count)
      ).toBe(1);
    });

    it('should retain instance-linked subscriptions and delete kiloclaw_cli_runs for the user', async () => {
      const user = await insertTestUser();

      const [instance] = await db
        .insert(kiloclaw_instances)
        .values({
          user_id: user.id,
          sandbox_id: `test-gdpr-fk-${Date.now()}`,
        })
        .returning({ id: kiloclaw_instances.id });

      await db.insert(kiloclaw_subscriptions).values({
        user_id: user.id,
        plan: 'standard',
        status: 'canceled',
        instance_id: instance.id,
      });

      await db.insert(kiloclaw_cli_runs).values({
        user_id: user.id,
        prompt: 'test fk ordering',
        status: 'completed',
        instance_id: instance.id,
      });

      await db
        .update(kiloclaw_instances)
        .set({ destroyed_at: new Date().toISOString() })
        .where(eq(kiloclaw_instances.id, instance.id));

      await softDeleteUser(user.id);

      expect(
        await db
          .select({ count: count() })
          .from(kiloclaw_instances)
          .where(eq(kiloclaw_instances.user_id, user.id))
          .then(r => r[0].count)
      ).toBe(1);
      expect(
        await db
          .select({ count: count() })
          .from(kiloclaw_subscriptions)
          .where(eq(kiloclaw_subscriptions.user_id, user.id))
          .then(r => r[0].count)
      ).toBe(1);
      expect(
        await db
          .select({ count: count() })
          .from(kiloclaw_cli_runs)
          .where(eq(kiloclaw_cli_runs.user_id, user.id))
          .then(r => r[0].count)
      ).toBe(0);
    });

    it('should delete kiloclaw_inbound_email_aliases for the user instances', async () => {
      const user = await insertTestUser();
      const otherUser = await insertTestUser();

      const [instance] = await db
        .insert(kiloclaw_instances)
        .values({
          user_id: user.id,
          sandbox_id: `test-gdpr-alias-${Date.now()}`,
        })
        .returning({ id: kiloclaw_instances.id });
      const [otherInstance] = await db
        .insert(kiloclaw_instances)
        .values({
          user_id: otherUser.id,
          sandbox_id: `test-gdpr-alias-other-${Date.now()}`,
        })
        .returning({ id: kiloclaw_instances.id });

      const alias = `soft-delete-${Date.now()}`;
      const otherAlias = `soft-delete-other-${Date.now()}`;
      await db
        .insert(kiloclaw_inbound_email_reserved_aliases)
        .values([{ alias }, { alias: otherAlias }]);
      await db.insert(kiloclaw_inbound_email_aliases).values([
        { alias, instance_id: instance.id },
        { alias: otherAlias, instance_id: otherInstance.id },
      ]);

      await db
        .update(kiloclaw_instances)
        .set({ destroyed_at: new Date().toISOString() })
        .where(eq(kiloclaw_instances.id, instance.id));

      await softDeleteUser(user.id);

      expect(
        await db
          .select({ count: count() })
          .from(kiloclaw_inbound_email_aliases)
          .where(eq(kiloclaw_inbound_email_aliases.instance_id, instance.id))
          .then(r => r[0].count)
      ).toBe(0);
      expect(
        await db
          .select({ count: count() })
          .from(kiloclaw_inbound_email_aliases)
          .where(eq(kiloclaw_inbound_email_aliases.instance_id, otherInstance.id))
          .then(r => r[0].count)
      ).toBe(1);
      expect(
        await db
          .select({ count: count() })
          .from(kiloclaw_inbound_email_reserved_aliases)
          .where(eq(kiloclaw_inbound_email_reserved_aliases.alias, alias))
          .then(r => r[0].count)
      ).toBe(1);
    });

    it('should delete kiloclaw_google_oauth_connections for the user instances', async () => {
      const user = await insertTestUser();
      const otherUser = await insertTestUser();

      const [instance] = await db
        .insert(kiloclaw_instances)
        .values({
          user_id: user.id,
          sandbox_id: `test-gdpr-oauth-${Date.now()}`,
        })
        .returning({ id: kiloclaw_instances.id });
      const [otherInstance] = await db
        .insert(kiloclaw_instances)
        .values({
          user_id: otherUser.id,
          sandbox_id: `test-gdpr-oauth-other-${Date.now()}`,
        })
        .returning({ id: kiloclaw_instances.id });

      await db.insert(kiloclaw_google_oauth_connections).values([
        {
          instance_id: instance.id,
          account_email: 'owner@example.com',
          account_subject: 'owner-subject',
          oauth_client_id: 'client-owner',
          refresh_token_encrypted: 'enc-owner',
          scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
          capabilities: ['calendar_read'],
          grants_by_source: { oauth: ['calendar_read'] },
        },
        {
          instance_id: otherInstance.id,
          account_email: 'other@example.com',
          account_subject: 'other-subject',
          oauth_client_id: 'client-other',
          refresh_token_encrypted: 'enc-other',
          scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
          capabilities: ['calendar_read'],
          grants_by_source: { oauth: ['calendar_read'] },
        },
      ]);

      await db
        .update(kiloclaw_instances)
        .set({ destroyed_at: new Date().toISOString() })
        .where(eq(kiloclaw_instances.id, instance.id));

      await softDeleteUser(user.id);

      expect(
        await db
          .select({ count: count() })
          .from(kiloclaw_google_oauth_connections)
          .where(eq(kiloclaw_google_oauth_connections.instance_id, instance.id))
          .then(r => r[0].count)
      ).toBe(0);
      expect(
        await db
          .select({ count: count() })
          .from(kiloclaw_google_oauth_connections)
          .where(eq(kiloclaw_google_oauth_connections.instance_id, otherInstance.id))
          .then(r => r[0].count)
      ).toBe(1);
    });

    it('should retain kiloclaw_email_log rows for the user', async () => {
      const user = await insertTestUser();

      await db.insert(kiloclaw_email_log).values({
        user_id: user.id,
        email_type: 'claw_trial_1d',
      });

      await softDeleteUser(user.id);

      expect(
        await db
          .select({ count: count() })
          .from(kiloclaw_email_log)
          .where(eq(kiloclaw_email_log.user_id, user.id))
          .then(r => r[0].count)
      ).toBe(1);
    });

    it('should retain transactional_email_log rows for the user', async () => {
      const user = await insertTestUser();
      const orgId = randomUUID();

      await db.insert(organizations).values({
        id: orgId,
        name: 'Transactional Email Retention Org',
        stripe_customer_id: `stripe-org-${orgId}`,
        plan: 'teams',
      });

      await db.insert(transactional_email_log).values({
        user_id: user.id,
        organization_id: orgId,
        email_type: 'organization_credits_top_up_confirmation',
        idempotency_key: `ch_retain_${randomUUID()}`,
      });

      await softDeleteUser(user.id);

      const retainedLogs = await db
        .select()
        .from(transactional_email_log)
        .where(eq(transactional_email_log.user_id, user.id));
      expect(retainedLogs).toHaveLength(1);
      expect(retainedLogs[0].organization_id).toBe(orgId);
    });

    it('should throw SoftDeletePreconditionError for active KiloClaw subscription', async () => {
      const user = await insertTestUser();
      await db.insert(kiloclaw_subscriptions).values({
        user_id: user.id,
        plan: 'standard',
        status: 'active',
        cancel_at_period_end: false,
      });

      await expect(softDeleteUser(user.id)).rejects.toThrow(SoftDeletePreconditionError);
      // User should not be modified
      const userAfter = await findUserById(user.id);
      expect(userAfter!.google_user_email).toBe(user.google_user_email);
    });

    it('should throw SoftDeletePreconditionError for KiloClaw subscription pending cancellation', async () => {
      const user = await insertTestUser();
      await db.insert(kiloclaw_subscriptions).values({
        user_id: user.id,
        plan: 'standard',
        status: 'active',
        cancel_at_period_end: true,
      });

      // Active subscriptions with cancel_at_period_end are still live in Stripe
      // until period end and can emit lifecycle webhooks, so deletion is blocked.
      await expect(softDeleteUser(user.id)).rejects.toThrow(SoftDeletePreconditionError);
      const userAfter = await findUserById(user.id);
      expect(userAfter!.google_user_email).toBe(user.google_user_email);
    });

    it('should throw SoftDeletePreconditionError for trialing KiloClaw subscription', async () => {
      const user = await insertTestUser();
      await db.insert(kiloclaw_subscriptions).values({
        user_id: user.id,
        plan: 'trial',
        status: 'trialing',
        trial_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
      });

      await expect(softDeleteUser(user.id)).rejects.toThrow(SoftDeletePreconditionError);
      const userAfter = await findUserById(user.id);
      expect(userAfter!.google_user_email).toBe(user.google_user_email);
    });

    it('should terminate managed Coding Plan access and anonymize inventory on soft delete', async () => {
      const { encryptApiKey } = await import('@/lib/ai-gateway/byok/encryption');
      const { BYOK_ENCRYPTION_KEY } = await import('@/lib/config.server');
      const user = await insertTestUser();
      const encrypted = encryptApiKey('test-key-for-gdpr', BYOK_ENCRYPTION_KEY);
      const [inventoryKey] = await db
        .insert(coding_plan_key_inventory)
        .values({
          plan_id: 'minimax-token-plan-plus',
          provider_id: 'minimax',
          upstream_plan_id: 'minimax-gdpr-plan',
          encrypted_api_key: encrypted,
          credential_fingerprint: `gdpr-${randomUUID()}`,
          status: 'assigned',
          assigned_to_user_id: user.id,
          assigned_at: new Date().toISOString(),
        })
        .returning();
      const [byokKey] = await db
        .insert(byok_api_keys)
        .values({
          kilo_user_id: user.id,
          provider_id: 'minimax',
          encrypted_api_key: encrypted,
          management_source: 'coding_plan',
          created_by: user.id,
        })
        .returning();

      await db.insert(coding_plan_subscriptions).values({
        user_id: user.id,
        plan_id: 'minimax-token-plan-plus',
        provider_id: 'minimax',
        key_inventory_id: inventoryKey.id,
        installed_byok_key_id: byokKey.id,
        status: 'active',
        cost_microdollars: 20_000_000,
        billing_period_days: 30,
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        credit_renewal_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      });

      await softDeleteUser(user.id);

      const [subscription] = await db
        .select()
        .from(coding_plan_subscriptions)
        .where(eq(coding_plan_subscriptions.user_id, user.id));
      expect(subscription.status).toBe('canceled');
      expect(subscription.cancellation_reason).toBe('account_deleted');
      expect(subscription.canceled_at).not.toBeNull();
      expect(subscription.installed_byok_key_id).toBeNull();

      const [retainedInventory] = await db
        .select()
        .from(coding_plan_key_inventory)
        .where(eq(coding_plan_key_inventory.id, inventoryKey.id));
      expect(retainedInventory.status).toBe('revocation_pending');
      expect(retainedInventory.upstream_plan_id).toBe('minimax-gdpr-plan');
      expect(retainedInventory.encrypted_api_key).toBeNull();
      expect(retainedInventory.assigned_to_user_id).toBeNull();
      expect(retainedInventory.revocation_requested_at).not.toBeNull();

      const byokKeys = await db
        .select()
        .from(byok_api_keys)
        .where(eq(byok_api_keys.kilo_user_id, user.id));
      expect(byokKeys).toHaveLength(0);
    });

    it('should throw SoftDeletePreconditionError for active KiloClaw instance even without live subscription', async () => {
      const user = await insertTestUser();

      await db.insert(kiloclaw_instances).values({
        user_id: user.id,
        sandbox_id: `test-active-instance-${Date.now()}`,
      });

      await expect(softDeleteUser(user.id)).rejects.toThrow(SoftDeletePreconditionError);
      const userAfter = await findUserById(user.id);
      expect(userAfter!.google_user_email).toBe(user.google_user_email);
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
