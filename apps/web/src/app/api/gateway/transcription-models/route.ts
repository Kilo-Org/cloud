import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import type { OpenRouterModelsResponse } from '@/lib/organizations/organization-types';
import { getOpenRouterTranscriptionModels } from '@/lib/ai-gateway/providers/openrouter';

/**
 * Test using:
 * curl -vvv 'http://localhost:3000/api/gateway/transcription-models'
 */
export async function GET(): Promise<
  NextResponse<{ error: string; message?: string } | OpenRouterModelsResponse>
> {
  try {
    const data = await getOpenRouterTranscriptionModels();
    return NextResponse.json(data);
  } catch (error) {
    captureException(error, {
      tags: { endpoint: 'gateway/transcription-models' },
      extra: { action: 'fetching_transcription_models' },
    });
    return NextResponse.json(
      { error: 'Failed to fetch transcription models', message: 'Error from OpenRouter API' },
      { status: 500 }
    );
  }
}
