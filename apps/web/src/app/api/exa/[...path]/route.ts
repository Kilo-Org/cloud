import { NextResponse } from 'next/server';
import { type NextRequest } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { EXA_API_KEY } from '@kilocode/web-shared/lib/config.server';
import { after } from 'next/server';
import { wrapInSafeNextResponse } from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import {
  getExaMonthlyUsage,
  getExaFreeAllowanceMicrodollars,
  recordExaUsage,
} from '@/lib/exa-usage';
import { getBalanceAndOrgSettings } from '@kilocode/web-shared/lib/organizations/organization-usage';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { captureException } from '@sentry/nextjs';
import { describeDatabaseError } from '@kilocode/web-shared/lib/ai-gateway/usage-record-diagnostics';
import { validateFeatureHeader, FEATURE_HEADER } from '@kilocode/web-shared/lib/feature-detection';
import { buildExaUsageRecord } from '@/lib/exa-usage-record';
import {
  isExaUsageQueueFallbackAvailable,
  queueExaUsageAfterFailedWrite,
} from '@/lib/exa-usage-fallback';
import {
  EXA_ALLOWED_PATHS,
  isExaAllowedPath,
  type ExaAllowedPath,
  type ExaUsageRecord,
} from '@kilocode/usage-contracts';
import { z } from 'zod';

const EXA_BASE_URL = 'https://api.exa.ai';
const MICRODOLLARS_PER_DOLLAR = 1_000_000;
const EXA_PUBLICATION_RESERVE_MS = 45_000;
const WRITE_DEADLINE_MESSAGE = 'Exa usage write exceeded the invocation deadline.';

/** The write was never attempted because the remaining invocation budget was already spent. */
class ExaUsageWriteSkippedError extends Error {
  constructor() {
    super(WRITE_DEADLINE_MESSAGE);
    this.name = 'ExaUsageWriteSkippedError';
  }
}

/**
 * The function limit covers the whole invocation, including the upstream Exa request and the
 * `after()` work. That work can wait out the writer's 120-second statement timeout and then
 * spend up to 40 seconds publishing the same record, so this leaves about 140 seconds for the
 * request itself. It is a bound, not an end-to-end guarantee.
 */
export const maxDuration = 300;

const ExaCostResponseSchema = z.object({
  costDollars: z
    .object({
      total: z.number().finite().optional(),
    })
    .optional(),
});

function extractExaPath(url: URL): ExaAllowedPath | null {
  const prefix = '/api/exa';
  if (!url.pathname.startsWith(prefix)) return null;
  const path = url.pathname.slice(prefix.length);
  return isExaAllowedPath(path) ? path : null;
}

function extractCostMicrodollars(responseBody: unknown): number | undefined {
  const costDollars = ExaCostResponseSchema.parse(responseBody).costDollars?.total;
  if (costDollars === undefined || costDollars === 0) return undefined;
  if (costDollars < 0) {
    throw new Error('Exa response costDollars.total must be positive.');
  }

  const costMicrodollars = Math.round(costDollars * MICRODOLLARS_PER_DOLLAR);
  if (!Number.isSafeInteger(costMicrodollars) || costMicrodollars <= 0) {
    throw new Error('Exa response cost must convert to a positive safe integer.');
  }
  return costMicrodollars;
}

/**
 * Bounds the direct write so the publication budget survives. The writer receives the remaining
 * budget as a transaction-local idle timeout, so a write abandoned at the deadline cannot stay
 * idle holding its connection and locks. A write that commits anyway is deduplicated by `id` and
 * `occurredAt` on the queued replay, so publishing the same record cannot charge twice.
 */
async function recordExaUsageWithinDeadline(record: ExaUsageRecord, remainingMs: number) {
  if (remainingMs <= 0) throw new ExaUsageWriteSkippedError();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = recordExaUsage(record, { deadlineMs: remainingMs });
  write.catch(() => {});
  try {
    return await Promise.race([
      write,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(WRITE_DEADLINE_MESSAGE)), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function POST(request: NextRequest) {
  const invocationStartedAt = performance.now();
  const { user, authFailedResponse, organizationId } = await getUserFromAuth({
    adminOnly: false,
    expectedAudience: KILO_GATEWAY_AUDIENCE,
  });
  if (authFailedResponse) return authFailedResponse;

  const url = new URL(request.url);
  const exaPath = extractExaPath(url);
  if (!exaPath) {
    return NextResponse.json(
      { error: `Invalid path. Allowed: ${EXA_ALLOWED_PATHS.join(', ')}` },
      { status: 400 }
    );
  }

  if (!EXA_API_KEY) {
    captureException(new Error('EXA_API_KEY is not configured'));

    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }

  // Check monthly allowance and balance.
  // freeAllowance is the stored value from the first request of the month;
  // null means no row yet, so we compute from the helper.
  // Use read replica for monthly usage check - this is a read-only operation that can tolerate
  // slight replication lag, and provides lower latency for US users
  const { usage: monthlyUsage, freeAllowance: storedAllowance } = await getExaMonthlyUsage(
    user.id,
    readDb
  );
  const allowance = storedAllowance ?? getExaFreeAllowanceMicrodollars(new Date(), user);
  const isPaidRequest = monthlyUsage >= allowance;

  if (isPaidRequest) {
    const { balance } = await getBalanceAndOrgSettings(organizationId, user, readDb, 'usage');
    if (balance <= 0) {
      return NextResponse.json(
        {
          error: 'Exa free allowance exhausted and no credit balance available',
          monthlyAllowance: `$${(allowance / 1_000_000).toFixed(2)}`,
          used: `$${(monthlyUsage / 1_000_000).toFixed(2)}`,
        },
        { status: 402 }
      );
    }
  }

  // Strip `stream` to guarantee JSON responses with costDollars for billing
  const rawBody = await request.text();
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof parsedBody !== 'object' || parsedBody === null || Array.isArray(parsedBody)) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const requestBody = parsedBody as Record<string, unknown>;
  delete requestBody.stream;

  const featureId = validateFeatureHeader(request.headers.get(FEATURE_HEADER)) ?? undefined;
  const type = typeof requestBody.type === 'string' ? requestBody.type : undefined;

  const response = await fetch(`${EXA_BASE_URL}${exaPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': EXA_API_KEY,
    },
    body: JSON.stringify(requestBody),
    signal: request.signal,
  });

  if (response.status >= 400) {
    console.error(
      `[exa] upstream error: status=${response.status} user=${user.id} path=${exaPath}`
    );
  }

  // Record cost asynchronously after sending the response
  const cloned = response.clone();
  const usageId = crypto.randomUUID();
  const occurredAt = new Date().toISOString();
  after(async () => {
    if (response.status >= 400) {
      return;
    }

    let record: ExaUsageRecord | undefined;
    try {
      const body: unknown = await cloned.json();
      const costMicrodollars = extractCostMicrodollars(body);
      if (costMicrodollars === undefined) return;

      record = buildExaUsageRecord({
        id: usageId,
        occurredAt,
        userId: user.id,
        organizationId,
        path: exaPath,
        costMicrodollars,
        chargedToBalance: isPaidRequest,
        freeAllowanceMicrodollars: allowance,
        featureId,
        type,
      });
      const publicationReserveMs = isExaUsageQueueFallbackAvailable()
        ? EXA_PUBLICATION_RESERVE_MS
        : 0;
      const writeBudgetMs =
        maxDuration * 1_000 - publicationReserveMs - (performance.now() - invocationStartedAt);
      await recordExaUsageWithinDeadline(record, writeBudgetMs);
    } catch (error) {
      captureException(error, {
        tags: {
          route: '/api/exa/[...path]',
          exaPath,
        },
        extra: {
          userId: user.id,
          responseStatus: response.status,
        },
      });
      const fallback =
        record === undefined ? undefined : await queueExaUsageAfterFailedWrite(record);
      const described = describeDatabaseError(error);
      const code =
        described.code !== null && /^[0-9A-Z]{5}$/.test(described.code) ? described.code : null;
      const stage =
        record === undefined
          ? 'cost_parse'
          : error instanceof ExaUsageWriteSkippedError
            ? 'write_skipped'
            : 'record_write';
      console.error('[exa] usage record failed; charge may be unrecorded', {
        exa_path: exaPath,
        payer_kind: organizationId ? 'organization' : 'personal',
        charged_to_balance: isPaidRequest,
        ...(record === undefined ? {} : { cost_microdollars: record.costMicrodollars }),
        stage,
        error:
          code === null
            ? {
                type:
                  error instanceof z.ZodError
                    ? 'validation'
                    : error instanceof SyntaxError
                      ? 'syntax'
                      : 'unknown',
              }
            : { type: 'database', code },
        ...fallback,
      });
    }
  });

  return wrapInSafeNextResponse(response);
}
