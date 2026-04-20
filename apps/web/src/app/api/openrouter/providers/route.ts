import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { redisGet } from '@/lib/redis';
import { GATEWAY_METADATA_REDIS_KEYS } from '@/lib/redis-keys';

/**
 * Test using:
 * curl -vvv 'http://localhost:3000/api/openrouter/providers'
 */
export async function GET(_request: NextRequest): Promise<NextResponse> {
  const cached = await redisGet(GATEWAY_METADATA_REDIS_KEYS.openrouterProviders);
  if (!cached) {
    return NextResponse.json(
      { error: 'Service Unavailable', message: 'Providers data not available' },
      { status: 503 }
    );
  }
  return NextResponse.json(JSON.parse(cached) as unknown);
}
