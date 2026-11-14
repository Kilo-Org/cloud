import { NextResponse } from 'next/server';
import { getKiloEmbeddingModelCatalogFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/embeddings/openrouter-embedding-models';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import {
  getEffectiveModelDecision,
  resolveOrganizationMemberModelPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';

export async function handleEmbeddingModelsRequest(): Promise<NextResponse> {
  const catalog = await getKiloEmbeddingModelCatalogFromDatabase();
  if (!catalog) {
    return NextResponse.json(
      { error: 'Embedding model metadata is temporarily unavailable.' },
      { status: 503, headers: { 'Retry-After': '30' } }
    );
  }
  const auth = await getUserFromAuth({
    adminOnly: false,
    expectedAudience: KILO_GATEWAY_AUDIENCE,
  }).catch(() => null);
  if (auth?.organizationId && auth.user) {
    // Resolve the member's policy once, then evaluate each catalog model
    // against it — the policy context is a transaction + several queries.
    const policy = await resolveOrganizationMemberModelPolicy({
      organizationId: auth.organizationId,
      kiloUserId: auth.user.id,
      fromDb: readDb,
    });
    const models = [];
    for (const model of catalog.models) {
      if ((await getEffectiveModelDecision(policy, model.id)).allowed) models.push(model);
    }
    if (models.length === 0) {
      return NextResponse.json(
        { error: 'No embedding models are available through your organization groups.' },
        { status: 409 }
      );
    }
    const modelIds = new Set(models.map(model => model.id));
    const aliases = Object.fromEntries(
      Object.entries(catalog.aliases).filter(([, modelId]) => modelIds.has(modelId))
    );
    return NextResponse.json({
      ...catalog,
      defaultModel: modelIds.has(catalog.defaultModel) ? catalog.defaultModel : models[0].id,
      models,
      aliases,
    });
  }
  return NextResponse.json(catalog);
}
