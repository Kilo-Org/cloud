import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { modelsByProvider } from '@kilocode/db';
import { desc } from 'drizzle-orm';
import { OpenRouterProvidersResponseSchema } from '@/lib/organizations/organization-types';
import { createCachedFetch } from '@/lib/cached-fetch';
import { readDb } from '@/lib/drizzle';

const getProviders = createCachedFetch(
  async () => {
    const [row] = await readDb
      .select({ data: modelsByProvider.data })
      .from(modelsByProvider)
      .orderBy(desc(modelsByProvider.id))
      .limit(1);
    if (!row) return null;
    return OpenRouterProvidersResponseSchema.shape.data.parse(row.data.providers);
  },
  600_000,
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
