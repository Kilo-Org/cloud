import { NextResponse } from 'next/server';
import { CustomRouterPoolPinsRequestSchema } from '@kilocode/auto-routing-contracts';
import { PoolPinsRouterNotFoundError, applyServingPins } from '@/lib/auto-routing-pool-pins';
import { authorizeInternalApiRequest } from '@/lib/internal-api-auth';

/**
 * Serving-pin settlement callback for the auto-routing benchmark worker. The worker confirmed a
 * paid request for a saved pool and reports the aliases whose target now has a usable measurement;
 * the web writes each pin into the pool's JSONB entries. Internal secret only, never a user call.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const unauthorized = await authorizeInternalApiRequest(request);
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = CustomRouterPoolPinsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid pool pins request', issues: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    return NextResponse.json(await applyServingPins(parsed.data));
  } catch (error) {
    if (error instanceof PoolPinsRouterNotFoundError) {
      return NextResponse.json({ error: 'Custom router not found' }, { status: 404 });
    }
    console.error('pool pins settlement failed', error);
    return NextResponse.json({ error: 'Pool pins settlement failed' }, { status: 500 });
  }
}
