import { NextResponse } from 'next/server';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import type { NextRequest } from 'next/server';
import { PRIMARY_DEFAULT_MODEL } from '@/lib/ai-gateway/models';
import { getEnhancedOpenRouterModels } from '@/lib/ai-gateway/providers/openrouter';
import {
  createAllowPredicateFromRestrictions,
  hasActiveModelRestrictions,
} from '@/lib/model-allow.server';
import { getModelIdToProviderSlugsIndex } from '@/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';
import { KILO_AUTO_FREE_MODEL, ORG_AUTO_MODEL } from '@/lib/ai-gateway/auto-model';
import { getEffectiveModelRestrictions } from '@/lib/organizations/model-restrictions';
import { isOrganizationAutoConfigured } from '@/lib/organizations/organization-auto-model';

type DefaultsResponse = {
  defaultModel: string;
  defaultFreeModel: string;
};

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<DefaultsResponse | { error: string }>> {
  const organizationId = (await params).id;
  const { success, data, nextResponse } = await getAuthorizedOrgContext(organizationId);
  if (!success) {
    return nextResponse;
  }

  const { organization } = data;

  // Get organization's default model setting
  let defaultModel = organization.settings?.default_model;

  const restrictions = getEffectiveModelRestrictions(organization);

  const isAllowed = createAllowPredicateFromRestrictions(restrictions);

  const findFirstAllowedModel = async (modelIds: readonly string[]) => {
    for (const modelId of modelIds) {
      if (await isAllowed(modelId)) {
        return modelId;
      }
    }

    return undefined;
  };

  const findFirstAllowedModelFromOpenRouter = async () => {
    const openRouterModels = await getEnhancedOpenRouterModels();
    for (const model of openRouterModels.data ?? []) {
      if (await isAllowed(model.id)) {
        return model.id;
      }
    }

    return undefined;
  };

  const findFirstAllowedModelFromDbSnapshot = async () => {
    const index = await getModelIdToProviderSlugsIndex();
    for (const modelId of index.keys()) {
      if (await isAllowed(modelId)) {
        return modelId;
      }
    }

    return undefined;
  };

  // If organization has a default model set, validate it against allowed models.
  // Organization Auto is a virtual organization-only default, so its eligibility
  // is validated from persisted organization settings rather than provider policy.
  if (defaultModel === ORG_AUTO_MODEL.id && !isOrganizationAutoConfigured(organization)) {
    console.warn('organization_auto_invalid_default', { organizationId: organization.id });
    defaultModel = undefined;
  } else if (
    defaultModel &&
    defaultModel !== ORG_AUTO_MODEL.id &&
    (defaultModel.endsWith('/*') || !(await isAllowed(defaultModel)))
  ) {
    // Organization's configured default model is not permitted; fall back to a safe default.
    defaultModel = undefined;
  }

  // Fallback to global default if no organization default is set or it's not allowed
  if (!defaultModel) {
    if (!hasActiveModelRestrictions(restrictions)) {
      // No restrictions - use PRIMARY_DEFAULT_MODEL directly
      defaultModel = PRIMARY_DEFAULT_MODEL;
    } else {
      defaultModel = await findFirstAllowedModel([PRIMARY_DEFAULT_MODEL]);

      if (!defaultModel) {
        defaultModel = await findFirstAllowedModelFromDbSnapshot();
      }

      if (!defaultModel) {
        defaultModel = await findFirstAllowedModelFromOpenRouter();
      }

      if (!defaultModel) {
        return NextResponse.json(
          {
            error:
              "No valid models are available — all models are blocked by this organization's policy.",
          },
          { status: 409 }
        );
      }
    }
  }

  return NextResponse.json({
    defaultModel,
    defaultFreeModel: KILO_AUTO_FREE_MODEL.id,
  });
}
