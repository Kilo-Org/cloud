import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { claimAndDispatchCodeReviewSandboxRetries } from '@/lib/code-reviews/sandbox-retry';
import { errorExceptInTest } from '@/lib/utils.server';
import { captureException } from '@sentry/nextjs';

const PayloadSchema = z.object({
  sandboxId: z.string().min(1),
  triggeringSessionId: z.string().optional(),
  phase: z.string().min(1),
  reason: z.literal('sandbox_500'),
  destroyedAt: z.string().datetime().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const secret = req.headers.get('X-Internal-Secret');
    if (!INTERNAL_API_SECRET || secret !== INTERNAL_API_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const parsed = PayloadSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
    }

    const result = await claimAndDispatchCodeReviewSandboxRetries({
      sandboxId: parsed.data.sandboxId,
      destroyedAt: parsed.data.destroyedAt,
      source: 'cloud-agent-next-notification',
    });

    return NextResponse.json(result);
  } catch (error) {
    captureException(error, { tags: { source: 'code-review-sandbox-destroyed' } });
    errorExceptInTest('[code-review-sandbox-destroyed] Error processing notification', error);
    return NextResponse.json({ error: 'Failed to process sandbox destruction' }, { status: 500 });
  }
}
