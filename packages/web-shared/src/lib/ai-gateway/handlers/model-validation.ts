import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { parseModelValidationRequest } from './model-validation-request';
import { getEnhancedOpenRouterModels } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { getDirectByokModelsForUser } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { ORGANIZATION_ID_HEADER } from '@kilocode/web-shared/lib/constants';
import { appendLocalFakeDeterministicCatalogModels } from '@kilocode/web-shared/lib/ai-gateway/local-fake-llm';
import { requestCountryCode } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/country-deny-list';

async function tryGetUserFromAuth() {
  try {
    return await getUserFromAuth({
      adminOnly: false,
      expectedAudience: KILO_GATEWAY_AUDIENCE,
    });
  } catch (error) {
    console.error('[validateOpenRouterModel] failed to get user from auth', error);
    return { user: null, organizationId: null };
  }
}

export async function handleModelValidationRequest(request: NextRequest) {
  const bodyResult = await parseModelValidationRequest(request);
  if (!bodyResult.success) {
    return bodyResult.response;
  }

  if (request.headers.get(ORGANIZATION_ID_HEADER)) {
    return NextResponse.json(
      { error: 'Organization-scoped validation must use /api/organizations/[id]/models/validate' },
      { status: 400 }
    );
  }

  const auth = await tryGetUserFromAuth();
  try {
    const models = await getEnhancedOpenRouterModels({
      countryCode: requestCountryCode(request.headers),
    });
    if (!Array.isArray(models.data)) {
      throw new Error('Model catalog returned invalid data');
    }
    const byokModels = auth?.user ? await getDirectByokModelsForUser(auth.user.id) : [];
    const available = appendLocalFakeDeterministicCatalogModels(
      models.data.concat(byokModels)
    ).some(model => model.id === bodyResult.data.modelId);
    return NextResponse.json(available ? { valid: true } : { valid: false, reason: 'unavailable' });
  } catch (error) {
    captureException(error, {
      tags: { endpoint: 'openrouter/models/validate' },
      extra: {
        action: 'validating_model',
        userId: auth?.user?.id,
        organizationId: auth?.organizationId,
      },
    });
    return NextResponse.json(
      { error: 'Failed to validate model', message: 'Error from model catalog' },
      { status: 500 }
    );
  }
}
