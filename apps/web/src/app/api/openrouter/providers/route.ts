import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { redisGet, redisSet } from '@/lib/redis';
import { captureException } from '@sentry/nextjs';
import type { OpenRouterProvider } from '@/lib/organizations/organization-types';

export const revalidate = 86400; // 24 hours

const OPENROUTER_PROVIDERS_REDIS_KEY = 'openrouter:providers';
const OPENROUTER_PROVIDERS_TTL = 86400;

async function getCachedProviders() {
  try {
    const cached = await redisGet(OPENROUTER_PROVIDERS_REDIS_KEY);
    if (cached) {
      return JSON.parse(cached) as OpenRouterProvider[];
    }
  } catch {
    // fall through to fetch
  }

  const response = await fetch('https://openrouter.ai/api/frontend/all-providers', {
    method: 'GET',
  });

  if (!response.ok) {
    const errorMessage = `Failed to fetch OpenRouter providers: ${response.status} ${response.statusText}`;
    captureException(new Error(errorMessage), {
      tags: { endpoint: 'openrouter/providers', source: 'openrouter_public_api' },
      extra: {
        status: response.status,
        statusText: response.statusText,
      },
    });
    throw new Error(errorMessage);
  }

  const data = (await response.json()) as OpenRouterProvider[];
  try {
    await redisSet(OPENROUTER_PROVIDERS_REDIS_KEY, JSON.stringify(data), OPENROUTER_PROVIDERS_TTL);
  } catch {
    // ignore cache write failures
  }
  return data;
}

/**
 * Test using:
 * curl -vvv 'http://localhost:3000/api/openrouter/providers'
 */
export async function GET(_request: NextRequest): Promise<NextResponse> {
  try {
    const data = await getCachedProviders();
    return NextResponse.json(data);
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
