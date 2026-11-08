/**
 * Internal API Endpoint: Code Review Usage Data
 *
 * Called by the Code Review Orchestrator after SSE stream processing completes.
 * Persists accumulated LLM usage data (model, tokens, cost) on the review record.
 *
 * URL: POST /api/internal/code-review-usage/{reviewId}
 * Protected by internal API secret
 */

import { authorizeInternalApiRequest } from '@/lib/internal-api-auth';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { settleCodeReviewUsage, getCodeReviewById } from '@/lib/code-reviews/db/code-reviews';
import { logExceptInTest, errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { captureException } from '@sentry/nextjs';

// The token and cost columns are PostgreSQL `integer`, so a larger value fails the
// write. These caps stay below that ceiling and above any real review, including a
// council run that sums several specialists. The model cap matches the review
// configuration's `model_slug` limit, so a configured model always passes here.
const MAX_REVIEW_MODEL_LENGTH = 512;
const MAX_REVIEW_TOTAL_TOKENS_IN = 200_000_000;
const MAX_REVIEW_TOTAL_TOKENS_OUT = 50_000_000;
const MAX_REVIEW_TOTAL_COST_USD = 2_000;

const UsagePayloadSchema = z.object({
  model: z.string().max(MAX_REVIEW_MODEL_LENGTH).optional(),
  totalTokensIn: z.number().int().nonnegative().max(MAX_REVIEW_TOTAL_TOKENS_IN).optional(),
  totalTokensOut: z.number().int().nonnegative().max(MAX_REVIEW_TOTAL_TOKENS_OUT).optional(),
  totalCost: z.number().nonnegative().max(MAX_REVIEW_TOTAL_COST_USD).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ reviewId: string }> }
) {
  try {
    const unauthorized = authorizeInternalApiRequest(req);
    if (unauthorized) return unauthorized;

    const { reviewId } = await params;
    const rawPayload = await req.json();
    const parseResult = UsagePayloadSchema.safeParse(rawPayload);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Invalid payload', details: parseResult.error.flatten() },
        { status: 400 }
      );
    }
    const payload = parseResult.data;

    logExceptInTest('[code-review-usage] Received usage data', {
      reviewId,
      model: payload.model,
      totalTokensIn: payload.totalTokensIn,
      totalTokensOut: payload.totalTokensOut,
      totalCost: payload.totalCost,
    });

    const review = await getCodeReviewById(reviewId);
    if (!review) {
      return NextResponse.json({ error: 'Review not found' }, { status: 404 });
    }

    // Convert cost from dollars to microdollars (1 dollar = 1,000,000 microdollars)
    const totalCostMusd =
      typeof payload.totalCost === 'number' ? Math.round(payload.totalCost * 1_000_000) : undefined;

    const stored = await settleCodeReviewUsage(reviewId, {
      model: payload.model,
      totalTokensIn: payload.totalTokensIn,
      totalTokensOut: payload.totalTokensOut,
      totalCostMusd: totalCostMusd,
    });

    // Each metered value is recorded once. A repeated or late callback keeps the
    // stored values, fills only totals that are still missing, and still
    // succeeds, so the caller has nothing to retry.
    logExceptInTest('[code-review-usage] Usage data settled', { reviewId, stored });

    return NextResponse.json({ success: true });
  } catch (error) {
    errorExceptInTest('[code-review-usage] Error processing usage data:', error);
    captureException(error, {
      tags: { source: 'code-review-usage-api' },
    });

    return NextResponse.json(
      {
        error: 'Failed to process usage data',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
