import 'server-only';

import { addMonths } from 'date-fns';
import { and, asc, count, eq, inArray, like, lt, lte, or, sql } from 'drizzle-orm';

import { db, type DrizzleTransaction } from '@/lib/drizzle';
import {
  IMPACT_ACTION_TRACKER_IDS,
  buildSalePayload,
  hashEmailForImpact,
  isImpactConfigured,
  reverseImpactAction,
  sendImpactConversionPayload,
  type ImpactConversionPayload,
  type ImpactDispatchResult,
} from '@/lib/impact';
import {
  isImpactAdvocateConfigured,
  sendImpactAdvocateRewardLookupPayload,
  sendImpactAdvocateRewardRedemptionPayload,
  type ImpactAdvocateDispatchResult,
} from '@/lib/impact/advocate';
import { logImpactReferralDebug } from '@/lib/impact/debug';
import { hashNormalizedEmailForDeletionTombstone } from '@/lib/impact/referral';
import { resolveCurrentPersonalSubscriptionRow } from '@/lib/kiloclaw/current-personal-subscription';
import { client as stripe } from '@/lib/stripe-client';
import { insertKiloClawSubscriptionChangeLog } from '@kilocode/db';
import {
  credit_transactions,
  deleted_user_email_tombstones,
  impact_advocate_participants,
  impact_advocate_reward_redemptions,
  impact_conversion_reports,
  impact_attribution_touches,
  impact_referral_conversions,
  impact_referral_reward_applications,
  impact_referral_reward_decisions,
  impact_referral_rewards,
  impact_referrals,
  kiloclaw_subscription_change_log,
  kiloclaw_subscriptions,
  kilocode_users,
  referral_codes,
  type ImpactAttributionTouch,
  type KiloClawSubscription,
} from '@kilocode/db/schema';
import {
  ImpactAdvocateProgramKey,
  ImpactAdvocateRewardRedemptionState,
  ImpactConversionReportState,
  ImpactReferralPaymentProvider,
  ImpactReferralProduct,
  ImpactReferralRewardKind,
  ImpactAttributionTouchType,
  KiloClawReferralBeneficiaryRole,
  KiloClawReferralDecisionOutcome,
  KiloClawReferralRewardStatus,
  KiloClawReferralWinningTouchType,
} from '@kilocode/db/schema-types';

type DatabaseClient = typeof db | DrizzleTransaction;

type WinningAttributionResolution =
  | {
      winner: 'referral';
      referralTouch: ImpactAttributionTouch;
      affiliateTouch: ImpactAttributionTouch | null;
    }
  | {
      winner: 'affiliate';
      affiliateTouch: ImpactAttributionTouch;
      referralTouch: ImpactAttributionTouch | null;
    }
  | {
      winner: 'none';
      affiliateTouch: ImpactAttributionTouch | null;
      referralTouch: ImpactAttributionTouch | null;
    };

export type KiloClawPaidConversionDisposition = {
  shouldEnqueueAffiliateSale: boolean;
  winningTouchType: 'referral' | 'affiliate' | 'none';
  conversionId: string | null;
  disqualificationReason: string | null;
};

export type ImpactConversionReportDispatchSummary = {
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
};

export type ReferralRewardProcessingSummary = {
  claimed: number;
  applied: number;
  expired: number;
  pending: number;
  failed: number;
};

export type ImpactAdvocateRewardRedemptionDispatchSummary = {
  claimed: number;
  redeemed: number;
  retried: number;
  failed: number;
};

export type AdverseReferralPaymentReason = 'chargeback' | 'refund' | 'fraud';

export type PaidConversionQualificationContext = {
  sourceType?: 'normal' | 'test' | 'fraudulent' | 'admin_created' | 'manual_adjustment';
  overrideEligible?: boolean;
};

export type AdverseReferralPaymentSummary = {
  conversionId: string | null;
  canceledRewards: number;
  reviewRequiredRewards: number;
  impactActionReversed: boolean;
};

const REFERRAL_REWARD_ACTOR = {
  actorType: 'system',
  actorId: 'kiloclaw-referrals',
} as const;

const SIGNUP_REFERRAL_TOUCH_CAPTURE_GRACE_MS = 10 * 60 * 1000;
const IMPACT_ADVOCATE_REWARD_UNIT = 'MONTH';

function getDatabaseClient(database?: DatabaseClient): DatabaseClient {
  return database ?? db;
}

function reportBackoffDelayMs(attemptCount: number): number {
  const maxDelayMs = 60 * 60 * 1000;
  const initialDelayMs = 60 * 1000;
  return Math.min(initialDelayMs * 2 ** Math.max(attemptCount, 0), maxDelayMs);
}

function nextReportRetryAt(attemptCount: number): string {
  return new Date(Date.now() + reportBackoffDelayMs(attemptCount)).toISOString();
}

function nextReportClaimExpiresAt(): string {
  return new Date(Date.now() + 15 * 60 * 1000).toISOString();
}

function referralDisqualificationReason(reason: string): string {
  return `referral_${reason}`;
}

function hasAcceptedTrackingValue(touch: ImpactAttributionTouch): boolean {
  return touch.is_tracking_value_accepted && Boolean(touch.opaque_tracking_value?.trim());
}

function isTouchValidAtConversion(touch: ImpactAttributionTouch, convertedAt: Date): boolean {
  return (
    hasAcceptedTrackingValue(touch) &&
    new Date(touch.touched_at).getTime() <= convertedAt.getTime() &&
    convertedAt.getTime() < new Date(touch.expires_at).getTime()
  );
}

export function resolveWinningAttributionTouch(params: {
  touches: ImpactAttributionTouch[];
  convertedAt: Date;
}): WinningAttributionResolution {
  const validReferralTouches = params.touches
    .filter(
      touch =>
        touch.touch_type === ImpactAttributionTouchType.Referral &&
        isTouchValidAtConversion(touch, params.convertedAt)
    )
    .sort((a, b) => new Date(a.touched_at).getTime() - new Date(b.touched_at).getTime());
  const validAffiliateTouches = params.touches
    .filter(
      touch =>
        touch.touch_type === ImpactAttributionTouchType.Affiliate &&
        isTouchValidAtConversion(touch, params.convertedAt)
    )
    .sort((a, b) => new Date(a.touched_at).getTime() - new Date(b.touched_at).getTime());

  const oldestReferralTouch = validReferralTouches[0] ?? null;
  const oldestAffiliateTouch = validAffiliateTouches[0] ?? null;

  if (!oldestReferralTouch && !oldestAffiliateTouch) {
    return {
      winner: 'none',
      affiliateTouch: null,
      referralTouch: null,
    };
  }

  if (!oldestReferralTouch && oldestAffiliateTouch) {
    return {
      winner: 'affiliate',
      affiliateTouch: oldestAffiliateTouch,
      referralTouch: null,
    };
  }

  if (!oldestAffiliateTouch && oldestReferralTouch) {
    return {
      winner: 'referral',
      affiliateTouch: null,
      referralTouch: oldestReferralTouch,
    };
  }

  const preservedAffiliateTouch = validAffiliateTouches.find(touch => {
    if (!touch.sale_attributed_at) return false;
    return (
      new Date(touch.sale_attributed_at).getTime() <
      new Date(oldestReferralTouch.touched_at).getTime()
    );
  });

  if (preservedAffiliateTouch) {
    return {
      winner: 'affiliate',
      affiliateTouch: preservedAffiliateTouch,
      referralTouch: oldestReferralTouch,
    };
  }

  return {
    winner: 'referral',
    affiliateTouch: oldestAffiliateTouch,
    referralTouch: oldestReferralTouch,
  };
}

async function countMonetizedKiloClawPaymentPeriods(
  userId: string,
  database: DatabaseClient
): Promise<number> {
  const [result] = await database
    .select({ count: count() })
    .from(credit_transactions)
    .where(
      and(
        eq(credit_transactions.kilo_user_id, userId),
        eq(credit_transactions.is_free, false),
        lt(credit_transactions.amount_microdollars, 0),
        or(
          like(credit_transactions.credit_category, 'kiloclaw-subscription:%'),
          like(credit_transactions.credit_category, 'kiloclaw-subscription-commit:%'),
          like(credit_transactions.credit_category, 'kiloclaw-settlement:%')
        )
      )
    );

  return result?.count ?? 0;
}

async function findAcceptedUserTouches(params: {
  userId: string;
  convertedAt: Date;
  database: DatabaseClient;
}): Promise<ImpactAttributionTouch[]> {
  return await params.database
    .select()
    .from(impact_attribution_touches)
    .where(
      and(
        eq(impact_attribution_touches.product, ImpactReferralProduct.KiloClaw),
        eq(impact_attribution_touches.user_id, params.userId),
        lte(impact_attribution_touches.touched_at, params.convertedAt.toISOString())
      )
    )
    .orderBy(
      asc(impact_attribution_touches.touched_at),
      asc(impact_attribution_touches.created_at)
    );
}

function buildOpaqueReferralIdentifierFromTouch(touch: ImpactAttributionTouch): string | null {
  const referralIdentifier = buildImpactReferralId(touch)?.trim();
  return referralIdentifier ? referralIdentifier : null;
}

async function resolveReferrerUserIdFromReferralTouch(params: {
  referralTouch: ImpactAttributionTouch;
  database: DatabaseClient;
}): Promise<string | null> {
  const opaqueReferralIdentifier = buildOpaqueReferralIdentifierFromTouch(params.referralTouch);
  if (!opaqueReferralIdentifier) {
    return null;
  }

  const [participant] = await params.database
    .select({ userId: impact_advocate_participants.user_id })
    .from(impact_advocate_participants)
    .where(
      and(
        eq(impact_advocate_participants.program_key, ImpactAdvocateProgramKey.KiloClaw),
        eq(impact_advocate_participants.opaque_referral_identifier, opaqueReferralIdentifier)
      )
    )
    .limit(1);

  if (participant) {
    return participant.userId;
  }

  const [referralCode] = await params.database
    .select({ userId: referral_codes.kilo_user_id })
    .from(referral_codes)
    .where(eq(referral_codes.code, opaqueReferralIdentifier))
    .limit(1);

  return referralCode?.userId ?? null;
}

function wasReferralTouchCapturedDuringSignup(params: {
  userCreatedAt: string;
  referralTouch: ImpactAttributionTouch;
}): boolean {
  if (!params.referralTouch.landing_path) {
    return false;
  }

  const touchTime = new Date(params.referralTouch.touched_at).getTime();
  const userCreatedTime = new Date(params.userCreatedAt).getTime();
  if (touchTime < userCreatedTime) {
    return false;
  }

  if (touchTime - userCreatedTime > SIGNUP_REFERRAL_TOUCH_CAPTURE_GRACE_MS) {
    return false;
  }

  try {
    const landingUrl = new URL(params.referralTouch.landing_path, 'http://localhost');
    return landingUrl.searchParams.get('signup') === 'true';
  } catch {
    return false;
  }
}

async function hasDeletedUserEmailTombstone(params: {
  normalizedEmail: string | null;
  database: DatabaseClient;
}): Promise<boolean> {
  if (!params.normalizedEmail) {
    return false;
  }

  const [row] = await params.database
    .select({ hash: deleted_user_email_tombstones.normalized_email_hash })
    .from(deleted_user_email_tombstones)
    .where(
      eq(
        deleted_user_email_tombstones.normalized_email_hash,
        hashNormalizedEmailForDeletionTombstone(params.normalizedEmail)
      )
    )
    .limit(1);

  return Boolean(row);
}

async function hasActiveEligiblePersonalSubscription(
  userId: string,
  database: DatabaseClient
): Promise<boolean> {
  const row = await resolveCurrentPersonalSubscriptionRow({ userId, dbOrTx: database });
  if (!row) return false;

  return (
    row.subscription.plan !== 'trial' &&
    row.subscription.status === 'active' &&
    !row.subscription.cancel_at_period_end &&
    row.subscription.suspended_at === null &&
    row.subscription.past_due_since === null
  );
}

async function markAffiliateTouchSaleAttributed(params: {
  database: DatabaseClient;
  affiliateTouchId: string;
  convertedAt: Date;
}): Promise<void> {
  await params.database
    .update(impact_attribution_touches)
    .set({
      sale_attributed_at: sql`COALESCE(${impact_attribution_touches.sale_attributed_at}, ${params.convertedAt.toISOString()}::timestamptz)`,
    })
    .where(eq(impact_attribution_touches.id, params.affiliateTouchId));
}

async function lockReferrerRewardCapacity(
  referrerUserId: string,
  database: DatabaseClient
): Promise<void> {
  await database.execute(
    sql`SELECT ${kilocode_users.id} FROM ${kilocode_users} WHERE ${kilocode_users.id} = ${referrerUserId} FOR UPDATE`
  );
}

async function getGrantedReferrerMonths(
  referrerUserId: string,
  database: DatabaseClient
): Promise<number> {
  const [result] = await database
    .select({
      totalMonths: sql<number>`COALESCE(SUM(${impact_referral_reward_decisions.months_granted}), 0)`,
    })
    .from(impact_referral_reward_decisions)
    .where(
      and(
        eq(impact_referral_reward_decisions.product, ImpactReferralProduct.KiloClaw),
        eq(
          impact_referral_reward_decisions.reward_kind,
          ImpactReferralRewardKind.KiloClawFreeMonth
        ),
        eq(impact_referral_reward_decisions.beneficiary_user_id, referrerUserId),
        eq(
          impact_referral_reward_decisions.beneficiary_role,
          KiloClawReferralBeneficiaryRole.Referrer
        ),
        eq(impact_referral_reward_decisions.outcome, KiloClawReferralDecisionOutcome.Granted)
      )
    );

  return Number(result?.totalMonths ?? 0);
}

async function hasSaleAttributedAffiliateTouch(params: {
  userId: string;
  database: DatabaseClient;
}): Promise<boolean> {
  const [touch] = await params.database
    .select({ id: impact_attribution_touches.id })
    .from(impact_attribution_touches)
    .where(
      and(
        eq(impact_attribution_touches.product, ImpactReferralProduct.KiloClaw),
        eq(impact_attribution_touches.user_id, params.userId),
        eq(impact_attribution_touches.touch_type, ImpactAttributionTouchType.Affiliate),
        sql`${impact_attribution_touches.sale_attributed_at} IS NOT NULL`
      )
    )
    .limit(1);

  return Boolean(touch);
}

async function hasAdminOverrideHistory(params: {
  subscriptionId: string;
  database: DatabaseClient;
}): Promise<boolean> {
  const [row] = await params.database
    .select({ id: kiloclaw_subscription_change_log.id })
    .from(kiloclaw_subscription_change_log)
    .where(
      and(
        eq(kiloclaw_subscription_change_log.subscription_id, params.subscriptionId),
        eq(kiloclaw_subscription_change_log.action, 'admin_override')
      )
    )
    .limit(1);

  return Boolean(row);
}

async function getHeuristicSourcePaymentDisqualificationReason(params: {
  sourcePaymentId: string;
  database: DatabaseClient;
}): Promise<string | null> {
  const [transaction] = await params.database
    .select({
      description: credit_transactions.description,
      isFree: credit_transactions.is_free,
    })
    .from(credit_transactions)
    .where(eq(credit_transactions.credit_category, params.sourcePaymentId))
    .limit(1);

  if (!transaction) {
    return null;
  }

  if (transaction.isFree) {
    return referralDisqualificationReason('fully_comped_period');
  }

  const description = transaction.description?.trim().toLowerCase() ?? '';
  if (description.includes('fraud')) {
    return referralDisqualificationReason('fraudulent_subscription');
  }
  if (description.includes('manual')) {
    return referralDisqualificationReason('manual_adjustment_subscription');
  }
  if (description.includes('admin')) {
    return referralDisqualificationReason('admin_created_subscription');
  }
  if (description.includes('test')) {
    return referralDisqualificationReason('test_subscription');
  }

  return null;
}

function getObjectProperty(record: unknown, key: string): unknown {
  if (typeof record !== 'object' || record === null) {
    return undefined;
  }

  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    return undefined;
  }

  return Reflect.get(record, key);
}

function getCaseInsensitiveObjectProperty(record: unknown, key: string): unknown {
  if (typeof record !== 'object' || record === null) {
    return undefined;
  }

  const keys = Object.keys(record);
  const matchedKey = keys.find(candidate => candidate.toLowerCase() === key.toLowerCase());
  return matchedKey ? Reflect.get(record, matchedKey) : undefined;
}

function getStringProperty(record: unknown, keys: string[]): string | null {
  for (const key of keys) {
    const value = getCaseInsensitiveObjectProperty(record, key);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function getNumberProperty(record: unknown, keys: string[]): number | null {
  for (const key of keys) {
    const value = getCaseInsensitiveObjectProperty(record, key);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function rewardHasUnit(reward: unknown, unit: string): boolean {
  const unitValue =
    getStringProperty(reward, ['unit', 'Unit', 'currency']) ??
    getStringProperty(getCaseInsensitiveObjectProperty(reward, 'credit'), ['unit', 'Unit']) ??
    getStringProperty(getCaseInsensitiveObjectProperty(reward, 'value'), ['unit', 'Unit']);
  return !unitValue || unitValue.toLowerCase() === unit.toLowerCase();
}

function rewardHasAmount(reward: unknown, amount: number): boolean {
  const amountValue =
    getNumberProperty(reward, ['amount', 'Amount', 'remainingAmount', 'RemainingAmount']) ??
    getNumberProperty(getCaseInsensitiveObjectProperty(reward, 'credit'), ['amount', 'Amount']) ??
    getNumberProperty(getCaseInsensitiveObjectProperty(reward, 'value'), ['amount', 'Amount']);
  return amountValue === null || amountValue >= amount;
}

function rewardIsCredit(reward: unknown): boolean {
  const type = getStringProperty(reward, ['type', 'Type', 'rewardType', 'RewardType']);
  return !type || type.toUpperCase() === 'CREDIT';
}

function rewardIsRedeemable(reward: unknown): boolean {
  const status = getStringProperty(reward, ['status', 'Status', 'state', 'State']);
  if (status) {
    const normalizedStatus = status.toUpperCase().replaceAll(' ', '_');
    if (
      normalizedStatus === 'REDEEMED' ||
      normalizedStatus === 'CANCELLED' ||
      normalizedStatus === 'CANCELED'
    ) {
      return false;
    }
  }

  const redeemed = getCaseInsensitiveObjectProperty(reward, 'redeemed');
  if (redeemed === true) return false;

  const terminalTimestamps = [
    'redeemedAt',
    'dateRedeemed',
    'cancelledAt',
    'canceledAt',
    'dateCancelled',
    'dateCanceled',
  ];
  return !terminalTimestamps.some(key => Boolean(getCaseInsensitiveObjectProperty(reward, key)));
}

function getImpactAdvocateRewardId(reward: unknown): string | null {
  return getStringProperty(reward, ['id', 'Id', 'ID', 'rewardId', 'RewardId']);
}

function selectImpactAdvocateRewardId(params: {
  rewards: unknown[];
  amount: number;
  unit: string;
}): string | null {
  for (const reward of params.rewards) {
    const rewardId = getImpactAdvocateRewardId(reward);
    if (
      rewardId &&
      rewardIsCredit(reward) &&
      rewardHasUnit(reward, params.unit) &&
      rewardHasAmount(reward, params.amount) &&
      rewardIsRedeemable(reward)
    ) {
      return rewardId;
    }
  }

  return null;
}

function isAlreadyRedeemedResponse(responseBody: string | null | undefined): boolean {
  const normalized = responseBody?.toLowerCase() ?? '';
  return normalized.includes('already') && normalized.includes('redeem');
}

function getImpactActionIdFromResponsePayload(payload: unknown): string | null {
  const value = getObjectProperty(payload, 'actionId');
  return typeof value === 'string' && value.trim() ? value : null;
}

function getRewardApplicationReason(reason: string): string {
  return `referral_reward_${reason}`;
}

function getAdversePaymentReason(reason: AdverseReferralPaymentReason): string {
  return `referral_payment_${reason}`;
}

function getQualificationDisqualificationReason(
  sourceType: Exclude<PaidConversionQualificationContext['sourceType'], undefined | 'normal'>
): string {
  switch (sourceType) {
    case 'test':
      return referralDisqualificationReason('test_subscription');
    case 'fraudulent':
      return referralDisqualificationReason('fraudulent_subscription');
    case 'admin_created':
      return referralDisqualificationReason('admin_created_subscription');
    case 'manual_adjustment':
      return referralDisqualificationReason('manual_adjustment_subscription');
  }
}

function getRewardBearingReferralConfigurationState() {
  const impactPerformanceConfigured = isImpactConfigured();
  const impactAdvocateConfigured = isImpactAdvocateConfigured();

  return {
    impactPerformanceConfigured,
    impactAdvocateConfigured,
    isConfigured: impactPerformanceConfigured && impactAdvocateConfigured,
  };
}

function logRewardBearingReferralConfigurationFailure(params: {
  sourcePaymentId?: string;
  conversionId?: string;
  rewardId?: string;
  userId?: string;
}): void {
  const configurationState = getRewardBearingReferralConfigurationState();
  console.error('[kiloclaw-referrals] reward-bearing referral configuration is incomplete', {
    ...params,
    impactPerformanceConfigured: configurationState.impactPerformanceConfigured,
    impactAdvocateConfigured: configurationState.impactAdvocateConfigured,
  });
}

function getNextRenewalBoundary(subscription: KiloClawSubscription): string | null {
  return subscription.credit_renewal_at ?? subscription.current_period_end;
}

function hasActiveEligibleSubscriptionRow(subscription: KiloClawSubscription): boolean {
  return (
    subscription.plan !== 'trial' &&
    subscription.status === 'active' &&
    !subscription.cancel_at_period_end &&
    subscription.suspended_at === null &&
    subscription.past_due_since === null
  );
}

function requiresDeferredStripeRewardApplication(subscription: KiloClawSubscription): boolean {
  return Boolean(subscription.stripe_schedule_id || subscription.scheduled_plan);
}

async function applyReferralRewardById(
  rewardId: string,
  options?: { stripeAlreadyApplied?: boolean }
): Promise<'applied' | 'expired' | 'pending' | 'noop'> {
  const result = await db.transaction(async tx => {
    const [reward] = await tx
      .select()
      .from(impact_referral_rewards)
      .where(eq(impact_referral_rewards.id, rewardId))
      .limit(1);

    if (!reward) {
      return 'noop';
    }

    if (
      reward.product !== ImpactReferralProduct.KiloClaw ||
      reward.reward_kind !== ImpactReferralRewardKind.KiloClawFreeMonth
    ) {
      return 'noop';
    }

    if (
      reward.status === KiloClawReferralRewardStatus.Applied ||
      reward.status === KiloClawReferralRewardStatus.Canceled ||
      reward.status === KiloClawReferralRewardStatus.Expired ||
      reward.status === KiloClawReferralRewardStatus.Reversed ||
      reward.status === KiloClawReferralRewardStatus.ReviewRequired
    ) {
      return 'noop';
    }

    const now = new Date();
    if (
      reward.status === KiloClawReferralRewardStatus.Pending &&
      reward.expires_at &&
      now.getTime() >= new Date(reward.expires_at).getTime()
    ) {
      await tx
        .update(impact_referral_rewards)
        .set({
          status: KiloClawReferralRewardStatus.Expired,
          review_reason: getRewardApplicationReason('inactive_referrer_expired'),
        })
        .where(eq(impact_referral_rewards.id, reward.id));
      return 'expired';
    }

    if (!getRewardBearingReferralConfigurationState().isConfigured) {
      logRewardBearingReferralConfigurationFailure({
        rewardId: reward.id,
        userId: reward.beneficiary_user_id,
      });
      return 'pending';
    }

    await lockReferrerRewardCapacity(reward.beneficiary_user_id, tx);
    const currentSubscription = await resolveCurrentPersonalSubscriptionRow({
      userId: reward.beneficiary_user_id,
      dbOrTx: tx,
    });
    const subscription = currentSubscription?.subscription ?? null;

    if (!subscription || !hasActiveEligibleSubscriptionRow(subscription)) {
      if (reward.status === KiloClawReferralRewardStatus.Earned) {
        // Mirror the conversion-time invariant: a Referrer reward that lands
        // in Pending because the referrer is no longer on an eligible paid
        // personal subscription MUST carry the 12-month expiry from earned_at
        // (see .specs/impact-referrals.md KiloClaw product rules). Without this back-fill,
        // a reward earned during a brief eligible window and then orphaned
        // when the referrer churns would have expires_at = NULL forever.
        const shouldBackfillExpiresAt =
          reward.beneficiary_role === KiloClawReferralBeneficiaryRole.Referrer &&
          reward.expires_at === null;
        await tx
          .update(impact_referral_rewards)
          .set({
            status: KiloClawReferralRewardStatus.Pending,
            ...(shouldBackfillExpiresAt
              ? {
                  expires_at: addMonths(new Date(reward.earned_at), 12).toISOString(),
                }
              : {}),
          })
          .where(eq(impact_referral_rewards.id, reward.id));
      }
      return 'pending';
    }

    const previousBoundary = getNextRenewalBoundary(subscription);
    if (!previousBoundary) {
      console.warn(
        '[kiloclaw-referrals] reward application left pending due to ambiguous renewal boundary',
        {
          rewardId: reward.id,
          userId: reward.beneficiary_user_id,
          subscriptionId: subscription.id,
        }
      );
      if (reward.status === KiloClawReferralRewardStatus.Pending) {
        await tx
          .update(impact_referral_rewards)
          .set({ status: KiloClawReferralRewardStatus.Earned })
          .where(eq(impact_referral_rewards.id, reward.id));
      }
      return 'pending';
    }

    if (
      subscription.stripe_subscription_id !== null &&
      requiresDeferredStripeRewardApplication(subscription)
    ) {
      console.warn(
        '[kiloclaw-referrals] reward application deferred due to scheduled Stripe changes',
        {
          rewardId: reward.id,
          userId: reward.beneficiary_user_id,
          subscriptionId: subscription.id,
          stripeScheduleId: subscription.stripe_schedule_id,
          scheduledPlan: subscription.scheduled_plan,
        }
      );
      if (reward.status === KiloClawReferralRewardStatus.Pending) {
        await tx
          .update(impact_referral_rewards)
          .set({ status: KiloClawReferralRewardStatus.Earned })
          .where(eq(impact_referral_rewards.id, reward.id));
      }
      return 'pending';
    }

    const appliedAt = now.toISOString();
    const newBoundary = addMonths(new Date(previousBoundary), reward.months_granted).toISOString();
    const localOperationId = `kiloclaw-referral-reward:${reward.id}:apply`;
    const stripeIdempotencyKey = `kiloclaw-referral-reward:${reward.id}:stripe-apply`;

    if (subscription.stripe_subscription_id && !options?.stripeAlreadyApplied) {
      return {
        outcome: 'stripe_pending' as const,
        stripeUpdate: {
          stripeSubscriptionId: subscription.stripe_subscription_id,
          trialEnd: Math.floor(new Date(newBoundary).getTime() / 1000),
          idempotencyKey: stripeIdempotencyKey,
        },
      };
    }

    const [beforeSubscription] = await tx
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, subscription.id))
      .limit(1);
    const [afterSubscription] = await tx
      .update(kiloclaw_subscriptions)
      .set({
        current_period_end: newBoundary,
        credit_renewal_at:
          subscription.payment_source === 'credits' ? newBoundary : subscription.credit_renewal_at,
        commit_ends_at:
          subscription.plan === 'commit' && subscription.commit_ends_at
            ? addMonths(new Date(subscription.commit_ends_at), reward.months_granted).toISOString()
            : subscription.commit_ends_at,
      })
      .where(eq(kiloclaw_subscriptions.id, subscription.id))
      .returning();

    if (!afterSubscription) {
      return 'noop';
    }

    const [appliedReward] = await tx
      .update(impact_referral_rewards)
      .set({
        status: KiloClawReferralRewardStatus.Applied,
        applies_to_subscription_id: subscription.id,
        applied_at: appliedAt,
        review_reason: null,
      })
      .where(
        and(
          eq(impact_referral_rewards.id, reward.id),
          or(
            eq(impact_referral_rewards.status, KiloClawReferralRewardStatus.Earned),
            eq(impact_referral_rewards.status, KiloClawReferralRewardStatus.Pending)
          ),
          sql`${impact_referral_rewards.applied_at} IS NULL`
        )
      )
      .returning({ id: impact_referral_rewards.id });

    if (!appliedReward) {
      return 'noop';
    }

    await insertKiloClawSubscriptionChangeLog(tx, {
      subscriptionId: subscription.id,
      actor: REFERRAL_REWARD_ACTOR,
      action: 'period_advanced',
      reason: getRewardApplicationReason('applied'),
      before: beforeSubscription ?? null,
      after: afterSubscription,
    });

    const [existingApplication] = await tx
      .select({ id: impact_referral_reward_applications.id })
      .from(impact_referral_reward_applications)
      .where(eq(impact_referral_reward_applications.reward_id, reward.id))
      .limit(1);

    if (!existingApplication) {
      await tx.insert(impact_referral_reward_applications).values({
        reward_id: reward.id,
        beneficiary_user_id: reward.beneficiary_user_id,
        subscription_id: subscription.id,
        previous_renewal_boundary: previousBoundary,
        new_renewal_boundary: newBoundary,
        local_operation_id: localOperationId,
        stripe_operation_id: subscription.stripe_subscription_id,
        stripe_idempotency_key: subscription.stripe_subscription_id ? stripeIdempotencyKey : null,
        applied_at: appliedAt,
      });
    }

    await queueImpactAdvocateRewardRedemption({ rewardId: reward.id, database: tx });

    return 'applied';
  });

  if (typeof result === 'string') {
    return result;
  }

  await stripe.subscriptions.update(
    result.stripeUpdate.stripeSubscriptionId,
    {
      trial_end: result.stripeUpdate.trialEnd,
      proration_behavior: 'none',
    },
    {
      idempotencyKey: result.stripeUpdate.idempotencyKey,
    }
  );

  return applyReferralRewardById(rewardId, { stripeAlreadyApplied: true });
}

export async function processQueuedKiloClawReferralRewards(params?: {
  limit?: number;
  beneficiaryUserIds?: string[];
}): Promise<ReferralRewardProcessingSummary> {
  const limit = params?.limit ?? 100;
  const pendingRows = await db
    .select({ id: impact_referral_rewards.id })
    .from(impact_referral_rewards)
    .where(
      and(
        eq(impact_referral_rewards.product, ImpactReferralProduct.KiloClaw),
        eq(impact_referral_rewards.reward_kind, ImpactReferralRewardKind.KiloClawFreeMonth),
        or(
          eq(impact_referral_rewards.status, KiloClawReferralRewardStatus.Pending),
          eq(impact_referral_rewards.status, KiloClawReferralRewardStatus.Earned)
        ),
        params?.beneficiaryUserIds?.length
          ? inArray(impact_referral_rewards.beneficiary_user_id, params.beneficiaryUserIds)
          : undefined
      )
    )
    .orderBy(asc(impact_referral_rewards.earned_at), asc(impact_referral_rewards.created_at))
    .limit(limit);

  const summary: ReferralRewardProcessingSummary = {
    claimed: pendingRows.length,
    applied: 0,
    expired: 0,
    pending: 0,
    failed: 0,
  };

  for (const row of pendingRows) {
    try {
      const outcome = await applyReferralRewardById(row.id);
      if (outcome === 'applied') {
        summary.applied++;
      } else if (outcome === 'expired') {
        summary.expired++;
      } else if (outcome === 'pending') {
        summary.pending++;
      }
    } catch {
      summary.failed++;
    }
  }

  return summary;
}

async function queueImpactAdvocateRewardRedemption(params: {
  rewardId: string;
  database: DatabaseClient;
}): Promise<void> {
  const [reward] = await params.database
    .select({
      id: impact_referral_rewards.id,
      beneficiaryUserId: impact_referral_rewards.beneficiary_user_id,
      monthsGranted: impact_referral_rewards.months_granted,
      status: impact_referral_rewards.status,
      product: impact_referral_rewards.product,
      rewardKind: impact_referral_rewards.reward_kind,
      email: kilocode_users.google_user_email,
    })
    .from(impact_referral_rewards)
    .innerJoin(kilocode_users, eq(kilocode_users.id, impact_referral_rewards.beneficiary_user_id))
    .where(eq(impact_referral_rewards.id, params.rewardId))
    .limit(1);

  if (
    !reward ||
    reward.status !== KiloClawReferralRewardStatus.Applied ||
    reward.product !== ImpactReferralProduct.KiloClaw ||
    reward.rewardKind !== ImpactReferralRewardKind.KiloClawFreeMonth
  ) {
    return;
  }

  const accountId = reward.email.trim();
  if (!accountId) {
    console.error('[kiloclaw-referrals] missing beneficiary email for Impact reward redemption', {
      rewardId: params.rewardId,
      beneficiaryUserId: reward.beneficiaryUserId,
    });
    return;
  }

  await params.database
    .insert(impact_advocate_reward_redemptions)
    .values({
      reward_id: reward.id,
      dedupe_key: `impact-advocate-reward-redemption:${reward.id}`,
      beneficiary_user_id: reward.beneficiaryUserId,
      state: ImpactAdvocateRewardRedemptionState.Queued,
      request_payload: {
        lookup: {
          accountId,
          userId: accountId,
          rewardTypeFilter: 'CREDIT',
        },
        redemption: {
          amount: reward.monthsGranted,
          unit: IMPACT_ADVOCATE_REWARD_UNIT,
        },
      } satisfies Record<string, unknown>,
    })
    .onConflictDoNothing({ target: [impact_advocate_reward_redemptions.reward_id] });
}

type ImpactAdvocateRewardRedemptionRequestPayload = {
  lookup: {
    accountId: string;
    userId: string;
    rewardTypeFilter: 'CREDIT';
  };
  redemption: {
    amount: number;
    unit: string;
  };
};

function isImpactConversionPayload(payload: unknown): payload is ImpactConversionPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof getObjectProperty(payload, 'CampaignId') === 'string' &&
    typeof getObjectProperty(payload, 'ActionTrackerId') === 'number' &&
    typeof getObjectProperty(payload, 'EventDate') === 'string' &&
    typeof getObjectProperty(payload, 'OrderId') === 'string'
  );
}

function isRewardRedemptionRequestPayload(
  payload: unknown
): payload is ImpactAdvocateRewardRedemptionRequestPayload {
  const lookup = getObjectProperty(payload, 'lookup');
  const redemption = getObjectProperty(payload, 'redemption');
  return (
    typeof lookup === 'object' &&
    lookup !== null &&
    typeof redemption === 'object' &&
    redemption !== null &&
    typeof getObjectProperty(lookup, 'accountId') === 'string' &&
    typeof getObjectProperty(lookup, 'userId') === 'string' &&
    getObjectProperty(lookup, 'rewardTypeFilter') === 'CREDIT' &&
    typeof getObjectProperty(redemption, 'amount') === 'number' &&
    typeof getObjectProperty(redemption, 'unit') === 'string'
  );
}

function buildFailurePayload(result: ImpactAdvocateDispatchResult): Record<string, unknown> {
  return {
    failureKind: result.ok ? null : result.failureKind,
    responseBody: result.responseBody ?? null,
    error: result.ok ? null : (result.error ?? null),
  };
}

async function persistRewardRedemptionFailure(params: {
  redemptionId: string;
  attemptCount: number;
  result: ImpactAdvocateDispatchResult;
  stage: 'lookup' | 'redeem';
  terminal?: boolean;
}): Promise<'retried' | 'failed'> {
  const terminal =
    params.terminal ?? (!params.result.ok && params.result.failureKind === 'http_4xx');
  const responsePayload = buildFailurePayload(params.result);
  await db
    .update(impact_advocate_reward_redemptions)
    .set({
      state: terminal
        ? ImpactAdvocateRewardRedemptionState.Failed
        : ImpactAdvocateRewardRedemptionState.Retrying,
      attempt_count: params.attemptCount,
      next_retry_at: terminal ? null : nextReportRetryAt(params.attemptCount),
      response_status_code: params.result.ok ? null : (params.result.statusCode ?? null),
      ...(params.stage === 'lookup'
        ? { lookup_response_payload: responsePayload }
        : { redeem_response_payload: responsePayload }),
    })
    .where(eq(impact_advocate_reward_redemptions.id, params.redemptionId));

  if (terminal) {
    console.error('[kiloclaw-referrals] Impact Advocate reward redemption failed permanently', {
      redemptionId: params.redemptionId,
      stage: params.stage,
      statusCode: params.result.ok ? null : (params.result.statusCode ?? null),
      failureKind: params.result.ok ? null : params.result.failureKind,
    });
    return 'failed';
  }

  return 'retried';
}

async function dispatchImpactAdvocateRewardRedemptionById(
  redemptionId: string
): Promise<'redeemed' | 'retried' | 'failed'> {
  const redemption = await db.query.impact_advocate_reward_redemptions.findFirst({
    where: eq(impact_advocate_reward_redemptions.id, redemptionId),
  });
  if (!redemption) return 'failed';
  if (redemption.state === ImpactAdvocateRewardRedemptionState.Redeemed) return 'redeemed';
  if (redemption.state === ImpactAdvocateRewardRedemptionState.Failed) return 'failed';

  const attemptCount = redemption.attempt_count + 1;
  if (!isRewardRedemptionRequestPayload(redemption.request_payload)) {
    await db
      .update(impact_advocate_reward_redemptions)
      .set({
        state: ImpactAdvocateRewardRedemptionState.Failed,
        attempt_count: attemptCount,
        redeem_response_payload: { error: 'missing_request_payload' } satisfies Record<
          string,
          unknown
        >,
      })
      .where(eq(impact_advocate_reward_redemptions.id, redemption.id));
    return 'failed';
  }

  const lookupResult = await sendImpactAdvocateRewardLookupPayload(
    redemption.request_payload.lookup
  );
  if (!lookupResult.ok) {
    return await persistRewardRedemptionFailure({
      redemptionId: redemption.id,
      attemptCount,
      result: lookupResult,
      stage: 'lookup',
    });
  }

  const persistedImpactRewardId = redemption.impact_reward_id?.trim() || null;
  const impactRewardId =
    persistedImpactRewardId ??
    selectImpactAdvocateRewardId({
      rewards: lookupResult.rewards ?? [],
      amount: redemption.request_payload.redemption.amount,
      unit: redemption.request_payload.redemption.unit,
    });
  if (!impactRewardId) {
    await db
      .update(impact_advocate_reward_redemptions)
      .set({
        state: ImpactAdvocateRewardRedemptionState.Retrying,
        attempt_count: attemptCount,
        next_retry_at: nextReportRetryAt(attemptCount),
        response_status_code: lookupResult.statusCode ?? null,
        lookup_response_payload: {
          error: 'impact_reward_not_found',
          responseBody: lookupResult.responseBody ?? null,
        } satisfies Record<string, unknown>,
      })
      .where(eq(impact_advocate_reward_redemptions.id, redemption.id));
    return 'retried';
  }

  if (!persistedImpactRewardId) {
    await db
      .update(impact_advocate_reward_redemptions)
      .set({
        impact_reward_id: impactRewardId,
        lookup_response_payload: {
          selectedRewardId: impactRewardId,
          responseBody: lookupResult.responseBody ?? null,
        } satisfies Record<string, unknown>,
      })
      .where(eq(impact_advocate_reward_redemptions.id, redemption.id));
  }

  const redeemResult = await sendImpactAdvocateRewardRedemptionPayload({
    rewardId: impactRewardId,
    ...redemption.request_payload.redemption,
  });
  const isIdempotentAlreadyRedeemed =
    !redeemResult.ok &&
    persistedImpactRewardId === impactRewardId &&
    isAlreadyRedeemedResponse(redeemResult.responseBody);
  if (!redeemResult.ok && !isIdempotentAlreadyRedeemed) {
    return await persistRewardRedemptionFailure({
      redemptionId: redemption.id,
      attemptCount,
      result: redeemResult,
      stage: 'redeem',
    });
  }

  await db
    .update(impact_advocate_reward_redemptions)
    .set({
      state: ImpactAdvocateRewardRedemptionState.Redeemed,
      impact_reward_id: impactRewardId,
      attempt_count: attemptCount,
      next_retry_at: null,
      redeemed_at: new Date().toISOString(),
      response_status_code: redeemResult.statusCode ?? null,
      lookup_response_payload: {
        selectedRewardId: impactRewardId,
        responseBody: lookupResult.responseBody ?? null,
      } satisfies Record<string, unknown>,
      redeem_response_payload: redeemResult.ok
        ? ({ responseBody: redeemResult.responseBody ?? null } satisfies Record<string, unknown>)
        : ({
            alreadyRedeemed: true,
            responseBody: redeemResult.responseBody ?? null,
          } satisfies Record<string, unknown>),
    })
    .where(eq(impact_advocate_reward_redemptions.id, redemption.id));

  return 'redeemed';
}

export async function dispatchQueuedImpactAdvocateRewardRedemptions(params?: {
  limit?: number;
}): Promise<ImpactAdvocateRewardRedemptionDispatchSummary> {
  const limit = params?.limit ?? 100;
  const nowIso = new Date().toISOString();
  const rows = await db
    .update(impact_advocate_reward_redemptions)
    .set({
      state: ImpactAdvocateRewardRedemptionState.Retrying,
      next_retry_at: nextReportClaimExpiresAt(),
    })
    .where(
      and(
        or(
          eq(impact_advocate_reward_redemptions.state, ImpactAdvocateRewardRedemptionState.Queued),
          eq(impact_advocate_reward_redemptions.state, ImpactAdvocateRewardRedemptionState.Retrying)
        ),
        or(
          sql`${impact_advocate_reward_redemptions.next_retry_at} IS NULL`,
          lte(impact_advocate_reward_redemptions.next_retry_at, nowIso)
        ),
        sql`${impact_advocate_reward_redemptions.id} IN (
          SELECT ${impact_advocate_reward_redemptions.id}
          FROM ${impact_advocate_reward_redemptions}
          WHERE ${or(
            eq(
              impact_advocate_reward_redemptions.state,
              ImpactAdvocateRewardRedemptionState.Queued
            ),
            eq(
              impact_advocate_reward_redemptions.state,
              ImpactAdvocateRewardRedemptionState.Retrying
            )
          )}
            AND ${or(
              sql`${impact_advocate_reward_redemptions.next_retry_at} IS NULL`,
              lte(impact_advocate_reward_redemptions.next_retry_at, nowIso)
            )}
          ORDER BY ${impact_advocate_reward_redemptions.created_at}, ${impact_advocate_reward_redemptions.id}
          LIMIT ${limit}
        )`
      )
    )
    .returning({ id: impact_advocate_reward_redemptions.id });

  const summary: ImpactAdvocateRewardRedemptionDispatchSummary = {
    claimed: rows.length,
    redeemed: 0,
    retried: 0,
    failed: 0,
  };

  for (const row of rows) {
    const outcome = await dispatchImpactAdvocateRewardRedemptionById(row.id);
    if (outcome === 'redeemed') {
      summary.redeemed++;
    } else if (outcome === 'retried') {
      summary.retried++;
    } else {
      summary.failed++;
    }
  }

  return summary;
}

async function persistImpactReportReversal(params: {
  reportId: string;
  reason: AdverseReferralPaymentReason;
  occurredAt: Date;
}): Promise<boolean> {
  const existing = await getImpactConversionReportById(params.reportId, db);
  if (!existing) {
    return false;
  }

  const existingPayload = existing.response_payload ?? {};
  if (getObjectProperty(existingPayload, 'referralReversal')) {
    return false;
  }

  const actionId = getImpactActionIdFromResponsePayload(existingPayload);
  if (!actionId) {
    await db
      .update(impact_conversion_reports)
      .set({
        response_payload: {
          ...existingPayload,
          referralReversal: {
            reason: params.reason,
            occurredAt: params.occurredAt.toISOString(),
            status: 'missing_action_id',
          },
        } satisfies Record<string, unknown>,
      })
      .where(eq(impact_conversion_reports.id, params.reportId));
    return false;
  }

  const result = await reverseImpactAction({ actionId });
  await db
    .update(impact_conversion_reports)
    .set({
      response_payload: {
        ...existingPayload,
        referralReversal: {
          reason: params.reason,
          occurredAt: params.occurredAt.toISOString(),
          ok: result.ok,
          failureKind: result.ok ? null : result.failureKind,
          statusCode: result.ok ? null : (result.statusCode ?? null),
          responseBody: result.responseBody ?? null,
        },
      } satisfies Record<string, unknown>,
    })
    .where(eq(impact_conversion_reports.id, params.reportId));

  return result.ok;
}

export async function markPersonalKiloClawReferralPaymentAdverse(params: {
  sourcePaymentId: string;
  reason: AdverseReferralPaymentReason;
  occurredAt: Date;
  paymentProvider?: ImpactReferralPaymentProvider;
}): Promise<AdverseReferralPaymentSummary> {
  const paymentProvider = params.paymentProvider ?? ImpactReferralPaymentProvider.Credits;
  let impactReportId: string | null = null;

  const summary = await db.transaction(async tx => {
    const conversion = await tx.query.impact_referral_conversions.findFirst({
      where: and(
        eq(impact_referral_conversions.product, ImpactReferralProduct.KiloClaw),
        eq(impact_referral_conversions.payment_provider, paymentProvider),
        eq(impact_referral_conversions.source_payment_id, params.sourcePaymentId)
      ),
    });

    if (!conversion) {
      return {
        conversionId: null,
        canceledRewards: 0,
        reviewRequiredRewards: 0,
      };
    }

    const rewards = await tx
      .select()
      .from(impact_referral_rewards)
      .where(eq(impact_referral_rewards.conversion_id, conversion.id));

    let canceledRewards = 0;
    let reviewRequiredRewards = 0;
    for (const reward of rewards) {
      if (
        reward.status === KiloClawReferralRewardStatus.Pending ||
        reward.status === KiloClawReferralRewardStatus.Earned
      ) {
        await tx
          .update(impact_referral_rewards)
          .set({
            status: KiloClawReferralRewardStatus.Canceled,
            review_reason: getAdversePaymentReason(params.reason),
          })
          .where(eq(impact_referral_rewards.id, reward.id));
        canceledRewards++;
        continue;
      }

      if (reward.status === KiloClawReferralRewardStatus.Applied) {
        await tx
          .update(impact_referral_rewards)
          .set({
            status: KiloClawReferralRewardStatus.ReviewRequired,
            review_reason: getAdversePaymentReason(params.reason),
          })
          .where(eq(impact_referral_rewards.id, reward.id));
        reviewRequiredRewards++;
      }
    }

    const report = await tx.query.impact_conversion_reports.findFirst({
      where: eq(impact_conversion_reports.conversion_id, conversion.id),
      columns: { id: true },
    });
    impactReportId = report?.id ?? null;

    return {
      conversionId: conversion.id,
      canceledRewards,
      reviewRequiredRewards,
    };
  });

  const impactActionReversed = impactReportId
    ? await persistImpactReportReversal({
        reportId: impactReportId,
        reason: params.reason,
        occurredAt: params.occurredAt,
      })
    : false;

  return {
    ...summary,
    impactActionReversed,
  };
}

async function upsertReferralRelationship(params: {
  refereeUserId: string;
  referrerUserId: string | null;
  sourceTouchId: string;
  impactReferralId: string | null;
  database: DatabaseClient;
}): Promise<void> {
  await params.database
    .insert(impact_referrals)
    .values({
      product: ImpactReferralProduct.KiloClaw,
      referee_user_id: params.refereeUserId,
      referrer_user_id: params.referrerUserId,
      source_touch_id: params.sourceTouchId,
      impact_referral_id: params.impactReferralId,
    })
    .onConflictDoUpdate({
      target: [impact_referrals.product, impact_referrals.referee_user_id],
      set: {
        referrer_user_id: params.referrerUserId,
        source_touch_id: params.sourceTouchId,
        impact_referral_id: params.impactReferralId,
      },
    });
}

function buildImpactReferralId(touch: ImpactAttributionTouch): string | null {
  return touch.rs_code?.trim() || touch.opaque_tracking_value?.trim() || null;
}

async function getImpactConversionReportById(
  reportId: string,
  database: DatabaseClient
): Promise<typeof impact_conversion_reports.$inferSelect | null> {
  const report = await database.query.impact_conversion_reports.findFirst({
    where: eq(impact_conversion_reports.id, reportId),
  });
  return report ?? null;
}

async function persistImpactConversionReportResult(params: {
  reportId: string;
  result: ImpactDispatchResult;
  database?: DatabaseClient;
}): Promise<void> {
  const database = getDatabaseClient(params.database);
  const existing = await getImpactConversionReportById(params.reportId, database);
  if (!existing) return;

  const attemptCount = existing.attempt_count + 1;
  if (params.result.ok) {
    if ('skipped' in params.result) {
      logRewardBearingReferralConfigurationFailure({
        conversionId: existing.conversion_id ?? undefined,
      });
      await database
        .update(impact_conversion_reports)
        .set({
          state: ImpactConversionReportState.Failed,
          attempt_count: attemptCount,
          next_retry_at: null,
          delivered_at: null,
          response_status_code: null,
          response_payload: {
            error: 'missing_reward_bearing_referral_configuration',
            delivery: params.result.skipped,
            responseBody: params.result.responseBody ?? null,
          } satisfies Record<string, unknown>,
        })
        .where(eq(impact_conversion_reports.id, params.reportId));
      return;
    }

    await database
      .update(impact_conversion_reports)
      .set({
        state: ImpactConversionReportState.Delivered,
        attempt_count: attemptCount,
        next_retry_at: null,
        delivered_at: new Date().toISOString(),
        response_status_code: null,
        response_payload: {
          delivery: params.result.delivery ?? null,
          responseBody: params.result.responseBody ?? null,
          ...('actionId' in params.result ? { actionId: params.result.actionId } : {}),
          ...('submissionUri' in params.result
            ? { submissionUri: params.result.submissionUri }
            : {}),
        } satisfies Record<string, unknown>,
      })
      .where(eq(impact_conversion_reports.id, params.reportId));
    return;
  }

  const isTerminalFailure = params.result.failureKind === 'http_4xx';
  if (isTerminalFailure) {
    console.error('[kiloclaw-referrals] Impact conversion report failed permanently', {
      reportId: params.reportId,
      conversionId: existing.conversion_id,
      statusCode: params.result.statusCode ?? null,
      failureKind: params.result.failureKind,
    });
  }

  await database
    .update(impact_conversion_reports)
    .set({
      state: isTerminalFailure
        ? ImpactConversionReportState.Failed
        : ImpactConversionReportState.Retrying,
      attempt_count: attemptCount,
      next_retry_at: isTerminalFailure ? null : nextReportRetryAt(attemptCount),
      response_status_code: params.result.statusCode ?? null,
      response_payload: {
        failureKind: params.result.failureKind,
        responseBody: params.result.responseBody ?? null,
        error: params.result.error ?? null,
      } satisfies Record<string, unknown>,
    })
    .where(eq(impact_conversion_reports.id, params.reportId));
}

async function dispatchImpactConversionReportById(
  reportId: string
): Promise<'delivered' | 'retried' | 'failed'> {
  logImpactReferralDebug('Dispatching Impact referral conversion report', {
    reportId,
  });

  const report = await getImpactConversionReportById(reportId, db);
  if (!report) {
    logImpactReferralDebug('Impact referral conversion report missing before dispatch', {
      reportId,
    });
    return 'failed';
  }

  if (!isImpactConversionPayload(report.request_payload)) {
    await db
      .update(impact_conversion_reports)
      .set({
        state: ImpactConversionReportState.Failed,
        response_payload: {
          error:
            report.request_payload === null ? 'missing_request_payload' : 'invalid_request_payload',
        } satisfies Record<string, unknown>,
      })
      .where(eq(impact_conversion_reports.id, report.id));
    return 'failed';
  }
  const payload = report.request_payload;

  const result = await sendImpactConversionPayload(payload);
  await persistImpactConversionReportResult({ reportId: report.id, result });
  const outcome = result.ok
    ? 'delivered'
    : result.failureKind === 'http_4xx'
      ? 'failed'
      : 'retried';
  logImpactReferralDebug('Impact referral conversion report dispatch result', {
    reportId: report.id,
    conversionId: report.conversion_id,
    outcome,
    ok: result.ok,
    failureKind: result.ok ? null : result.failureKind,
    statusCode: result.ok ? null : (result.statusCode ?? null),
  });
  return outcome;
}

export async function dispatchQueuedImpactConversionReports(params?: {
  limit?: number;
}): Promise<ImpactConversionReportDispatchSummary> {
  const limit = params?.limit ?? 100;
  const nowIso = new Date().toISOString();
  const rows = await db
    .update(impact_conversion_reports)
    .set({
      state: ImpactConversionReportState.Retrying,
      next_retry_at: nextReportClaimExpiresAt(),
    })
    .where(
      sql`${impact_conversion_reports.id} IN (
        SELECT ${impact_conversion_reports.id}
        FROM ${impact_conversion_reports}
        WHERE ${or(
          eq(impact_conversion_reports.state, ImpactConversionReportState.Queued),
          eq(impact_conversion_reports.state, ImpactConversionReportState.Retrying)
        )}
          AND ${or(
            sql`${impact_conversion_reports.next_retry_at} IS NULL`,
            lte(impact_conversion_reports.next_retry_at, nowIso)
          )}
        ORDER BY ${impact_conversion_reports.created_at}, ${impact_conversion_reports.id}
        LIMIT ${limit}
      )`
    )
    .returning({ id: impact_conversion_reports.id });

  const summary: ImpactConversionReportDispatchSummary = {
    claimed: rows.length,
    delivered: 0,
    retried: 0,
    failed: 0,
  };

  for (const row of rows) {
    const outcome = await dispatchImpactConversionReportById(row.id);
    if (outcome === 'delivered') {
      summary.delivered++;
    } else if (outcome === 'retried') {
      summary.retried++;
    } else {
      summary.failed++;
    }
  }

  return summary;
}

export async function processPersonalKiloClawPaidConversion(params: {
  userId: string;
  sourcePaymentId: string;
  orderId: string;
  paymentProvider?: ImpactReferralPaymentProvider;
  amount: number;
  currencyCode: string;
  itemCategory: string;
  itemName: string;
  itemSku?: string;
  convertedAt: Date;
  qualificationContext?: PaidConversionQualificationContext;
}): Promise<KiloClawPaidConversionDisposition> {
  const paymentProvider = params.paymentProvider ?? ImpactReferralPaymentProvider.Credits;
  const referralSaleDedupeKey = `impact-referral-sale:${ImpactReferralProduct.KiloClaw}:${paymentProvider}:${params.sourcePaymentId}`;

  logImpactReferralDebug(
    'Processing personal KiloClaw paid conversion for Impact referral attribution',
    {
      userId: params.userId,
      sourcePaymentId: params.sourcePaymentId,
      paymentProvider,
      orderId: params.orderId,
      amount: params.amount,
      currencyCode: params.currencyCode,
      itemCategory: params.itemCategory,
      qualificationSourceType: params.qualificationContext?.sourceType ?? null,
      qualificationOverrideEligible: params.qualificationContext?.overrideEligible ?? null,
    }
  );

  let impactReportId: string | null = null;
  const rewardBeneficiaryUserIds = new Set<string>();
  const disposition = await db.transaction(async tx => {
    const existingConversion = await tx.query.impact_referral_conversions.findFirst({
      where: and(
        eq(impact_referral_conversions.product, ImpactReferralProduct.KiloClaw),
        eq(impact_referral_conversions.payment_provider, paymentProvider),
        eq(impact_referral_conversions.source_payment_id, params.sourcePaymentId)
      ),
    });

    if (existingConversion) {
      const overrideDisqualificationReason =
        params.qualificationContext?.sourceType &&
        params.qualificationContext.sourceType !== 'normal'
          ? getQualificationDisqualificationReason(params.qualificationContext.sourceType)
          : null;
      const canReprocessWithAdminOverride =
        params.qualificationContext?.overrideEligible === true &&
        existingConversion.qualified === false &&
        existingConversion.disqualification_reason === overrideDisqualificationReason;

      if (canReprocessWithAdminOverride) {
        await tx
          .delete(impact_referral_conversions)
          .where(eq(impact_referral_conversions.id, existingConversion.id));
      } else {
        return {
          shouldEnqueueAffiliateSale:
            existingConversion.winning_touch_type === KiloClawReferralWinningTouchType.Affiliate,
          winningTouchType: existingConversion.winning_touch_type,
          conversionId: existingConversion.id,
          disqualificationReason: existingConversion.disqualification_reason,
        } satisfies KiloClawPaidConversionDisposition;
      }
    }

    const [user] = await tx
      .select({
        id: kilocode_users.id,
        createdAt: kilocode_users.created_at,
        email: kilocode_users.google_user_email,
        normalizedEmail: kilocode_users.normalized_email,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, params.userId))
      .limit(1);

    if (!user) {
      return {
        shouldEnqueueAffiliateSale: false,
        winningTouchType: KiloClawReferralWinningTouchType.None,
        conversionId: null,
        disqualificationReason: 'user_missing',
      } satisfies KiloClawPaidConversionDisposition;
    }

    const explicitDisqualificationReason =
      params.qualificationContext?.sourceType &&
      params.qualificationContext.sourceType !== 'normal' &&
      !params.qualificationContext.overrideEligible
        ? getQualificationDisqualificationReason(params.qualificationContext.sourceType)
        : null;
    if (explicitDisqualificationReason) {
      return {
        shouldEnqueueAffiliateSale: false,
        winningTouchType: KiloClawReferralWinningTouchType.None,
        conversionId: null,
        disqualificationReason: explicitDisqualificationReason,
      } satisfies KiloClawPaidConversionDisposition;
    }

    const heuristicDisqualificationReason = await getHeuristicSourcePaymentDisqualificationReason({
      sourcePaymentId: params.sourcePaymentId,
      database: tx,
    });
    if (heuristicDisqualificationReason && !params.qualificationContext?.overrideEligible) {
      return {
        shouldEnqueueAffiliateSale: false,
        winningTouchType: KiloClawReferralWinningTouchType.None,
        conversionId: null,
        disqualificationReason: heuristicDisqualificationReason,
      } satisfies KiloClawPaidConversionDisposition;
    }

    const currentPersonalSubscription = await resolveCurrentPersonalSubscriptionRow({
      userId: params.userId,
      dbOrTx: tx,
    });
    if (!currentPersonalSubscription) {
      return {
        shouldEnqueueAffiliateSale: false,
        winningTouchType: KiloClawReferralWinningTouchType.None,
        conversionId: null,
        disqualificationReason: referralDisqualificationReason('non_personal_subscription'),
      } satisfies KiloClawPaidConversionDisposition;
    }

    const hasAdminAdjustedSubscription = await hasAdminOverrideHistory({
      subscriptionId: currentPersonalSubscription.subscription.id,
      database: tx,
    });
    if (hasAdminAdjustedSubscription && !params.qualificationContext?.overrideEligible) {
      return {
        shouldEnqueueAffiliateSale: false,
        winningTouchType: KiloClawReferralWinningTouchType.None,
        conversionId: null,
        disqualificationReason: referralDisqualificationReason('admin_adjusted_subscription'),
      } satisfies KiloClawPaidConversionDisposition;
    }

    const monetizedPeriods = await countMonetizedKiloClawPaymentPeriods(params.userId, tx);
    if (monetizedPeriods > 1) {
      const hasPreservedAffiliateSale = await hasSaleAttributedAffiliateTouch({
        userId: params.userId,
        database: tx,
      });

      return {
        shouldEnqueueAffiliateSale: hasPreservedAffiliateSale,
        winningTouchType: hasPreservedAffiliateSale
          ? KiloClawReferralWinningTouchType.Affiliate
          : KiloClawReferralWinningTouchType.None,
        conversionId: null,
        disqualificationReason: 'not_first_paid_period',
      } satisfies KiloClawPaidConversionDisposition;
    }

    const touches = await findAcceptedUserTouches({
      userId: params.userId,
      convertedAt: params.convertedAt,
      database: tx,
    });
    const resolution = resolveWinningAttributionTouch({
      touches,
      convertedAt: params.convertedAt,
    });

    logImpactReferralDebug('Resolved KiloClaw Impact attribution touches for paid conversion', {
      userId: params.userId,
      sourcePaymentId: params.sourcePaymentId,
      touchCount: touches.length,
      affiliateTouchCount: touches.filter(
        touch => touch.touch_type === ImpactAttributionTouchType.Affiliate
      ).length,
      referralTouchCount: touches.filter(
        touch => touch.touch_type === ImpactAttributionTouchType.Referral
      ).length,
      winner: resolution.winner,
      affiliateTouchId: resolution.affiliateTouch?.id ?? null,
      referralTouchId: resolution.referralTouch?.id ?? null,
    });

    if (resolution.winner === 'none') {
      const [conversion] = await tx
        .insert(impact_referral_conversions)
        .values({
          referee_user_id: params.userId,
          referrer_user_id: null,
          source_touch_id: null,
          winning_touch_type: KiloClawReferralWinningTouchType.None,
          source_payment_id: params.sourcePaymentId,
          payment_provider: paymentProvider,
          qualified: false,
          disqualification_reason: referralDisqualificationReason('no_valid_attribution'),
          converted_at: params.convertedAt.toISOString(),
        })
        .returning({ id: impact_referral_conversions.id });

      return {
        shouldEnqueueAffiliateSale: false,
        winningTouchType: KiloClawReferralWinningTouchType.None,
        conversionId: conversion?.id ?? null,
        disqualificationReason: referralDisqualificationReason('no_valid_attribution'),
      } satisfies KiloClawPaidConversionDisposition;
    }

    if (resolution.winner === 'affiliate') {
      await markAffiliateTouchSaleAttributed({
        database: tx,
        affiliateTouchId: resolution.affiliateTouch.id,
        convertedAt: params.convertedAt,
      });

      const [conversion] = await tx
        .insert(impact_referral_conversions)
        .values({
          referee_user_id: params.userId,
          referrer_user_id: null,
          source_touch_id: resolution.affiliateTouch.id,
          winning_touch_type: KiloClawReferralWinningTouchType.Affiliate,
          source_payment_id: params.sourcePaymentId,
          payment_provider: paymentProvider,
          qualified: false,
          disqualification_reason: referralDisqualificationReason('affiliate_won'),
          converted_at: params.convertedAt.toISOString(),
        })
        .returning({ id: impact_referral_conversions.id });

      return {
        shouldEnqueueAffiliateSale: true,
        winningTouchType: KiloClawReferralWinningTouchType.Affiliate,
        conversionId: conversion?.id ?? null,
        disqualificationReason: referralDisqualificationReason('affiliate_won'),
      } satisfies KiloClawPaidConversionDisposition;
    }

    const referrerUserId = await resolveReferrerUserIdFromReferralTouch({
      referralTouch: resolution.referralTouch,
      database: tx,
    });
    await upsertReferralRelationship({
      refereeUserId: params.userId,
      referrerUserId,
      sourceTouchId: resolution.referralTouch.id,
      impactReferralId: buildImpactReferralId(resolution.referralTouch),
      database: tx,
    });
    logImpactReferralDebug('Upserted KiloClaw Impact referral relationship', {
      refereeUserId: params.userId,
      referrerUserId,
      sourceTouchId: resolution.referralTouch.id,
      impactReferralIdPresent: Boolean(buildImpactReferralId(resolution.referralTouch)?.trim()),
    });

    const deletedUser = await hasDeletedUserEmailTombstone({
      normalizedEmail: user.normalizedEmail,
      database: tx,
    });
    const userExistedBeforeReferral =
      new Date(user.createdAt).getTime() <
        new Date(resolution.referralTouch.touched_at).getTime() &&
      !wasReferralTouchCapturedDuringSignup({
        userCreatedAt: user.createdAt,
        referralTouch: resolution.referralTouch,
      });
    const isSelfReferral = referrerUserId !== null && referrerUserId === params.userId;

    if (deletedUser || userExistedBeforeReferral || !referrerUserId || isSelfReferral) {
      const disqualificationReason = deletedUser
        ? referralDisqualificationReason('deleted_user_tombstone')
        : userExistedBeforeReferral
          ? referralDisqualificationReason('existing_user_before_touch')
          : !referrerUserId
            ? referralDisqualificationReason('referrer_unresolved')
            : referralDisqualificationReason('self_referral');

      const [conversion] = await tx
        .insert(impact_referral_conversions)
        .values({
          referee_user_id: params.userId,
          referrer_user_id: referrerUserId,
          source_touch_id: resolution.referralTouch.id,
          winning_touch_type: KiloClawReferralWinningTouchType.Referral,
          source_payment_id: params.sourcePaymentId,
          payment_provider: paymentProvider,
          qualified: false,
          disqualification_reason: disqualificationReason,
          converted_at: params.convertedAt.toISOString(),
        })
        .returning({ id: impact_referral_conversions.id });

      return {
        shouldEnqueueAffiliateSale: false,
        winningTouchType: KiloClawReferralWinningTouchType.Referral,
        conversionId: conversion?.id ?? null,
        disqualificationReason,
      } satisfies KiloClawPaidConversionDisposition;
    }

    if (!getRewardBearingReferralConfigurationState().isConfigured) {
      const disqualificationReason = referralDisqualificationReason('missing_configuration');
      logRewardBearingReferralConfigurationFailure({
        sourcePaymentId: params.sourcePaymentId,
        userId: params.userId,
      });

      const [conversion] = await tx
        .insert(impact_referral_conversions)
        .values({
          referee_user_id: params.userId,
          referrer_user_id: referrerUserId,
          source_touch_id: resolution.referralTouch.id,
          winning_touch_type: KiloClawReferralWinningTouchType.Referral,
          source_payment_id: params.sourcePaymentId,
          payment_provider: paymentProvider,
          qualified: false,
          disqualification_reason: disqualificationReason,
          converted_at: params.convertedAt.toISOString(),
        })
        .returning({ id: impact_referral_conversions.id });

      if (!conversion) {
        throw new Error(
          `Failed to create referral conversion for payment ${params.sourcePaymentId}`
        );
      }

      await tx.insert(impact_referral_reward_decisions).values([
        {
          conversion_id: conversion.id,
          beneficiary_user_id: params.userId,
          beneficiary_role: KiloClawReferralBeneficiaryRole.Referee,
          outcome: KiloClawReferralDecisionOutcome.Disqualified,
          reason: disqualificationReason,
          months_granted: 0,
        },
        {
          conversion_id: conversion.id,
          beneficiary_user_id: referrerUserId,
          beneficiary_role: KiloClawReferralBeneficiaryRole.Referrer,
          outcome: KiloClawReferralDecisionOutcome.Disqualified,
          reason: disqualificationReason,
          months_granted: 0,
        },
      ]);

      const payload = buildSalePayload({
        customerId: params.userId,
        customerEmailHash: hashEmailForImpact(user.email),
        eventDate: params.convertedAt,
        orderId: params.orderId,
        amount: params.amount,
        currencyCode: params.currencyCode,
        itemCategory: params.itemCategory,
        itemName: params.itemName,
        itemSku: params.itemSku,
        trackingId: null,
      });

      await tx
        .insert(impact_conversion_reports)
        .values({
          conversion_id: conversion.id,
          dedupe_key: referralSaleDedupeKey,
          action_tracker_id: IMPACT_ACTION_TRACKER_IDS.sale,
          order_id: params.orderId,
          state: ImpactConversionReportState.Failed,
          request_payload: payload satisfies Record<string, unknown>,
          response_payload: {
            error: 'missing_reward_bearing_referral_configuration',
          } satisfies Record<string, unknown>,
        })
        .onConflictDoNothing({ target: [impact_conversion_reports.dedupe_key] });

      impactReportId = null;

      return {
        shouldEnqueueAffiliateSale: false,
        winningTouchType: KiloClawReferralWinningTouchType.Referral,
        conversionId: conversion.id,
        disqualificationReason,
      } satisfies KiloClawPaidConversionDisposition;
    }

    await lockReferrerRewardCapacity(referrerUserId, tx);
    const referrerGrantedMonths = await getGrantedReferrerMonths(referrerUserId, tx);
    const referrerAtCap = referrerGrantedMonths >= 12;

    const [conversion] = await tx
      .insert(impact_referral_conversions)
      .values({
        referee_user_id: params.userId,
        referrer_user_id: referrerUserId,
        source_touch_id: resolution.referralTouch.id,
        winning_touch_type: KiloClawReferralWinningTouchType.Referral,
        source_payment_id: params.sourcePaymentId,
        payment_provider: paymentProvider,
        qualified: true,
        disqualification_reason: null,
        converted_at: params.convertedAt.toISOString(),
      })
      .returning({ id: impact_referral_conversions.id });

    if (!conversion) {
      throw new Error(`Failed to create referral conversion for payment ${params.sourcePaymentId}`);
    }

    const refereeHasEligibleSubscription = await hasActiveEligiblePersonalSubscription(
      params.userId,
      tx
    );
    const referrerHasEligibleSubscription = await hasActiveEligiblePersonalSubscription(
      referrerUserId,
      tx
    );

    const [refereeDecision, referrerDecision] = await tx
      .insert(impact_referral_reward_decisions)
      .values([
        {
          conversion_id: conversion.id,
          beneficiary_user_id: params.userId,
          beneficiary_role: KiloClawReferralBeneficiaryRole.Referee,
          outcome: KiloClawReferralDecisionOutcome.Granted,
          reason: null,
          months_granted: 1,
        },
        {
          conversion_id: conversion.id,
          beneficiary_user_id: referrerUserId,
          beneficiary_role: KiloClawReferralBeneficiaryRole.Referrer,
          outcome: referrerAtCap
            ? KiloClawReferralDecisionOutcome.CapLimited
            : KiloClawReferralDecisionOutcome.Granted,
          reason: referrerAtCap ? referralDisqualificationReason('referrer_cap_reached') : null,
          months_granted: referrerAtCap ? 0 : 1,
        },
      ])
      .returning({
        id: impact_referral_reward_decisions.id,
        beneficiary_user_id: impact_referral_reward_decisions.beneficiary_user_id,
        beneficiary_role: impact_referral_reward_decisions.beneficiary_role,
        outcome: impact_referral_reward_decisions.outcome,
      });

    await tx.insert(impact_referral_rewards).values(
      [refereeDecision, referrerDecision]
        .filter(decision => decision.outcome === KiloClawReferralDecisionOutcome.Granted)
        .map(decision => ({
          conversion_id: conversion.id,
          decision_id: decision.id,
          beneficiary_user_id: decision.beneficiary_user_id,
          beneficiary_role: decision.beneficiary_role,
          months_granted: 1,
          status:
            decision.beneficiary_role === KiloClawReferralBeneficiaryRole.Referee
              ? refereeHasEligibleSubscription
                ? KiloClawReferralRewardStatus.Earned
                : KiloClawReferralRewardStatus.Pending
              : referrerHasEligibleSubscription
                ? KiloClawReferralRewardStatus.Earned
                : KiloClawReferralRewardStatus.Pending,
          earned_at: params.convertedAt.toISOString(),
          expires_at:
            decision.beneficiary_role === KiloClawReferralBeneficiaryRole.Referrer &&
            !referrerHasEligibleSubscription
              ? addMonths(params.convertedAt, 12).toISOString()
              : null,
        }))
    );

    const payload = buildSalePayload({
      customerId: params.userId,
      customerEmailHash: hashEmailForImpact(user.email),
      eventDate: params.convertedAt,
      orderId: params.orderId,
      amount: params.amount,
      currencyCode: params.currencyCode,
      itemCategory: params.itemCategory,
      itemName: params.itemName,
      itemSku: params.itemSku,
      trackingId: null,
    });

    const [report] = await tx
      .insert(impact_conversion_reports)
      .values({
        conversion_id: conversion.id,
        dedupe_key: referralSaleDedupeKey,
        action_tracker_id: IMPACT_ACTION_TRACKER_IDS.sale,
        order_id: params.orderId,
        state: ImpactConversionReportState.Queued,
        request_payload: payload satisfies Record<string, unknown>,
      })
      .onConflictDoNothing({ target: [impact_conversion_reports.dedupe_key] })
      .returning({ id: impact_conversion_reports.id });

    const existingReport =
      report ??
      (await tx.query.impact_conversion_reports.findFirst({
        where: eq(impact_conversion_reports.dedupe_key, referralSaleDedupeKey),
        columns: { id: true },
      }));
    impactReportId = existingReport?.id ?? null;
    rewardBeneficiaryUserIds.add(params.userId);
    rewardBeneficiaryUserIds.add(referrerUserId);

    return {
      shouldEnqueueAffiliateSale: false,
      winningTouchType: KiloClawReferralWinningTouchType.Referral,
      conversionId: conversion.id,
      disqualificationReason: null,
    } satisfies KiloClawPaidConversionDisposition;
  });

  logImpactReferralDebug(
    'Processed personal KiloClaw paid conversion for Impact referral attribution',
    {
      userId: params.userId,
      sourcePaymentId: params.sourcePaymentId,
      shouldEnqueueAffiliateSale: disposition.shouldEnqueueAffiliateSale,
      winningTouchType: disposition.winningTouchType,
      conversionId: disposition.conversionId,
      disqualificationReason: disposition.disqualificationReason,
      impactReportId,
      rewardBeneficiaryCount: rewardBeneficiaryUserIds.size,
    }
  );

  if (impactReportId) {
    await dispatchImpactConversionReportById(impactReportId);
  }

  if (rewardBeneficiaryUserIds.size > 0) {
    try {
      logImpactReferralDebug('Processing queued KiloClaw Impact referral rewards', {
        sourcePaymentId: params.sourcePaymentId,
        beneficiaryCount: rewardBeneficiaryUserIds.size,
      });
      await processQueuedKiloClawReferralRewards({
        beneficiaryUserIds: Array.from(rewardBeneficiaryUserIds),
      });
    } catch (error) {
      console.error('[kiloclaw-referrals] failed to apply queued referral rewards', {
        sourcePaymentId: params.sourcePaymentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return disposition;
}
