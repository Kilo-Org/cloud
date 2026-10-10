import { NextResponse } from 'next/server';
import {
  getOpenRouterModelsMetadataFromDatabase,
  getSystemOneModelIds,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';

/** System One models in the stored OpenRouter catalog: the only valid classifier models. */
export async function GET() {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const models = await getOpenRouterModelsMetadataFromDatabase();
  const data = getSystemOneModelIds(models)
    .sort()
    .map(id => ({ id, name: models[id]?.name ?? id }));
  return NextResponse.json({ data });
}
