import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import type { OpenRouterModelsResponse } from '@/lib/organizations/organization-types';
import { getEnhancedOpenRouterModels } from '@/lib/ai-gateway/providers/openrouter';
import { getUserFromAuth } from '@/lib/user/server';
import { getDirectByokModelsForUser } from '@/lib/ai-gateway/providers/direct-byok';
import { getAvailableModelsForOrganization } from '@/lib/organizations/organization-models';
import { FEATURE_HEADER, validateFeatureHeader } from '@/lib/feature-detection';
import { filterByFeature } from '@/lib/ai-gateway/models';
import { listAvailableExperimentModels } from '@/lib/ai-gateway/experiments/list-available-experiment-models';
import { addUserByokAvailability, getUserByokProviderIds } from '@/lib/ai-gateway/byok';
import { readDb } from '@/lib/drizzle';
import { addAutoRoutingModels } from '@/lib/ai-gateway/auto-routing-models';

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
  request: NextRequest
): Promise<NextResponse<{ error: string; message?: string } | OpenRouterModelsResponse>> {
  const feature = validateFeatureHeader(request.headers.get(FEATURE_HEADER));
  const auth = await tryGetUserFromAuth();
  try {
    const result = auth?.organizationId
      ? await getAvailableModelsForOrganization(auth.organizationId)
      : null;
    if (result) {
      return NextResponse.json({
        ...result,
        data: await addAutoRoutingModels(filterByFeature(result.data, feature)),
      });
    }

    const data = await getEnhancedOpenRouterModels();
    if (!Array.isArray(data.data)) {
      return NextResponse.json(data);
    }
    const models = await addAutoRoutingModels(filterByFeature(data.data, feature));
    if (!auth?.user) {
      const experimentModels = await listAvailableExperimentModels();
      return NextResponse.json({
        data: models.concat(filterByFeature(experimentModels, feature)),
      });
    }

    const [byokModels, experimentModels, enabledByokProviderIds] = await Promise.all([
      getDirectByokModelsForUser(auth.user.id),
      listAvailableExperimentModels(),
      getUserByokProviderIds(readDb, auth.user.id),
    ]);
    const modelsWithByokAvailability = await addUserByokAvailability(
      models,
      enabledByokProviderIds
    );
    return NextResponse.json({
      data: modelsWithByokAvailability.concat(
        filterByFeature(byokModels, feature),
        filterByFeature(experimentModels, feature)
      ),
    });
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
