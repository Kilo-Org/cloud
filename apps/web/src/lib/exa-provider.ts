import 'server-only';
import { NextResponse } from 'next/server';
import type { User } from '@kilocode/db/schema';
import { captureException } from '@sentry/nextjs';
import { z } from 'zod';
import { EXA_API_KEY } from '@/lib/config.server';
import { readDb } from '@/lib/drizzle';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { getExaMonthlyUsage, getExaFreeAllowanceMicrodollars, recordExaUsage } from './exa-usage';
import type { ExaAllowedPath } from './exa-paths';

const ExaCostResponseSchema = z.object({
  costDollars: z.object({ total: z.number().finite().optional() }).optional(),
});
export function extractExaCostMicrodollars(responseBody: unknown): number | undefined {
  const costDollars = ExaCostResponseSchema.parse(responseBody).costDollars?.total;
  // Keep explicit zero distinct from unknown cost; neither creates a legacy usage charge.
  if (costDollars === undefined || costDollars === 0) return costDollars;
  if (costDollars < 0) throw new Error('Exa response costDollars.total must be positive.');
  const costMicrodollars = Math.round(costDollars * 1_000_000);
  if (!Number.isSafeInteger(costMicrodollars) || costMicrodollars <= 0) {
    throw new Error('Exa response cost must convert to a positive safe integer.');
  }
  return costMicrodollars;
}

/** Call only with a freshly authorized user and context, never model-supplied identity. */
export async function prepareExaRequest(user: User, organizationId: string | undefined) {
  if (!EXA_API_KEY) {
    captureException(new Error('EXA_API_KEY is not configured'));
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
  // Preserve the proxy's replica-based monthly allowance and balance checks.
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
  return {
    async send(
      path: ExaAllowedPath,
      body: Record<string, unknown>,
      signal: AbortSignal,
      jsonOnly = false
    ) {
      const response = await fetch(`https://api.exa.ai${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': EXA_API_KEY,
          ...(jsonOnly ? { Accept: 'application/json' } : {}),
        },
        body: JSON.stringify(body),
        signal,
        // Old proxy callers retain redirect behavior until that public contract retires.
        ...(jsonOnly ? { redirect: 'error' as const } : {}),
      });
      if (response.status >= 400) {
        console.error(
          `[exa] upstream error: status=${response.status} user=${user.id} path=${path}`
        );
      }
      return response;
    },
    async record(
      path: ExaAllowedPath,
      costMicrodollars: number | undefined,
      featureId?: string,
      type?: string
    ) {
      if (!costMicrodollars) return;
      await recordExaUsage({
        userId: user.id,
        organizationId,
        path,
        costMicrodollars,
        chargedToBalance: isPaidRequest,
        freeAllowanceMicrodollars: allowance,
        featureId,
        type,
      });
    },
  };
}
