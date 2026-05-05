import { insertKiloClawSubscriptionChangeLog } from '@kilocode/db';
import type { KiloClawPaymentSource, KiloClawSubscriptionStatus } from '@kilocode/db/schema-types';
import {
  credit_transactions,
  impact_advocate_participants,
  impact_advocate_registration_attempts,
  impact_conversion_reports,
  kiloclaw_attribution_touches,
  kiloclaw_instances,
  kiloclaw_referral_conversions,
  kiloclaw_referral_reward_applications,
  kiloclaw_referral_reward_decisions,
  kiloclaw_referral_rewards,
  kiloclaw_referrals,
  kiloclaw_subscription_change_log,
  kiloclaw_subscriptions,
  kilocode_users,
  referral_codes,
} from '@kilocode/db/schema';
import { and, eq, inArray, like, or } from 'drizzle-orm';

import { getSeedDb } from './db';

type SeedUserFixture = {
  id: string;
  email: string;
  name: string;
  imageUrl?: string;
  stripeCustomerId?: string;
  normalizedEmail?: string;
  isAdmin?: boolean;
};

type PersonalSubscriptionFixture = {
  userId: string;
  sandboxId: string;
  name?: string | null;
  organizationId?: string | null;
  plan: 'trial' | 'standard' | 'commit';
  status: KiloClawSubscriptionStatus;
  paymentSource?: KiloClawPaymentSource;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
  creditRenewalAt?: string | null;
  trialStartedAt?: string | null;
  trialEndsAt?: string | null;
  commitEndsAt?: string | null;
  cancelAtPeriodEnd?: boolean;
};

function buildOrConditions<TCondition>(conditions: Array<TCondition | undefined>): TCondition[] {
  return conditions.filter(condition => condition !== undefined);
}

export function seedLabelForScenario(scenario: string): string {
  return `seed:kiloclaw:${scenario}`;
}

export function seedUserId(scenario: string, role: string): string {
  return `seed-kiloclaw-${scenario}-${role}`;
}

export function seedEmail(scenario: string, role: string): string {
  return `${seedUserId(scenario, role)}@example.com`;
}

export function seedOpaqueReferralIdentifier(scenario: string, slug: string): string {
  return `${seedLabelForScenario(scenario)}:share:${slug}`;
}

export function seedSourcePaymentId(scenario: string, slug: string): string {
  return `kiloclaw-subscription:seed-kiloclaw-${scenario}-${slug}`;
}

export function seedOrderId(scenario: string, slug: string): string {
  return `${seedLabelForScenario(scenario)}:order:${slug}`;
}

export function addDays(iso: string, days: number): string {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

export function addMonthsUtc(iso: string, months: number): string {
  const date = new Date(iso);
  const originalDay = date.getUTCDate();

  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);

  const lastDayOfTargetMonth = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)
  ).getUTCDate();

  date.setUTCDate(Math.min(originalDay, lastDayOfTargetMonth));
  return date.toISOString();
}

export async function cleanupKiloClawReferralSeedScenario(params: {
  scenario: string;
  userIds: string[];
}): Promise<void> {
  const db = getSeedDb();
  const scenarioPrefix = `${seedLabelForScenario(params.scenario)}%`;

  const conversionRows = await db
    .select({ id: kiloclaw_referral_conversions.id })
    .from(kiloclaw_referral_conversions)
    .where(
      or(
        like(kiloclaw_referral_conversions.source_payment_id, scenarioPrefix),
        inArray(kiloclaw_referral_conversions.referee_user_id, params.userIds),
        inArray(kiloclaw_referral_conversions.referrer_user_id, params.userIds)
      )
    );
  const conversionIds = conversionRows.map(row => row.id);

  const rewardRows = conversionIds.length
    ? await db
        .select({ id: kiloclaw_referral_rewards.id })
        .from(kiloclaw_referral_rewards)
        .where(
          or(
            inArray(kiloclaw_referral_rewards.conversion_id, conversionIds),
            inArray(kiloclaw_referral_rewards.beneficiary_user_id, params.userIds)
          )
        )
    : await db
        .select({ id: kiloclaw_referral_rewards.id })
        .from(kiloclaw_referral_rewards)
        .where(inArray(kiloclaw_referral_rewards.beneficiary_user_id, params.userIds));
  const rewardIds = rewardRows.map(row => row.id);

  const participantRows = await db
    .select({ id: impact_advocate_participants.id })
    .from(impact_advocate_participants)
    .where(inArray(impact_advocate_participants.user_id, params.userIds));
  const participantIds = participantRows.map(row => row.id);

  const subscriptionRows = await db
    .select({ id: kiloclaw_subscriptions.id })
    .from(kiloclaw_subscriptions)
    .where(inArray(kiloclaw_subscriptions.user_id, params.userIds));
  const subscriptionIds = subscriptionRows.map(row => row.id);

  const rewardApplicationConditions = buildOrConditions([
    rewardIds.length
      ? inArray(kiloclaw_referral_reward_applications.reward_id, rewardIds)
      : undefined,
    params.userIds.length
      ? inArray(kiloclaw_referral_reward_applications.beneficiary_user_id, params.userIds)
      : undefined,
  ]);
  if (rewardApplicationConditions.length > 0) {
    await db
      .delete(kiloclaw_referral_reward_applications)
      .where(or(...rewardApplicationConditions));
  }

  const reportConditions = buildOrConditions([
    conversionIds.length
      ? inArray(impact_conversion_reports.conversion_id, conversionIds)
      : undefined,
    like(impact_conversion_reports.dedupe_key, scenarioPrefix),
  ]);
  await db.delete(impact_conversion_reports).where(or(...reportConditions));

  const rewardConditions = buildOrConditions([
    rewardIds.length ? inArray(kiloclaw_referral_rewards.id, rewardIds) : undefined,
    params.userIds.length
      ? inArray(kiloclaw_referral_rewards.beneficiary_user_id, params.userIds)
      : undefined,
  ]);
  if (rewardConditions.length > 0) {
    await db.delete(kiloclaw_referral_rewards).where(or(...rewardConditions));
  }

  if (conversionIds.length > 0) {
    await db
      .delete(kiloclaw_referral_reward_decisions)
      .where(inArray(kiloclaw_referral_reward_decisions.conversion_id, conversionIds));
  }

  await db
    .delete(kiloclaw_referrals)
    .where(
      or(
        inArray(kiloclaw_referrals.referee_user_id, params.userIds),
        inArray(kiloclaw_referrals.referrer_user_id, params.userIds)
      )
    );

  const conversionConditions = buildOrConditions([
    like(kiloclaw_referral_conversions.source_payment_id, scenarioPrefix),
    inArray(kiloclaw_referral_conversions.referee_user_id, params.userIds),
    inArray(kiloclaw_referral_conversions.referrer_user_id, params.userIds),
  ]);
  await db.delete(kiloclaw_referral_conversions).where(or(...conversionConditions));

  const attemptConditions = buildOrConditions([
    like(impact_advocate_registration_attempts.dedupe_key, scenarioPrefix),
    participantIds.length
      ? inArray(impact_advocate_registration_attempts.participant_id, participantIds)
      : undefined,
  ]);
  await db.delete(impact_advocate_registration_attempts).where(or(...attemptConditions));

  await db
    .delete(kiloclaw_attribution_touches)
    .where(
      or(
        like(kiloclaw_attribution_touches.dedupe_key, scenarioPrefix),
        inArray(kiloclaw_attribution_touches.user_id, params.userIds)
      )
    );

  await db
    .delete(credit_transactions)
    .where(
      or(
        inArray(credit_transactions.kilo_user_id, params.userIds),
        like(credit_transactions.credit_category, scenarioPrefix),
        like(
          credit_transactions.credit_category,
          `kiloclaw-subscription:seed-kiloclaw-${params.scenario}%`
        )
      )
    );

  if (subscriptionIds.length > 0) {
    await db
      .delete(kiloclaw_subscription_change_log)
      .where(inArray(kiloclaw_subscription_change_log.subscription_id, subscriptionIds));
  }

  await db
    .delete(kiloclaw_subscriptions)
    .where(inArray(kiloclaw_subscriptions.user_id, params.userIds));
  await db.delete(kiloclaw_instances).where(inArray(kiloclaw_instances.user_id, params.userIds));
  await db
    .delete(impact_advocate_participants)
    .where(inArray(impact_advocate_participants.user_id, params.userIds));
  await db.delete(referral_codes).where(inArray(referral_codes.kilo_user_id, params.userIds));
  await db.delete(kilocode_users).where(inArray(kilocode_users.id, params.userIds));
}

export async function insertSeedUsers(users: SeedUserFixture[]): Promise<void> {
  const db = getSeedDb();
  await db.insert(kilocode_users).values(
    users.map(user => ({
      id: user.id,
      google_user_email: user.email,
      google_user_name: user.name,
      google_user_image_url:
        user.imageUrl ?? `https://example.com/${encodeURIComponent(user.id)}.png`,
      stripe_customer_id:
        user.stripeCustomerId ?? `cus_${user.id.replaceAll(/[^a-zA-Z0-9]/g, '_')}`,
      normalized_email: user.normalizedEmail ?? user.email.toLowerCase(),
      is_admin: user.isAdmin ?? false,
    }))
  );
}

export async function insertImpactAdvocateParticipant(params: {
  userId: string;
  email: string;
  opaqueReferralIdentifier: string;
  registeredAt?: string;
}): Promise<void> {
  const db = getSeedDb();
  await db.insert(referral_codes).values({
    kilo_user_id: params.userId,
    code: params.opaqueReferralIdentifier,
  });
  await db.insert(impact_advocate_participants).values({
    user_id: params.userId,
    advocate_id: params.userId,
    advocate_account_id: params.userId,
    opaque_referral_identifier: params.opaqueReferralIdentifier,
    contact_email: params.email,
    registration_state: 'registered',
    registered_at: params.registeredAt ?? new Date().toISOString(),
  });
}

export async function insertPersonalSubscription(fixture: PersonalSubscriptionFixture): Promise<{
  subscription: typeof kiloclaw_subscriptions.$inferSelect;
  instance: typeof kiloclaw_instances.$inferSelect;
}> {
  const db = getSeedDb();

  const [instance] = await db
    .insert(kiloclaw_instances)
    .values({
      user_id: fixture.userId,
      sandbox_id: fixture.sandboxId,
      provider: 'docker-local',
      name: fixture.name ?? null,
      organization_id: fixture.organizationId ?? null,
    })
    .returning();

  const [subscription] = await db
    .insert(kiloclaw_subscriptions)
    .values({
      user_id: fixture.userId,
      instance_id: instance.id,
      payment_source: fixture.paymentSource,
      plan: fixture.plan,
      status: fixture.status,
      cancel_at_period_end: fixture.cancelAtPeriodEnd ?? false,
      current_period_start: fixture.currentPeriodStart ?? null,
      current_period_end: fixture.currentPeriodEnd ?? null,
      credit_renewal_at: fixture.creditRenewalAt ?? null,
      trial_started_at: fixture.trialStartedAt ?? null,
      trial_ends_at: fixture.trialEndsAt ?? null,
      commit_ends_at: fixture.commitEndsAt ?? null,
    })
    .returning();

  return { subscription, instance };
}

export async function insertAppliedRewardChangeLog(params: {
  subscription: typeof kiloclaw_subscriptions.$inferSelect;
  previousBoundary: string;
  newBoundary: string;
}): Promise<void> {
  const beforeSubscription = {
    ...params.subscription,
    current_period_end: params.previousBoundary,
    credit_renewal_at: params.previousBoundary,
  };
  const afterSubscription = {
    ...params.subscription,
    current_period_end: params.newBoundary,
    credit_renewal_at: params.newBoundary,
  };

  await insertKiloClawSubscriptionChangeLog(getSeedDb(), {
    subscriptionId: params.subscription.id,
    actor: {
      actorType: 'system',
      actorId: 'kiloclaw-referrals',
    },
    action: 'period_advanced',
    reason: 'referral_reward:applied',
    before: beforeSubscription,
    after: afterSubscription,
  });
}

export async function assertUserCount(params: { userIds: string[]; expectedCount: number }) {
  const db = getSeedDb();
  const rows = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(inArray(kilocode_users.id, params.userIds));

  if (rows.length !== params.expectedCount) {
    throw new Error(`Expected ${params.expectedCount} seed users, found ${rows.length}`);
  }
}
