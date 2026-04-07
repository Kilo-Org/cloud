import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import type { OpenRouterModelsResponse } from '@/lib/organizations/organization-types';
import { getEnhancedOpenRouterModels } from '@/lib/providers/openrouter';
import { getUserFromAuth } from '@/lib/user.server';
import { getDirectByokModelsForUser } from '@/lib/providers/direct-byok';
import { unstable_cache } from 'next/cache';

const getDirectByokModelsForUser_cached = unstable_cache(
  (userId: string) => getDirectByokModelsForUser(userId),
  undefined,
  { revalidate: 60 }
);

async function getDirectByokModels() {
  try {
    const { user } = await getUserFromAuth({ adminOnly: false });
    if (user) {
      console.debug('[getDirectByokModels] authenticated request, fetching direct byok models');
      return await getDirectByokModelsForUser_cached(user.id);
    } else {
      console.debug('[getDirectByokModels] anonymous request, no direct byok models');
      return [];
    }
  } catch (e) {
    console.debug('[getDirectByokModels] error, database unavailable?', e);
    return [];
  }
}

/**
 * Test using:
 * curl -vvv 'http://localhost:3000/api/openrouter/models'
 */
export async function GET(
  _request: NextRequest
): Promise<NextResponse<{ error: string; message: string } | OpenRouterModelsResponse>> {
  try {
    const data = await getEnhancedOpenRouterModels();
    return NextResponse.json(
      Array.isArray(data.data) ? { data: data.data.concat(await getDirectByokModels()) } : data
    );
  } catch (error) {
    captureException(error, {
      tags: { endpoint: 'openrouter/models' },
      extra: {
        action: 'fetching_models',
      },
    });
    return NextResponse.json(
      { error: 'Failed to fetch models', message: 'Error from OpenRouter API' },
      { status: 500 }
    );
  }
}
