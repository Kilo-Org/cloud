import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { NormalizedOpenRouterResponse } from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import { redisGet } from '@/lib/redis';
import { GATEWAY_METADATA_REDIS_KEYS } from '@/lib/redis-keys';

/**
 * Test using:
 * curl -vvv 'http://localhost:3000/api/openrouter/providers'
 */
export async function GET(_request: NextRequest): Promise<NextResponse> {
  const raw = await redisGet(GATEWAY_METADATA_REDIS_KEYS.allProviders);
  if (raw === null) {
    captureException(new Error('OpenRouter providers not yet synced to Redis'), {
      tags: { endpoint: 'openrouter/providers' },
    });
    return NextResponse.json(
      { error: 'Service Unavailable', message: 'Provider data not yet available' },
      { status: 503 }
    );
  }
  const data = NormalizedOpenRouterResponse.parse(JSON.parse(raw));
  return NextResponse.json(data);
}
