import { NextResponse } from 'next/server';
import { KILO_EMBEDDING_MODEL_CATALOG } from '@/lib/ai-gateway/embeddings/kilo-embedding-models';
import { getUserFromAuth } from '@/lib/user/server';
import {
  getEffectiveModelDecision,
  resolveOrganizationMemberModelPolicy,
} from '@/lib/organizations/effective-model-access.server';

export async function GET(): Promise<NextResponse> {
  const auth = await getUserFromAuth({ adminOnly: false }).catch(() => null);
  if (auth?.organizationId && auth.user) {
    // Resolve the member's policy once, then evaluate each catalog model
    // against it — the policy context is a transaction + several queries.
    const policy = await resolveOrganizationMemberModelPolicy({
      organizationId: auth.organizationId,
      kiloUserId: auth.user.id,
    });
    const models = [];
    for (const model of KILO_EMBEDDING_MODEL_CATALOG.models) {
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
      Object.entries(KILO_EMBEDDING_MODEL_CATALOG.aliases).filter(([, modelId]) =>
        modelIds.has(modelId)
      )
    );
    return NextResponse.json({
      ...KILO_EMBEDDING_MODEL_CATALOG,
      defaultModel: modelIds.has(KILO_EMBEDDING_MODEL_CATALOG.defaultModel)
        ? KILO_EMBEDDING_MODEL_CATALOG.defaultModel
        : models[0].id,
      models,
      aliases,
    });
  }
  return NextResponse.json(KILO_EMBEDDING_MODEL_CATALOG);
}
