import { afterEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import * as llmProxy from './[...path]/route';
import * as audioTranscriptions from './audio/transcriptions/route';
import * as editCompletions from './edit/completions/route';
import * as embeddingModels from './embedding-models/route';
import * as embeddings from './embeddings/route';
import * as fimCompletions from './fim/completions/route';
import * as modelsByProvider from './models-by-provider/route';
import * as modelEndpoints from './models/[provider]/[model]/endpoints/route';
import * as models from './models/route';
import * as modelValidation from './models/validate/route';
import * as organizationModels from './organizations/[id]/models/route';
import * as organizationModelValidation from './organizations/[id]/models/validate/route';
import * as providers from './providers/route';
import * as systemOne from './systemone/route';
import * as transcriptionModels from './transcription-models/route';
import * as autoRoutingDeniedModels from './internal/auto-routing/denied-models/route';
import { handleAutoRoutingDeniedModelsRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/auto-routing-denied-models';
import { handleEditCompletionsRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/edit-completions';
import { handleEmbeddingModelsRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/embedding-models';
import { handleEmbeddingsRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/embeddings';
import { handleFimCompletionsRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/fim-completions';
import { handleModelEndpointsRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/model-endpoints';
import { handleModelValidationRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/model-validation';
import { handleModelsByProviderRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/models-by-provider';
import { handleModelsRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/models';
import { handleOrganizationModelValidationRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/organization-model-validation';
import { handleOrganizationModelsRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/organization-models';
import { handleProvidersRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/providers';
import { handleTranscriptionModelsRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/transcription-models';
import { handleAudioTranscriptionsRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/audio-transcriptions';
import { handleLlmProxyRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/llm-proxy';
import { handleSystemOneRequest } from '@kilocode/web-shared/lib/ai-gateway/typesafe/handler';
import {
  UPSTREAM_DURATION_BUDGET_MS,
  UPSTREAM_POST_RESPONSE_HEADROOM_MS,
} from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-request';
import { runWithReplicaAffinity } from '@kilocode/web-shared/lib/read-replica-affinity';

jest.mock('@kilocode/web-shared/lib/read-replica-affinity', () => ({
  runWithReplicaAffinity: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/handlers/audio-transcriptions', () => ({
  handleAudioTranscriptionsRequest: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/handlers/auto-routing-denied-models', () => ({
  handleAutoRoutingDeniedModelsRequest: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/handlers/edit-completions', () => ({
  handleEditCompletionsRequest: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/handlers/embedding-models', () => ({
  handleEmbeddingModelsRequest: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/handlers/embeddings', () => ({
  handleEmbeddingsRequest: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/handlers/fim-completions', () => ({
  handleFimCompletionsRequest: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/handlers/llm-proxy', () => ({
  handleLlmProxyRequest: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/handlers/model-endpoints', () => ({
  handleModelEndpointsRequest: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/handlers/model-validation', () => ({
  handleModelValidationRequest: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/handlers/models', () => ({
  handleModelsRequest: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/handlers/models-by-provider', () => ({
  handleModelsByProviderRequest: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/handlers/organization-models', () => ({
  handleOrganizationModelsRequest: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/handlers/organization-model-validation', () => ({
  handleOrganizationModelValidationRequest: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/handlers/providers', () => ({
  handleProvidersRequest: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/handlers/transcription-models', () => ({
  handleTranscriptionModelsRequest: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/typesafe/handler', () => ({
  handleSystemOneRequest: jest.fn(),
}));

type Facade = (
  request: NextRequest,
  context: { params: Promise<{ id: string; provider: string; model: string }> }
) => Promise<Response>;

describe('ai-gateway route facades', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  test.each<[string, string, Facade, Facade, boolean?]>([
    ['POST', 'responses', llmProxy.POST, handleLlmProxyRequest],
    ['POST', 'audio/transcriptions', audioTranscriptions.POST, handleAudioTranscriptionsRequest],
    ['POST', 'embeddings', embeddings.POST, handleEmbeddingsRequest],
    ['GET', 'embedding-models', embeddingModels.GET, handleEmbeddingModelsRequest],
    ['GET', 'models', models.GET, handleModelsRequest],
    ['GET', 'models-by-provider', modelsByProvider.GET, handleModelsByProviderRequest],
    ['GET', 'providers', providers.GET, handleProvidersRequest],
    ['GET', 'transcription-models', transcriptionModels.GET, handleTranscriptionModelsRequest],
    [
      'GET',
      'models/example/model/endpoints',
      modelEndpoints.GET,
      handleModelEndpointsRequest,
      true,
    ],
    ['POST', 'models/validate', modelValidation.POST, handleModelValidationRequest],
    ['POST', 'edit/completions', editCompletions.POST, handleEditCompletionsRequest],
    ['POST', 'fim/completions', fimCompletions.POST, handleFimCompletionsRequest],
    ['POST', 'systemone', systemOne.POST, handleSystemOneRequest],
    [
      'GET',
      'organizations/org/models',
      organizationModels.GET,
      handleOrganizationModelsRequest,
      true,
    ],
    [
      'POST',
      'organizations/org/models/validate',
      organizationModelValidation.POST,
      handleOrganizationModelValidationRequest,
      true,
    ],
    [
      'POST',
      'internal/auto-routing/denied-models',
      autoRoutingDeniedModels.POST,
      handleAutoRoutingDeniedModelsRequest,
    ],
  ])(
    '%s /api/v1/%s delegates to its handler inside replica affinity',
    async (method, path, routeHandler, handler, usesParams = false) => {
      const request = new NextRequest(`https://ai-gateway.kilo.ai/api/v1/${path}`, {
        method,
        headers: { 'x-forwarded-for': '192.0.2.42:8000, 198.51.100.7' },
      });
      const context = {
        params: Promise.resolve({ id: 'org', provider: 'example', model: 'model' }),
      };
      const response = new NextResponse(null, { status: 204 });
      const mockHandler = jest.mocked(handler).mockResolvedValue(response);
      const mockAffinity = jest.mocked(runWithReplicaAffinity).mockImplementation((_ip, run) => {
        expect(mockHandler).not.toHaveBeenCalled();
        const result = run();
        expect(mockHandler).toHaveBeenCalledTimes(1);
        return result;
      });

      await expect(routeHandler(request, context)).resolves.toBe(response);
      expect(mockAffinity).toHaveBeenCalledTimes(1);
      expect(mockAffinity).toHaveBeenCalledWith('192.0.2.42', expect.any(Function));
      expect(mockHandler.mock.calls[0]?.[0]).toBe(request);
      if (usesParams) {
        expect(mockHandler.mock.calls[0]?.[1]).toBe(context);
      }
    }
  );

  test.each([undefined, 'not-an-ip, 198.51.100.7'])(
    'does not use a later hop when the client IP is missing or invalid (%s)',
    async forwardedFor => {
      const headers = forwardedFor === undefined ? undefined : { 'x-forwarded-for': forwardedFor };
      const request = new NextRequest('https://ai-gateway.kilo.ai/api/v1/embedding-models', {
        headers,
      });
      const response = new NextResponse(null, { status: 204 });
      jest.mocked(handleEmbeddingModelsRequest).mockResolvedValue(response);
      const mockAffinity = jest
        .mocked(runWithReplicaAffinity)
        .mockImplementation((_ip, run) => run());

      await expect(embeddingModels.GET(request)).resolves.toBe(response);
      expect(mockAffinity).toHaveBeenCalledWith(undefined, expect.any(Function));
    }
  );

  test.each([
    ['[...path]', llmProxy.maxDuration, 800],
    ['audio/transcriptions', audioTranscriptions.maxDuration, 800],
    ['embeddings', embeddings.maxDuration, 800],
    ['edit/completions', editCompletions.maxDuration, 800],
    ['fim/completions', fimCompletions.maxDuration, 800],
    ['systemone', systemOne.maxDuration, 800],
  ])('%s keeps its route duration limit', (_route, maxDuration, expected) => {
    expect(maxDuration).toBe(expected);
  });

  test.each([
    ['[...path]', llmProxy.maxDuration, UPSTREAM_DURATION_BUDGET_MS],
    ['audio/transcriptions', audioTranscriptions.maxDuration, UPSTREAM_DURATION_BUDGET_MS],
    ['embeddings', embeddings.maxDuration, UPSTREAM_DURATION_BUDGET_MS],
    ['edit/completions', editCompletions.maxDuration, UPSTREAM_DURATION_BUDGET_MS],
    ['fim/completions', fimCompletions.maxDuration, UPSTREAM_DURATION_BUDGET_MS],
    ['systemone', systemOne.maxDuration, UPSTREAM_DURATION_BUDGET_MS],
  ])(
    '%s leaves the post-response headroom after its upstream budget',
    (_route, maxDuration, upstreamBudgetMs) => {
      expect(upstreamBudgetMs + UPSTREAM_POST_RESPONSE_HEADROOM_MS).toBeLessThanOrEqual(
        maxDuration * 1000
      );
    }
  );
});
