import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createRedisCachedFetch } from '@/lib/cached-fetch';
import { captureException } from '@sentry/nextjs';
import type { OpenRouterProvider } from '@/lib/organizations/organization-types';

// Cache the providers fetch for 24 hours
const getCachedProviders = createRedisCachedFetch(
  'openrouter:providers',
  async () => {
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

    return response.json() as Promise<OpenRouterProvider[]>;
  },
  86_400_000
);

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
