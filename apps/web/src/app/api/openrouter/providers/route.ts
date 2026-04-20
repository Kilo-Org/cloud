import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { redisGet } from '@/lib/redis';
import { GATEWAY_METADATA_REDIS_KEYS } from '@/lib/redis-keys';
import { OpenRouterApiProvidersResponse } from '@/lib/ai-gateway/providers/openrouter/openrouter-types';

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
  const { data } = OpenRouterApiProvidersResponse.parse(JSON.parse(cached));
  // The v1 API omits displayName; derive it from name for consumer compatibility.
  return NextResponse.json({ data: data.map(p => ({ ...p, displayName: p.name })) });
}
