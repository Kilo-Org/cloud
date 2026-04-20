import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { OpenRouterProvidersResponseSchema } from '@/lib/organizations/organization-types';
import { createCachedFetch } from '@/lib/cached-fetch';
import { redisGet } from '@/lib/redis';
import { GATEWAY_METADATA_REDIS_KEYS } from '@/lib/redis-keys';

const getProviders = createCachedFetch(
  async () => {
    const raw = await redisGet(GATEWAY_METADATA_REDIS_KEYS.openrouterProviders);
    if (raw === null) return null;
    return OpenRouterProvidersResponseSchema.shape.data.parse(JSON.parse(raw));
  },
  60_000, // 60 seconds in-process TTL
  null
);

/**
 * Test using:
 * curl -vvv 'http://localhost:3000/api/openrouter/providers'
 */
export async function GET(_request: NextRequest): Promise<NextResponse> {
  try {
    const data = await getProviders();
    if (data === null) {
      return NextResponse.json(
        { error: 'Service Unavailable', message: 'Providers data not yet available' },
        { status: 503 }
      );
    }
    return NextResponse.json({ data });
  } catch (error) {
    captureException(error, {
      tags: { endpoint: 'openrouter/providers' },
      extra: {
        action: 'fetching_providers',
      },
    });
    return NextResponse.json(
      { error: 'Internal Server Error', message: 'Failed to fetch providers' },
      { status: 500 }
    );
  }
}
