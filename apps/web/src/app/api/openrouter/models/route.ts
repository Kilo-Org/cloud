import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import type { OpenRouterModelsResponse } from '@/lib/organizations/organization-types';
import { getEnhancedOpenRouterModels } from '@/lib/ai-gateway/providers/openrouter';
import { getUserFromAuth } from '@/lib/user/server';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { getDirectByokModelsForUser } from '@/lib/ai-gateway/providers/direct-byok';
import { getAvailableModelsForOrganization } from '@/lib/organizations/organization-models';
import { listAvailableExperimentModels } from '@/lib/ai-gateway/experiments/list-available-experiment-models';
import { addUserByokAvailability, getUserByokProviderIds } from '@/lib/ai-gateway/byok';
import { readDb } from '@/lib/drizzle';
import { addAutoRoutingModels } from '@/lib/ai-gateway/auto-routing-models';
import { appendLocalFakeDeterministicCatalogModels } from '@/lib/ai-gateway/local-fake-llm';
import { getEnkryptBenchmarks, publishEnkryptModels } from '@/lib/model-stats/enkrypt';

async function modelResponse(response: OpenRouterModelsResponse) {
  const snapshot = await getEnkryptBenchmarks();
  return NextResponse.json({
    ...response,
    data: publishEnkryptModels(response.data, snapshot),
  });
}

async function tryGetUserFromAuth() {
  try {
    return await getUserFromAuth({
      adminOnly: false,
      expectedAudience: KILO_GATEWAY_AUDIENCE,
    });
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
    const result =
      auth?.organizationId && auth.user
        ? await getAvailableModelsForOrganization(auth.organizationId, {
            type: 'member',
            kiloUserId: auth.user.id,
          })
        : null;
    if (result) {
      return await modelResponse({
        ...result,
        data: await addAutoRoutingModels(result.data),
      });
    }

    const data = await getEnhancedOpenRouterModels();
    if (!Array.isArray(data.data)) {
      return NextResponse.json(data);
    }
    const models = await addAutoRoutingModels(data.data);
    if (!auth?.user) {
      const experimentModels = await listAvailableExperimentModels();
      return await modelResponse({
        data: appendLocalFakeDeterministicCatalogModels(models.concat(experimentModels)),
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
    return await modelResponse({
      data: appendLocalFakeDeterministicCatalogModels(
        modelsWithByokAvailability.concat(byokModels, experimentModels)
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
