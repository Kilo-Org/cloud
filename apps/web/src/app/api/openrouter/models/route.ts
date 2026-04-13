import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import type { OpenRouterModelsResponse } from '@/lib/organizations/organization-types';
import { getEnhancedOpenRouterModels } from '@/lib/providers/openrouter';
import { getUserFromAuth } from '@/lib/user.server';
import { getDirectByokModelsForUser } from '@/lib/providers/direct-byok';
import { unstable_cache } from 'next/cache';
import { getAvailableModelsForOrganization } from '@/lib/organizations/organization-models';

const getDirectByokModels = unstable_cache(
  (userId: string) => getDirectByokModelsForUser(userId),
  undefined,
  { revalidate: 60 }
);

async function tryGetUserFromAuth() {
  try {
    return await getUserFromAuth({ adminOnly: false });
  } catch (e) {
    console.error('[tryGetUserFromAuth] failed to get user from auth', e);
    return { user: null, organizationId: null };
  }
}

/**
 * Test using:
 * curl -vvv 'http://localhost:3000/api/openrouter/models'
 */
export async function GET(
  _request: NextRequest
): Promise<NextResponse<{ error: string; message?: string } | OpenRouterModelsResponse>> {
  const auth = await tryGetUserFromAuth();
  try {
    const result = auth?.organizationId
      ? await getAvailableModelsForOrganization(auth.organizationId)
      : null;
    if (result) {
      return NextResponse.json(result);
    }

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
        userId: auth?.user?.id,
        organizationId: auth?.organizationId,
      },
    });
    return NextResponse.json(
      { error: 'Failed to fetch models', message: 'Error from OpenRouter API' },
      { status: 500 }
    );
  }
}
