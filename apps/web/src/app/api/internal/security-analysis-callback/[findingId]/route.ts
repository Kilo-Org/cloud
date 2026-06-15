import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { CALLBACK_TOKEN_SECRET, SECURITY_AUTO_ANALYSIS_WORKER_URL } from '@/lib/config.server';
import { verifyCallbackToken } from '@kilocode/worker-utils/callback-token';
import { z } from 'zod';

const ExecutionCallbackPayloadSchema = z.object({
  sessionId: z.string(),
  cloudAgentSessionId: z.string(),
  executionId: z.string(),
  status: z.enum(['completed', 'failed', 'interrupted']),
  errorMessage: z.string().optional(),
  kiloSessionId: z.string().optional(),
  lastSeenBranch: z.string().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ findingId: string }> }
) {
  try {
    const { findingId } = await params;
    const attemptToken = req.nextUrl.searchParams.get('attempt');
    if (!attemptToken) {
      return NextResponse.json({ error: 'Missing callback attempt token' }, { status: 400 });
    }

    const callbackToken = req.headers.get('X-Callback-Token');
    const validCallbackToken =
      !!CALLBACK_TOKEN_SECRET &&
      (await verifyCallbackToken({
        token: callbackToken,
        secret: CALLBACK_TOKEN_SECRET,
        scope: 'security-analysis-callback',
        resourceParts: [findingId, attemptToken],
      }));
    if (!validCallbackToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!SECURITY_AUTO_ANALYSIS_WORKER_URL) {
      return NextResponse.json(
        { error: 'Security analysis Worker is not configured' },
        { status: 503 }
      );
    }

    const rawPayload: unknown = await req.json();
    const parsedPayload = ExecutionCallbackPayloadSchema.safeParse(rawPayload);
    if (!parsedPayload.success) {
      return NextResponse.json({ error: 'Invalid callback payload' }, { status: 400 });
    }

    const workerResponse = await fetch(
      `${SECURITY_AUTO_ANALYSIS_WORKER_URL}/internal/security-analysis-callback/${findingId}?attempt=${encodeURIComponent(attemptToken)}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Callback-Token': callbackToken ?? '',
        },
        body: JSON.stringify(parsedPayload.data),
      }
    );
    const workerBody: unknown = await workerResponse.json();
    return NextResponse.json(workerBody, { status: workerResponse.status });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Failed to admit callback',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
