import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { modelsByProvider } from '@kilocode/db';
import { desc } from 'drizzle-orm';
import type * as z from 'zod';
import { OpenRouterProvidersResponseSchema } from '@kilocode/web-shared/lib/organizations/organization-types';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { getDirectByokProviderListings } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';

type ProviderListEntry = z.infer<typeof OpenRouterProvidersResponseSchema>['data'][number];

/**
 * Appends direct BYOK providers that the snapshot lacks. They stay out of the
 * snapshot so they do not appear in the provider policy UI.
 */
export function withDirectByokProviders(
  providers: ReadonlyArray<ProviderListEntry>,
  directByokProviders: ReadonlyArray<ProviderListEntry> = getDirectByokProviderListings()
): ProviderListEntry[] {
  const slugs = new Set(providers.map(provider => provider.slug));
  return [...providers, ...directByokProviders.filter(provider => !slugs.has(provider.slug))].sort(
    (a, b) => a.name.localeCompare(b.name)
  );
}

const getProviders = createCachedFetch(
  async () => {
    const [row] = await readDb
      .select({ data: modelsByProvider.data })
      .from(modelsByProvider)
      .orderBy(desc(modelsByProvider.id))
      .limit(1);
    if (!row) return null;
    return withDirectByokProviders(
      OpenRouterProvidersResponseSchema.shape.data.parse(row.data.providers)
    );
  },
  600_000,
  null
);

/**
 * Test using:
 * curl -vvv 'http://localhost:3000/api/openrouter/providers'
 */
export async function handleProvidersRequest(): Promise<NextResponse> {
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
