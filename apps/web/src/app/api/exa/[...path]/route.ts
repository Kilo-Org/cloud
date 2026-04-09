import { NextResponse } from 'next/server';
import { type NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { EXA_API_KEY } from '@/lib/config.server';
import { after } from 'next/server';
import { wrapInSafeNextResponse } from '@/lib/llm-proxy-helpers';
import {
  getExaMonthlyUsage,
  getExaFreeAllowanceMicrodollars,
  recordExaUsage,
} from '@/lib/exa-usage';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { readDb } from '@/lib/drizzle';
import { captureException } from '@sentry/nextjs';

const EXA_BASE_URL = 'https://api.exa.ai';

const ALLOWED_PATHS = new Set(['/search', '/contents', '/findSimilar', '/answer', '/context']);

function extractExaPath(url: URL): string | null {
  const prefix = '/api/exa';
  if (!url.pathname.startsWith(prefix)) return null;
  const path = url.pathname.slice(prefix.length);
  return ALLOWED_PATHS.has(path) ? path : null;
}

function extractCostDollars(responseBody: unknown): number | undefined {
  const body = responseBody as { costDollars?: { total?: number } } | null;
  return body?.costDollars?.total;
}

export async function POST(request: NextRequest) {
  const { user, authFailedResponse, organizationId } = await getUserFromAuth({
    adminOnly: false,
  });
  if (authFailedResponse) return authFailedResponse;

  const url = new URL(request.url);
  const exaPath = extractExaPath(url);
  if (!exaPath) {
    return NextResponse.json(
      { error: `Invalid path. Allowed: ${[...ALLOWED_PATHS].join(', ')}` },
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
    const { balance } = await getBalanceAndOrgSettings(organizationId, user, readDb);
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
  const requestBody: Record<string, unknown> = await request.json();
  delete requestBody.stream;

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
  after(async () => {
    if (response.status >= 400) {
      return;
    }

    try {
      const body: unknown = await cloned.json();
      const costDollars = extractCostDollars(body);
      if (costDollars !== undefined && costDollars > 0) {
        const costMicrodollars = Math.round(costDollars * 1_000_000);
        await recordExaUsage({
          userId: user.id,
          organizationId,
          path: exaPath,
          costMicrodollars,
          chargedToBalance: isPaidRequest,
          freeAllowanceMicrodollars: allowance,
        });
      }
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
    }
  });

  return wrapInSafeNextResponse(response);
}
