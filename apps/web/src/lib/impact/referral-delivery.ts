import 'server-only';

import { and, asc, eq, inArray, lte, or, sql } from 'drizzle-orm';

import { db, type DrizzleTransaction } from '@/lib/drizzle';
import {
  isImpactConfigured,
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
import {
  impact_advocate_reward_redemptions,
  impact_conversion_reports,
  impact_referral_rewards,
  kilocode_users,
} from '@kilocode/db/schema';
import {
  ImpactAdvocateProgramKey,
  ImpactAdvocateRewardRedemptionState,
  ImpactConversionReportState,
  ImpactReferralProduct,
  ImpactReferralRewardKind,
  ImpactReferralRewardStatus,
} from '@kilocode/db/schema-types';

/**
 * Delivery of queued Impact referral work: Impact Performance conversion
 * reports and Impact Advocate reward redemptions. Both are database-backed
 * outboxes drained by the affiliate-events cron, and both are shared by every
 * referral product, so eligibility and reward decisions deliberately live in
 * the product modules rather than here.
 */

type DatabaseClient = typeof db | DrizzleTransaction;

const IMPACT_ADVOCATE_KILO_PASS_REWARD_UNIT = 'Kilo Pass Bonus Credits';

export type ImpactConversionReportDispatchSummary = {
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
};

export type ImpactAdvocateRewardRedemptionDispatchSummary = {
  claimed: number;
  redeemed: number;
  retried: number;
  failed: number;
};

export type AdverseReferralPaymentReason = 'chargeback' | 'refund' | 'fraud';

function getDatabaseClient(database?: DatabaseClient): DatabaseClient {
  return database ?? db;
}

function outboxBackoffDelayMs(attemptCount: number): number {
  const maxDelayMs = 60 * 60 * 1000;
  const initialDelayMs = 60 * 1000;
  return Math.min(initialDelayMs * 2 ** Math.max(attemptCount, 0), maxDelayMs);
}

function nextOutboxRetryAt(attemptCount: number): string {
  return new Date(Date.now() + outboxBackoffDelayMs(attemptCount)).toISOString();
}

function nextOutboxClaimExpiresAt(): string {
  return new Date(Date.now() + 15 * 60 * 1000).toISOString();
}

export function getRewardBearingReferralConfigurationState() {
  const impactPerformanceConfigured = isImpactConfigured();
  const impactAdvocateConfigured = isImpactAdvocateConfigured({
    product: ImpactReferralProduct.KiloPass,
  });

  return {
    impactPerformanceConfigured,
    impactAdvocateConfigured,
    isConfigured: impactPerformanceConfigured && impactAdvocateConfigured,
  };
}

export function logRewardBearingReferralConfigurationFailure(params: {
  sourcePaymentId?: string;
  conversionId?: string;
  rewardId?: string;
  userId?: string;
}): void {
  const configurationState = getRewardBearingReferralConfigurationState();
  console.error('[impact-referrals] reward-bearing referral configuration is incomplete', {
    ...params,
    impactPerformanceConfigured: configurationState.impactPerformanceConfigured,
    impactAdvocateConfigured: configurationState.impactAdvocateConfigured,
  });
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

/**
 * Queue Impact Advocate reward redemption so Impact reporting matches local
 * allocation state. Redemption is reporting-only: it never gates local reward
 * eligibility, application, cancellation, or reversal.
 */
export async function queueImpactAdvocateRewardRedemption(params: {
  rewardId: string;
  database: DatabaseClient;
}): Promise<void> {
  const [reward] = await params.database
    .select({
      id: impact_referral_rewards.id,
      beneficiaryUserId: impact_referral_rewards.beneficiary_user_id,
      rewardAmountUsd: impact_referral_rewards.reward_amount_usd,
      status: impact_referral_rewards.status,
      product: impact_referral_rewards.product,
      rewardKind: impact_referral_rewards.reward_kind,
      email: kilocode_users.google_user_email,
    })
    .from(impact_referral_rewards)
    .innerJoin(kilocode_users, eq(kilocode_users.id, impact_referral_rewards.beneficiary_user_id))
    .where(eq(impact_referral_rewards.id, params.rewardId))
    .limit(1);

  if (!reward) {
    return;
  }

  const isRedeemableKiloPassReward =
    reward.product === ImpactReferralProduct.KiloPass &&
    reward.rewardKind === ImpactReferralRewardKind.KiloPassBonus &&
    (reward.status === ImpactReferralRewardStatus.Pending ||
      reward.status === ImpactReferralRewardStatus.Earned ||
      reward.status === ImpactReferralRewardStatus.Applied) &&
    reward.rewardAmountUsd !== null &&
    reward.rewardAmountUsd > 0;

  if (!isRedeemableKiloPassReward) {
    return;
  }

  const accountId = reward.email.trim();
  if (!accountId) {
    console.error('[impact-referrals] missing beneficiary email for Impact reward redemption', {
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
        programKey: ImpactAdvocateProgramKey.KiloPass,
        lookup: {
          accountId,
          userId: accountId,
          rewardTypeFilter: 'CREDIT',
        },
        redemption: {
          amount: reward.rewardAmountUsd,
          unit: IMPACT_ADVOCATE_KILO_PASS_REWARD_UNIT,
        },
      } satisfies Record<string, unknown>,
    })
    .onConflictDoNothing({ target: [impact_advocate_reward_redemptions.reward_id] });
}

type ImpactAdvocateRewardRedemptionRequestPayload = {
  programKey: typeof ImpactAdvocateProgramKey.KiloPass;
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
    getObjectProperty(payload, 'programKey') === ImpactAdvocateProgramKey.KiloPass &&
    typeof getObjectProperty(lookup, 'accountId') === 'string' &&
    typeof getObjectProperty(lookup, 'userId') === 'string' &&
    getObjectProperty(lookup, 'rewardTypeFilter') === 'CREDIT' &&
    typeof getObjectProperty(redemption, 'amount') === 'number' &&
    typeof getObjectProperty(redemption, 'unit') === 'string'
  );
}

/**
 * Rows queued before the KiloClaw referral program was retired carry either no
 * program key or the KiloClaw one. They must never be redeemed against another
 * program, so they terminate instead of being retried forever.
 */
function targetsRetiredAdvocateProgram(payload: unknown): boolean {
  const programKey = getObjectProperty(payload, 'programKey');
  return programKey === undefined || programKey === ImpactAdvocateProgramKey.KiloClaw;
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
      next_retry_at: terminal ? null : nextOutboxRetryAt(params.attemptCount),
      response_status_code: params.result.ok ? null : (params.result.statusCode ?? null),
      ...(params.stage === 'lookup'
        ? { lookup_response_payload: responsePayload }
        : { redeem_response_payload: responsePayload }),
    })
    .where(eq(impact_advocate_reward_redemptions.id, params.redemptionId));

  if (terminal) {
    console.error('[impact-referrals] Impact Advocate reward redemption failed permanently', {
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
    const error = targetsRetiredAdvocateProgram(redemption.request_payload)
      ? 'retired_advocate_program'
      : redemption.request_payload === null
        ? 'missing_request_payload'
        : 'invalid_request_payload';
    await db
      .update(impact_advocate_reward_redemptions)
      .set({
        state: ImpactAdvocateRewardRedemptionState.Failed,
        attempt_count: attemptCount,
        redeem_response_payload: { error } satisfies Record<string, unknown>,
      })
      .where(eq(impact_advocate_reward_redemptions.id, redemption.id));
    return 'failed';
  }

  const advocateScope = { programKey: redemption.request_payload.programKey };

  const lookupResult = await sendImpactAdvocateRewardLookupPayload(
    redemption.request_payload.lookup,
    advocateScope
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
        next_retry_at: nextOutboxRetryAt(attemptCount),
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

  const redeemResult = await sendImpactAdvocateRewardRedemptionPayload(
    {
      rewardId: impactRewardId,
      ...redemption.request_payload.redemption,
    },
    advocateScope
  );
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

async function queueMissingImpactAdvocateRewardRedemptions(limit: number): Promise<void> {
  const rows = await db
    .select({ id: impact_referral_rewards.id })
    .from(impact_referral_rewards)
    .where(
      and(
        eq(impact_referral_rewards.product, ImpactReferralProduct.KiloPass),
        eq(impact_referral_rewards.reward_kind, ImpactReferralRewardKind.KiloPassBonus),
        inArray(impact_referral_rewards.status, [
          ImpactReferralRewardStatus.Pending,
          ImpactReferralRewardStatus.Earned,
          ImpactReferralRewardStatus.Applied,
        ]),
        sql`${impact_referral_rewards.reward_amount_usd} > 0`,
        sql`NOT EXISTS (
          SELECT 1
          FROM ${impact_advocate_reward_redemptions}
          WHERE ${impact_advocate_reward_redemptions.reward_id} = ${impact_referral_rewards.id}
        )`
      )
    )
    .orderBy(asc(impact_referral_rewards.earned_at), asc(impact_referral_rewards.created_at))
    .limit(limit);

  for (const row of rows) {
    await queueImpactAdvocateRewardRedemption({ rewardId: row.id, database: db });
  }
}

export async function dispatchQueuedImpactAdvocateRewardRedemptions(params?: {
  limit?: number;
}): Promise<ImpactAdvocateRewardRedemptionDispatchSummary> {
  const limit = params?.limit ?? 100;
  await queueMissingImpactAdvocateRewardRedemptions(limit);
  const nowIso = new Date().toISOString();
  const rows = await db
    .update(impact_advocate_reward_redemptions)
    .set({
      state: ImpactAdvocateRewardRedemptionState.Retrying,
      next_retry_at: nextOutboxClaimExpiresAt(),
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
    console.error('[impact-referrals] Impact conversion report failed permanently', {
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
      next_retry_at: isTerminalFailure ? null : nextOutboxRetryAt(attemptCount),
      response_status_code: params.result.statusCode ?? null,
      response_payload: {
        failureKind: params.result.failureKind,
        responseBody: params.result.responseBody ?? null,
        error: params.result.error ?? null,
      } satisfies Record<string, unknown>,
    })
    .where(eq(impact_conversion_reports.id, params.reportId));
}

export async function dispatchImpactConversionReportById(
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
      next_retry_at: nextOutboxClaimExpiresAt(),
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
