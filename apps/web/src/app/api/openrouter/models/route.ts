import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import type { OpenRouterModelsResponse } from '@/lib/organizations/organization-types';
import { getEnhancedOpenRouterModels } from '@/lib/providers/openrouter';
import { getUserFromAuth } from '@/lib/user.server';
import { getDirectByokModelsForUser } from '@/lib/providers/direct-byok';
import { unstable_cache } from 'next/cache';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';

const getDirectByokModelsForUser_cached = unstable_cache(
  (userId: string) => getDirectByokModelsForUser(userId),
  undefined,
  { revalidate: 60 }
);

async function getAuthContext() {
  try {
    return await getUserFromAuth({ adminOnly: false });
  } catch (e) {
    console.debug('[openrouter/models] error getting auth context, database unavailable?', e);
    return null;
  }
}

async function getDirectByokModels(userId: string) {
  try {
    console.debug('[getDirectByokModels] authenticated request, fetching direct byok models');
    return await getDirectByokModelsForUser_cached(userId);
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
  request: NextRequest
): Promise<NextResponse<{ error: string; message?: string } | OpenRouterModelsResponse>> {
  const auth = await getAuthContext();

  if (auth?.organizationId) {
    const { organizationId } = auth;
    return handleTRPCRequest<OpenRouterModelsResponse>(request, async caller => {
      return caller.organizations.settings.listAvailableModels({ organizationId });
    });
  }

  try {
    const data = await getEnhancedOpenRouterModels();
    if (!Array.isArray(data.data)) {
      return NextResponse.json(data);
    }
    const byokModels = auth?.user ? await getDirectByokModels(auth.user.id) : [];
    return NextResponse.json({ data: data.data.concat(byokModels) });
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
