import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import type * as z from 'zod';
import { OpenRouterProvidersResponseSchema } from '@kilocode/web-shared/lib/organizations/organization-types';
import { getModelsByProviderSnapshot } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-snapshot.server';
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

const getProviders = async (): Promise<ProviderListEntry[] | null> => {
  const snapshot = await getModelsByProviderSnapshot();
  if (snapshot === null) return null;
  return withDirectByokProviders(
    OpenRouterProvidersResponseSchema.shape.data.parse(snapshot.providers)
  );
};

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
