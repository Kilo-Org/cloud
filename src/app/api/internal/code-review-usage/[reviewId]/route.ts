/**
 * Internal API Endpoint: Code Review Usage Data
 *
 * Called by the Code Review Orchestrator after SSE stream processing completes.
 * Persists accumulated LLM usage data (model, tokens, cost) on the review record.
 *
 * URL: POST /api/internal/code-review-usage/{reviewId}
 * Protected by internal API secret
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { updateCodeReviewStatus, getCodeReviewById } from '@/lib/code-reviews/db/code-reviews';
import { CodeReviewStatusSchema } from '@/lib/code-reviews/core/schemas';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';
import { captureException } from '@sentry/nextjs';
import { INTERNAL_API_SECRET } from '@/lib/config.server';

const UsagePayloadSchema = z.object({
  model: z.string().optional(),
  totalTokensIn: z.number().int().nonnegative().optional(),
  totalTokensOut: z.number().int().nonnegative().optional(),
  totalCost: z.number().nonnegative().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ reviewId: string }> }
) {
  try {
    const secret = req.headers.get('X-Internal-Secret');
    if (secret !== INTERNAL_API_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

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

    // Persist usage data on the review record.
    // We pass the current status (no status change) to just update the usage fields.
    const status = CodeReviewStatusSchema.parse(review.status);

    await updateCodeReviewStatus(reviewId, status, {
      model: payload.model,
      totalTokensIn: payload.totalTokensIn,
      totalTokensOut: payload.totalTokensOut,
      totalCostMusd: totalCostMusd,
    });

    logExceptInTest('[code-review-usage] Persisted usage data', { reviewId });

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
