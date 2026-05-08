import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import type { OpenRouterModelsResponse } from '@/lib/organizations/organization-types';
import { getOpenRouterEmbeddingModels } from '@/lib/ai-gateway/providers/openrouter';

/**
 * Test using:
 * curl -vvv 'http://localhost:3000/api/gateway/embedding-models'
 */
export async function GET(): Promise<
  NextResponse<{ error: string; message?: string } | OpenRouterModelsResponse>
> {
  try {
    const data = await getOpenRouterEmbeddingModels();
    return NextResponse.json(data);
  } catch (error) {
    captureException(error, {
      tags: { endpoint: 'gateway/embedding-models' },
      extra: { action: 'fetching_embedding_models' },
    });
    return NextResponse.json(
      { error: 'Failed to fetch embedding models', message: 'Error from OpenRouter API' },
      { status: 500 }
    );
  }
}
