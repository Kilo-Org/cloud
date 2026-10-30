import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import type * as z from 'zod';
import { OpenRouterProvidersResponseSchema } from '@kilocode/web-shared/lib/organizations/organization-types';
import { getModelsByProviderSnapshot } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-snapshot.server';
import type { NormalizedOpenRouterResponse } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';
import { getDirectByokProviderListings } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';

type ProviderListEntry = z.infer<typeof OpenRouterProvidersResponseSchema>['data'][number];

/**
 * Appends direct BYOK providers that the snapshot lacks. They stay out of the
 * snapshot because Kilo's own routes use it; the provider policy screens add
 * them separately (see `getDirectByokPolicyProviders`).
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

/** Parsed providers for one snapshot; `null` marks a snapshot that failed validation. */
const compiledProviders = new WeakMap<NormalizedOpenRouterResponse, ProviderListEntry[] | null>();

/**
 * Validates one snapshot and merges the direct BYOK listings. The snapshot cache
 * hands out the same object until it refreshes, so both the parse and the report
 * of a validation failure happen once per snapshot instead of once per request.
 */
function compileProviders(snapshot: NormalizedOpenRouterResponse): ProviderListEntry[] | null {
  const compiled = compiledProviders.get(snapshot);
  if (compiled !== undefined) return compiled;

  let result: ProviderListEntry[] | null;
  try {
    result = withDirectByokProviders(
      OpenRouterProvidersResponseSchema.shape.data.parse(snapshot.providers)
    );
  } catch (error) {
    captureException(error, {
      tags: { endpoint: 'openrouter/providers' },
      extra: {
        action: 'validating_providers',
      },
    });
    result = null;
  }
  compiledProviders.set(snapshot, result);
  return result;
}

/**
 * Test using:
 * curl -vvv 'http://localhost:3000/api/openrouter/providers'
 */
export async function handleProvidersRequest(): Promise<NextResponse> {
  try {
    const snapshot = await getModelsByProviderSnapshot();
    if (snapshot === null) {
      return NextResponse.json(
        { error: 'Service Unavailable', message: 'Providers data not yet available' },
        { status: 503 }
      );
    }
    const data = compileProviders(snapshot);
    if (data === null) {
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to fetch providers' },
        { status: 500 }
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
