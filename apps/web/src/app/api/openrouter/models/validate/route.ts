import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import * as z from 'zod';
import { getEnhancedOpenRouterModels } from '@/lib/ai-gateway/providers/openrouter';
import { getUserFromAuth } from '@/lib/user/server';
import { getDirectByokModelsForUser } from '@/lib/ai-gateway/providers/direct-byok';
import { FEATURE_HEADER, validateFeatureHeader } from '@/lib/feature-detection';
import { ORGANIZATION_ID_HEADER } from '@/lib/constants';
import { filterByFeature } from '@/lib/ai-gateway/models';
import { listAvailableExperimentModels } from '@/lib/ai-gateway/experiments/list-available-experiment-models';

const BodySchema = z.object({ modelId: z.string().trim().min(1) });

async function tryGetUserFromAuth() {
  try {
    return await getUserFromAuth({ adminOnly: false });
  } catch (error) {
    console.error('[validateOpenRouterModel] failed to get user from auth', error);
    return { user: null, organizationId: null };
  }
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const bodyResult = BodySchema.safeParse(body);
  if (!bodyResult.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: z.treeifyError(bodyResult.error) },
      { status: 400 }
    );
  }

  if (request.headers.get(ORGANIZATION_ID_HEADER)) {
    return NextResponse.json(
      { error: 'Organization-scoped validation must use /api/organizations/[id]/models/validate' },
      { status: 400 }
    );
  }

  const feature = validateFeatureHeader(request.headers.get(FEATURE_HEADER));
  const auth = await tryGetUserFromAuth();
  try {
    const models = await getEnhancedOpenRouterModels();
    if (!Array.isArray(models.data)) {
      throw new Error('Model catalog returned invalid data');
    }
    const [byokModels, experimentModels] = await Promise.all([
      auth?.user ? getDirectByokModelsForUser(auth.user.id) : [],
      listAvailableExperimentModels(),
    ]);
    const available = filterByFeature(
      models.data.concat(byokModels, experimentModels),
      feature
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
