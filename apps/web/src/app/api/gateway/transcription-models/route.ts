import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import type { OpenRouterModelsResponse } from '@/lib/organizations/organization-types';
import { getOpenRouterTranscriptionModels } from '@/lib/ai-gateway/providers/openrouter';
import { getUserFromAuth } from '@/lib/user/server';
import {
  getEffectiveModelDecision,
  resolveOrganizationMemberModelPolicy,
} from '@/lib/organizations/effective-model-access.server';

/**
 * Test using:
 * curl -vvv 'http://localhost:3000/api/gateway/transcription-models'
 */
export async function GET(): Promise<
  NextResponse<{ error: string; message?: string } | OpenRouterModelsResponse>
> {
  try {
    const data = await getOpenRouterTranscriptionModels();
    const auth = await getUserFromAuth({ adminOnly: false }).catch(() => null);
    if (auth?.organizationId && auth.user && Array.isArray(data.data)) {
      // Resolve the member's policy once, then evaluate each catalog model.
      const policy = await resolveOrganizationMemberModelPolicy({
        organizationId: auth.organizationId,
        kiloUserId: auth.user.id,
      });
      const models = [];
      for (const model of data.data) {
        if ((await getEffectiveModelDecision(policy, model.id)).allowed) models.push(model);
      }
      return NextResponse.json({ ...data, data: models });
    }
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
