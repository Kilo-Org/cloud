import 'server-only';

import { createHash } from 'node:crypto';
import { captureException } from '@sentry/nextjs';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { z } from 'zod';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import type { GitHubAppType } from './app-selector';

export type PrRefreshOwner = { type: 'user' | 'org'; id: string };

export type ClaimPrRefreshInput = {
  appType: GitHubAppType;
  installationId: string;
  owner: PrRefreshOwner;
  repo: string;
  number: number;
};

export type ClaimPrRefreshDenied = {
  allowed: false;
  reason: 'throttled' | 'rate_limited' | 'unavailable';
  retryAt: Date;
};

export type ClaimPrRefreshResult = { allowed: true } | ClaimPrRefreshDenied;
export type PrMaintenanceScope = { appType: GitHubAppType; installationId: string };
export type PrMaintenanceBudgetResult =
  | { allowed: true; writeLease?: number }
  | {
      allowed: false;
      reason: 'rate_limited' | 'low_budget' | 'unavailable' | 'write_pacing';
      retryAt: Date;
    };
export class PrMaintenanceDeferredError extends Error {
  constructor(
    public readonly reason: 'rate_limited' | 'low_budget' | 'unavailable' | 'write_pacing',
    public readonly retryAt: Date
  ) {
    super(`GitHub maintenance deferred: ${reason}`);
  }
}

export type DeferPrRefreshInput = {
  appType: GitHubAppType;
  installationId: string;
  resetAt: Date;
};

const ATTEMPT_TTL_MS = 60_000;
const UNAVAILABLE_RETRY_MS = 60_000;
const KEY_PREFIX = 'github:pr-refresh-budget:v1';

const CLAIM_SCRIPT = `
local now = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])

local cooldown = redis.call('GET', KEYS[1])
if cooldown then
  local deadline = tonumber(cooldown)
  if not deadline then
    local remaining = redis.call('PTTL', KEYS[1])
    if remaining and remaining > 0 then
      deadline = now + remaining
    end
  end
  if deadline and deadline > now then
    return {0, 1, deadline}
  end
end

local attemptDeadline = now + ttl
local acquired = redis.call('SET', KEYS[2], tostring(attemptDeadline), 'NX', 'PX', ARGV[2])
if acquired then
  return {1, 0, 0}
end

local existing = redis.call('GET', KEYS[2])
local deadline = tonumber(existing)
if not deadline then
  local remaining = redis.call('PTTL', KEYS[2])
  if remaining and remaining > 0 then
    deadline = now + remaining
  end
end
if not deadline then
  deadline = attemptDeadline
end
return {0, 2, deadline}
`;

const DEFER_SCRIPT = `
local now = tonumber(ARGV[1])
local target = tonumber(ARGV[2])
if not target then
  return {0, 0}
end

local existing = redis.call('GET', KEYS[1])
if existing then
  local current = tonumber(existing)
  if not current then
    local remaining = redis.call('PTTL', KEYS[1])
    if remaining and remaining > 0 then
      current = now + remaining
    end
  end
  if current and current >= target then
    return {1, current}
  end
end

local ttl = target - now
if ttl < 1 then
  ttl = 1
end
redis.call('SET', KEYS[1], tostring(target), 'PX', ttl)
return {1, target}
`;

const redisIntegerSchema = z
  .union([z.number().int(), z.string().regex(/^-?\d+$/)])
  .transform(value => (typeof value === 'number' ? value : Number(value)));

const claimEvalResultSchema = z.tuple([redisIntegerSchema, redisIntegerSchema, redisIntegerSchema]);

const deferEvalResultSchema = z.tuple([redisIntegerSchema, redisIntegerSchema]);

function scopeDigest(scope: Record<string, string | number>): string {
  return createHash('sha256').update(JSON.stringify(scope)).digest('hex');
}

function cooldownKey(appType: GitHubAppType, installationId: string): string {
  return `${KEY_PREFIX}:cooldown:${scopeDigest({ appType, installationId })}`;
}

function attemptKey(input: ClaimPrRefreshInput): string {
  return `${KEY_PREFIX}:attempt:${scopeDigest({
    appType: input.appType,
    installationId: input.installationId,
    ownerType: input.owner.type,
    ownerId: input.owner.id,
    repo: input.repo.toLowerCase(),
    number: input.number,
  })}`;
}

function unavailable(now: number): { allowed: false; reason: 'unavailable'; retryAt: Date } {
  return {
    allowed: false,
    reason: 'unavailable',
    retryAt: new Date(now + UNAVAILABLE_RETRY_MS),
  };
}

function parseClaimResult(raw: unknown, now: number): ClaimPrRefreshResult {
  const parsed = claimEvalResultSchema.safeParse(raw);
  if (!parsed.success) return unavailable(now);

  const [allowed, reasonCode, deadline] = parsed.data;
  if (allowed === 1 && reasonCode === 0 && deadline === 0) return { allowed: true };
  if (allowed !== 0 || !Number.isFinite(deadline)) return unavailable(now);

  const retryAt = new Date(deadline);
  if (Number.isNaN(retryAt.getTime())) return unavailable(now);
  if (reasonCode === 1) return { allowed: false, reason: 'rate_limited', retryAt };
  if (reasonCode === 2) return { allowed: false, reason: 'throttled', retryAt };
  return unavailable(now);
}

export async function claimPrRefresh(input: ClaimPrRefreshInput): Promise<ClaimPrRefreshResult> {
  const now = Date.now();
  try {
    const raw = await redisClient.eval(
      CLAIM_SCRIPT,
      [cooldownKey(input.appType, input.installationId), attemptKey(input)],
      [now, ATTEMPT_TTL_MS]
    );
    return parseClaimResult(raw, now);
  } catch {
    return unavailable(now);
  }
}

export async function claimPrConflictBatch(
  input: PrMaintenanceScope
): Promise<ClaimPrRefreshResult> {
  const now = Date.now();
  try {
    const raw = await redisClient.eval(
      CLAIM_SCRIPT,
      [
        cooldownKey(input.appType, input.installationId),
        `${KEY_PREFIX}:conflict:${scopeDigest({ appType: input.appType, installationId: input.installationId })}`,
      ],
      [now, ATTEMPT_TTL_MS]
    );
    return parseClaimResult(raw, now);
  } catch {
    return unavailable(now);
  }
}

export async function deferPrRefresh(input: DeferPrRefreshInput): Promise<void> {
  const now = Date.now();
  const resetAtMs = input.resetAt.getTime();
  if (!Number.isFinite(resetAtMs)) return;

  try {
    const raw = await redisClient.eval(
      DEFER_SCRIPT,
      [cooldownKey(input.appType, input.installationId)],
      [now, resetAtMs]
    );
    if (!deferEvalResultSchema.safeParse(raw).success) {
      throw new Error('Invalid PR refresh defer result');
    }
  } catch {
    captureException(new Error('Failed to defer GitHub PR refresh cooldown'), {
      tags: { source: 'pr_refresh_budget_defer' },
    });
  }
}

const MAINTENANCE_CLAIM_SCRIPT = `
local now = tonumber(ARGV[1])
for index = 1, 2 do
  local deadline = tonumber(redis.call('GET', KEYS[index]))
  if deadline and deadline > now then return {0, index, deadline} end
end
if ARGV[2] == '1' then
  local acquired = redis.call('SET', KEYS[3], tostring(now + 30000), 'NX', 'PX', 30000)
  if not acquired then
    local deadline = tonumber(redis.call('GET', KEYS[3])) or (now + 30000)
    return {0, 3, deadline}
  end
  return {1, 0, now + 30000}
end
return {1, 0, 0}
`;

export async function claimPrMaintenanceCall(
  input: PrMaintenanceScope & { write?: boolean }
): Promise<PrMaintenanceBudgetResult> {
  const now = Date.now();
  const digest = scopeDigest({ appType: input.appType, installationId: input.installationId });
  try {
    const raw = await redisClient.eval(
      MAINTENANCE_CLAIM_SCRIPT,
      [
        cooldownKey(input.appType, input.installationId),
        `${KEY_PREFIX}:low:${digest}`,
        `${KEY_PREFIX}:write:${digest}`,
      ],
      [now, input.write ? '1' : '0']
    );
    const parsed = claimEvalResultSchema.safeParse(raw);
    if (!parsed.success) return unavailable(now);
    const [allowed, code, deadline] = parsed.data;
    if (allowed === 1 && code === 0 && deadline === 0) return { allowed: true };
    if (allowed === 1 && code === 0 && input.write && deadline > now)
      return { allowed: true, writeLease: deadline };
    if (allowed !== 0 || !Number.isFinite(deadline) || deadline <= now) return unavailable(now);
    const reason =
      code === 1
        ? 'rate_limited'
        : code === 2
          ? 'low_budget'
          : code === 3
            ? 'write_pacing'
            : 'unavailable';
    return { allowed: false, reason, retryAt: new Date(deadline) };
  } catch {
    return unavailable(now);
  }
}

export async function completePrMaintenanceWrite(
  input: PrMaintenanceScope & { writeLease: number }
) {
  const digest = scopeDigest({ appType: input.appType, installationId: input.installationId });
  try {
    await redisClient.eval(
      `
if tonumber(redis.call('GET', KEYS[1])) == tonumber(ARGV[1]) then
  redis.call('SET', KEYS[1], tostring(tonumber(ARGV[2]) + 1000), 'PX', 1000)
end
return 1`,
      [`${KEY_PREFIX}:write:${digest}`],
      [input.writeLease, Date.now()]
    );
  } catch {
    captureException(new Error('Failed to complete GitHub maintenance write pacing'), {
      tags: { source: 'pr_maintenance_write_pacing' },
    });
  }
}

export async function recordPrMaintenanceApiCall(
  input: PrMaintenanceScope & {
    endpoint:
      | 'pr_refresh'
      | 'feedback_threads'
      | 'conflict'
      | 'files'
      | 'job_logs'
      | 'reply'
      | 'resolve'
      | 'reconcile';
    reason: string;
    headers?: unknown;
    graphqlCost?: number;
    graphqlBudget?: { limit: number; remaining: number; resetAt: string };
    calls?: 0 | 1;
  }
) {
  const headers = z.record(z.string(), z.unknown()).safeParse(input.headers);
  const values = headers.success ? headers.data : {};
  const limit = input.graphqlBudget?.limit ?? Number(values['x-ratelimit-limit']);
  const remaining = input.graphqlBudget?.remaining ?? Number(values['x-ratelimit-remaining']);
  const reset = input.graphqlBudget
    ? Date.parse(input.graphqlBudget.resetAt)
    : Number(values['x-ratelimit-reset']) * 1000;
  logExceptInTest('github_pr_maintenance_api', {
    installationId: input.installationId,
    appType: input.appType,
    endpoint: input.endpoint,
    reason: input.reason,
    calls: input.calls ?? 1,
    graphqlCost: input.graphqlCost ?? null,
    remaining: Number.isFinite(remaining) ? remaining : null,
  });
  if (
    Number.isFinite(limit) &&
    limit > 0 &&
    Number.isFinite(remaining) &&
    remaining / limit < 0.2 &&
    Number.isFinite(reset) &&
    reset > Date.now()
  ) {
    const digest = scopeDigest({ appType: input.appType, installationId: input.installationId });
    try {
      await redisClient.eval(DEFER_SCRIPT, [`${KEY_PREFIX}:low:${digest}`], [Date.now(), reset]);
    } catch {
      throw new PrMaintenanceDeferredError('unavailable', new Date(Date.now() + 60_000));
    }
  }
}
