import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getOpenRouterModelsMetadataFromDatabase } from '@/lib/ai-gateway/providers/gateway-models-cache';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ provider: string; model: string }> }
) {
  const { provider, model } = await params;
  const models = await getOpenRouterModelsMetadataFromDatabase();
  const storedModel = models[`${provider}/${model}`];

  if (!storedModel) {
    return NextResponse.json({ error: { message: 'Not Found', code: 404 } }, { status: 404 });
  }

  return NextResponse.json({ data: storedModel });
}
