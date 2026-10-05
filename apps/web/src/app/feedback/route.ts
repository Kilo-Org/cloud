import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import * as z from 'zod';
import { FeedbackFor, FeedbackSource } from '@/lib/feedback/enums';
import { isFeedbackRateLimitError, submitUserFeedback } from '@/lib/feedback/submit';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';

/**
 * HTTP twin of the `feedback.submit` tRPC mutation. An authenticated agent
 * posts feedback or a bug report here; the submission lands in the same
 * `user_feedback` store and shares the same per-user limit. Unauthenticated
 * callers get 401, a caller inside the rolling window gets 429 with the
 * batch-into-one-submission message.
 */
const SubmitFeedbackRequestSchema = z.object({
  feedback_text: z.string().optional().default(''),
  feedback_for: z.string().min(1).default(FeedbackFor.Unknown),
  feedback_batch: z.string().min(1).optional(),
  source: z.string().min(1).default(FeedbackSource.Web),
  context_json: z.record(z.string(), z.unknown()).default({}),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (!user) return authFailedResponse;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = SubmitFeedbackRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid feedback submission' }, { status: 400 });
  }

  try {
    const { id } = await submitUserFeedback({
      userId: user.id,
      feedbackText: parsed.data.feedback_text,
      feedbackFor: parsed.data.feedback_for,
      feedbackBatch: parsed.data.feedback_batch,
      source: parsed.data.source,
      contextJson: parsed.data.context_json,
    });
    return NextResponse.json({ id }, { status: 200 });
  } catch (error) {
    if (isFeedbackRateLimitError(error)) {
      return NextResponse.json(
        { error: error.message },
        {
          status: 429,
          headers: { 'Retry-After': String(Math.ceil(error.retryAfterMs / 1000)) },
        }
      );
    }
    throw error;
  }
}
