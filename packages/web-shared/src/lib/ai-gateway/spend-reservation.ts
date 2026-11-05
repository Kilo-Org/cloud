import 'server-only';

import { captureMessage } from '@sentry/nextjs';
import { redisClient } from '@kilocode/web-shared/lib/redis';

/**
 * In-flight spend a paid request holds against its payer's balance.
 *
 * A request is priced before inference, and its hold keeps the payer's total
 * in-flight cost inside the balance their admission read. The hold lives until
 * the usage write consumes it where the debit commits, and the payer counter is
 * the sum of the holds that have not been consumed yet. A request that ends
 * without billing releases its hold, and a hold that outlives its request
 * expires.
 *
 * The balance stays authoritative for committed spend. A hold is only the part
 * the stored balance does not show yet.
 */
const HOLDS_KEY_PREFIX = 'gateway-spend-hold:';
const RESERVED_KEY_PREFIX = 'gateway-spend-reserved:';

/**
 * Above the longest gateway function duration, so a hold outlives its request
 * and no longer. A lost usage write must not block the payer's balance forever.
 */
export const SPEND_HOLD_TTL_MS = 15 * 60 * 1000;

/** One report a minute raises the alarm just as well as one per request. */
const FAILURE_REPORT_INTERVAL_MS = 60_000;
const lastFailureReportAt = new Map<string, number>();

export type SpendPayer = {
  /** The organization that pays, or undefined when the user pays personally. */
  organizationId: string | undefined;
  userId: string;
};

export type SpendReservation =
  | {
      kind: 'reserved';
      amountMicrodollars: number;
      release: () => Promise<void>;
    }
  /** The payer's available balance cannot cover this request's maximum cost. */
  | { kind: 'insufficient' }
  /** Redis did not answer, so no hold was taken and the caller keeps its policy. */
  | { kind: 'unavailable' };

/** The payer whose balance funds the request. Members of one organization share it. */
export function spendPayerKey(payer: SpendPayer): string {
  return payer.organizationId ? `organization:${payer.organizationId}` : `user:${payer.userId}`;
}

export function spendHoldKey(usageId: string): string {
  return `${HOLDS_KEY_PREFIX}${usageId}`;
}

const RESERVE_SCRIPT = `
local reserved = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
local available = tonumber(ARGV[2])
if reserved + amount > available then
  return 0
end
redis.call('INCRBY', KEYS[1], amount)
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('SET', KEYS[2], ARGV[4], 'PX', ARGV[3])
return 1
`;

/**
 * Reads the hold, removes it, and subtracts its amount from the payer counter in
 * one operation, so a hold is consumed exactly once however many callers report
 * the same usage id.
 */
const RELEASE_SCRIPT = `
local hold = redis.call('GET', KEYS[1])
if not hold then
  return 0
end
redis.call('DEL', KEYS[1])
local separator = string.find(hold, '|', 1, true)
if not separator then
  return 0
end
local payerKey = string.sub(hold, 1, separator - 1)
local amount = tonumber(string.sub(hold, separator + 1))
if not amount then
  return 0
end
local reserved = redis.call('DECRBY', ARGV[1] .. payerKey, amount)
if reserved <= 0 then
  redis.call('DEL', ARGV[1] .. payerKey)
end
return 1
`;

function reportFailure(outcome: string): void {
  const now = Date.now();
  if (now - (lastFailureReportAt.get(outcome) ?? 0) < FAILURE_REPORT_INTERVAL_MS) return;
  lastFailureReportAt.set(outcome, now);
  captureMessage('Gateway spend reservation store unavailable', {
    level: 'error',
    tags: { source: 'gateway_spend_reservation', outcome },
  });
}

/**
 * Holds `amountMicrodollars` of the payer's available balance for one request.
 *
 * Admission compares the hold against the balance snapshot the request was
 * admitted on: when the holds already taken plus this request exceed it, the
 * payer cannot cover the request and it is refused. An amount of zero holds
 * nothing and reserves nothing.
 */
export async function reservePaidSpend(params: {
  usageId: string;
  payer: SpendPayer;
  amountMicrodollars: number;
  availableMicrodollars: number;
}): Promise<SpendReservation> {
  const { usageId, payer, amountMicrodollars, availableMicrodollars } = params;
  if (!Number.isFinite(amountMicrodollars) || amountMicrodollars <= 0) {
    return { kind: 'reserved', amountMicrodollars: 0, release: async () => {} };
  }
  const payerKey = spendPayerKey(payer);
  try {
    const admitted = await redisClient.eval(
      RESERVE_SCRIPT,
      [`${RESERVED_KEY_PREFIX}${payerKey}`, spendHoldKey(usageId)],
      [
        String(amountMicrodollars),
        String(availableMicrodollars),
        String(SPEND_HOLD_TTL_MS),
        `${payerKey}|${amountMicrodollars}`,
      ]
    );
    if (Number(admitted) !== 1) return { kind: 'insufficient' };
  } catch {
    // A reservation failure must not change whether a paid request is served:
    // the balance check above already admitted it.
    reportFailure('reserve');
    return { kind: 'unavailable' };
  }
  return {
    kind: 'reserved',
    amountMicrodollars,
    release: () => releaseSpendHold(usageId),
  };
}

/**
 * Consumes a request's hold and returns its amount to the payer's available
 * balance. Called where the usage write commits and wherever a request ends
 * without producing usage. Never throws: the hold's TTL is the backstop.
 */
export async function releaseSpendHold(usageId: string): Promise<void> {
  try {
    await redisClient.eval(RELEASE_SCRIPT, [spendHoldKey(usageId)], [RESERVED_KEY_PREFIX]);
  } catch {
    reportFailure('release');
  }
}
