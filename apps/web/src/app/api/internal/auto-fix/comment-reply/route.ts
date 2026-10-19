/**
 * Internal API Endpoint: Notify PR Review Comment Result (Auto Fix)
 *
 * Called by:
 * - Auto Fix Orchestrator (after a review-comment-triggered fix finishes)
 *
 * URL: POST /api/internal/auto-fix/comment-reply
 * Protected by internal API secret
 *
 * Core logic lives in handle-comment-reply.ts so the pr-callback route
 * can call it directly without a self-referencing HTTP fetch.
 */

import { authorizeInternalApiRequest } from '@/lib/internal-api-auth';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import {
  handleCommentReply,
  CommentReplyPayloadSchema,
} from '@/lib/auto-fix/github/handle-comment-reply';

export async function POST(req: NextRequest) {
  try {
    // Validate internal API secret
    const unauthorized = authorizeInternalApiRequest(req);
    if (unauthorized) return unauthorized;

    const raw: unknown = await req.json();
    const parsed = CommentReplyPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid payload', issues: parsed.error.issues },
        { status: 400 }
      );
    }
    const payload = parsed.data;
    const result = await handleCommentReply(payload);

    if (result.ok) {
      return NextResponse.json({ success: true, action: result.action });
    }

    return NextResponse.json({ error: result.error }, { status: result.status });
  } catch (error) {
    errorExceptInTest('[auto-fix-comment-reply] Error processing request:', error);
    captureException(error, {
      tags: { source: 'auto-fix-comment-reply-api' },
    });

    return NextResponse.json(
      {
        error: 'Failed to process request',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
