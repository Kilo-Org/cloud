import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { parseModelValidationRequest } from './model-validation-request';
import { getEnhancedOpenRouterModels } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { getDirectByokModelsForUser } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { ORGANIZATION_ID_HEADER } from '@kilocode/web-shared/lib/constants';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { appendLocalFakeDeterministicCatalogModels } from '@kilocode/web-shared/lib/ai-gateway/local-fake-llm';
import { requestCountryCode } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/country-deny-list';
import { customRouterModelId, isCustomRouterModelId } from '@kilocode/auto-routing-contracts';
import { listUsableCustomRouters } from '@kilocode/web-shared/lib/ai-gateway/custom-routers';
import { addAutoRoutingModels } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-models';
import { getAvailableModelsForOrganization } from '@kilocode/web-shared/lib/organizations/organization-models';
import type { OpenRouterModelsResponse } from '@kilocode/web-shared/lib/organizations/organization-types';
import { TRPCError } from '@trpc/server';

type ValidationResult = { valid: true } | { valid: false; reason: 'unavailable' };

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

function validationResult(available: boolean) {
  return NextResponse.json<ValidationResult>(
    available ? { valid: true } : { valid: false, reason: 'unavailable' }
  );
}

async function organizationCatalog(
  organizationId: string,
  kiloUserId: string,
  countryCode: string | null
): Promise<OpenRouterModelsResponse | null> {
  try {
    return await getAvailableModelsForOrganization(
      organizationId,
      { type: 'member', kiloUserId },
      'member',
      { fromDb: readDb, countryCode }
    );
  } catch (error) {
    // An organization that no longer exists is not a server fault and offers nothing
    // to retry, so it reads as no models rather than a failed check.
    if (error instanceof TRPCError && error.code === 'NOT_FOUND') {
      return null;
    }
    throw error;
  }
}

/**
 * Answers from the member-effective organization catalog, the same catalog the
 * organization model routes list and the gateway enforces at inference time. The
 * caller's authentication already proved the membership, so the member subject
 * needs no `allowNonMember`.
 */
async function validateForOrganizationMember(params: {
  organizationId: string;
  kiloUserId: string;
  modelId: string;
  countryCode: string | null;
}) {
  const result = await organizationCatalog(
    params.organizationId,
    params.kiloUserId,
    params.countryCode
  );
  if (!result) {
    return validationResult(false);
  }
  // The catalog passes the same list through the auto-routing step, which can withhold an
  // auto id, so membership is read from that result rather than the raw list.
  const models = await addAutoRoutingModels(result.data);
  // The catalog lists a custom router as a virtual model, so the model id is not in
  // `data`; it is usable when the router is usable in this context.
  const customRouters = isCustomRouterModelId(params.modelId)
    ? await listUsableCustomRouters({
        userId: params.kiloUserId,
        organizationId: params.organizationId,
      })
    : [];
  return validationResult(
    models.some(model => model.id === params.modelId) ||
      customRouters.some(
        router => customRouterModelId(router.ownerType, router.slug) === params.modelId
      )
  );
}

/**
 * Scope rule: this route answers for the credential's own scope. An anonymous caller
 * or a personal credential is answered from the personal catalog, personal BYOK keys
 * and personal custom routers. A credential bound to an organization is answered from
 * the member-effective organization catalog. A request that selects an organization
 * with the request header must use the organization route instead.
 */
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
  const countryCode = requestCountryCode(request.headers);
  try {
    if (auth?.organizationId && auth.user) {
      return await validateForOrganizationMember({
        organizationId: auth.organizationId,
        kiloUserId: auth.user.id,
        modelId: bodyResult.data.modelId,
        countryCode,
      });
    }

    const models = await getEnhancedOpenRouterModels({
      countryCode,
      fromDb: readDb,
    });
    if (!Array.isArray(models.data)) {
      throw new Error('Model catalog returned invalid data');
    }
    const byokModels = auth?.user ? await getDirectByokModelsForUser(auth.user.id) : [];
    const customRouters =
      auth?.user && isCustomRouterModelId(bodyResult.data.modelId)
        ? await listUsableCustomRouters({ userId: auth.user.id, organizationId: null })
        : [];
    const available =
      appendLocalFakeDeterministicCatalogModels(models.data.concat(byokModels)).some(
        model => model.id === bodyResult.data.modelId
      ) ||
      customRouters.some(
        router => customRouterModelId(router.ownerType, router.slug) === bodyResult.data.modelId
      );
    return validationResult(available);
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
