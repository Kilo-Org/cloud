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
import { getBenchmarkRoutingTable } from '@/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { KILO_AUTO_EFFICIENT_MODEL, KILO_AUTO_FREE_MODEL } from '@/lib/ai-gateway/auto-model';
import { getAutoFreeCandidates } from '@/lib/ai-gateway/auto-model/resolution';
import { isVirtualAutoModelId } from '@kilocode/auto-routing-contracts';

async function tryGetUserFromAuth() {
  try {
    return await getUserFromAuth({ adminOnly: false });
  } catch (e) {
    console.error('[tryGetUserFromAuth] failed to get user from auth', e);
    return { user: null, organizationId: null };
  }
}

async function addAutoRoutingModels(models: OpenRouterModelsResponse['data']) {
  const availableModelIds = new Set(models.map(model => model.id));
  const [routingTableResult, autoFreeCandidates] = await Promise.all([
    getBenchmarkRoutingTable().catch(() => null),
    getAutoFreeCandidates(null).catch(() => []),
  ]);

  const table =
    routingTableResult?.status === 200 && 'table' in routingTableResult.body
      ? routingTableResult.body.table
      : null;
  const efficientModelIds = table
    ? [
        ...new Set(
          Object.values(table.routes)
            .flat()
            .map(candidate => candidate.model)
            .filter(model => availableModelIds.has(model) && !isVirtualAutoModelId(model))
        ),
      ].sort((left, right) => left.localeCompare(right))
    : [];
  const freeModelIds = [
    ...new Set(
      autoFreeCandidates.filter(
        model => availableModelIds.has(model) && !isVirtualAutoModelId(model)
      )
    ),
  ].sort((left, right) => left.localeCompare(right));
  if (efficientModelIds.length === 0 && freeModelIds.length === 0) return models;

  return models.map(model =>
    model.id === KILO_AUTO_EFFICIENT_MODEL.id && efficientModelIds.length > 0
      ? { ...model, autoRouting: { models: efficientModelIds } }
      : model.id === KILO_AUTO_FREE_MODEL.id && freeModelIds.length > 0
        ? { ...model, autoRouting: { models: freeModelIds } }
        : model
  );
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
      const models = await addAutoRoutingModels(result.data);
      return NextResponse.json({
        ...result,
        data: filterByFeature(models, feature),
      });
    }

    const data = await getEnhancedOpenRouterModels();
    if (!Array.isArray(data.data)) {
      return NextResponse.json(data);
    }
    const models = await addAutoRoutingModels(data.data);
    if (!auth?.user) {
      const experimentModels = await listAvailableExperimentModels();
      return NextResponse.json({
        data: filterByFeature(models.concat(experimentModels), feature),
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
      data: filterByFeature(
        modelsWithByokAvailability.concat(byokModels, experimentModels),
        feature
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
