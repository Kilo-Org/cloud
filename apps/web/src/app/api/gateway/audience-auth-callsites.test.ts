import { describe, expect, test } from '@jest/globals';
import * as gatewayAudioTranscriptions from '@/app/api/gateway/audio/transcriptions/route';
import * as gatewayEmbeddingModels from '@/app/api/gateway/embedding-models/route';
import * as gatewayEmbeddings from '@/app/api/gateway/embeddings/route';
import * as gatewayModelEndpoints from '@/app/api/gateway/models/[provider]/[model]/endpoints/route';
import * as gatewayModels from '@/app/api/gateway/models/route';
import * as gatewayModelsByProvider from '@/app/api/gateway/models-by-provider/route';
import * as gatewayPath from '@/app/api/gateway/[...path]/route';
import * as gatewayProviders from '@/app/api/gateway/providers/route';
import * as gatewayTranscriptionModels from '@/app/api/gateway/transcription-models/route';
import * as gatewayV1AudioTranscriptions from '@/app/api/gateway/v1/audio/transcriptions/route';
import * as gatewayV1ModelEndpoints from '@/app/api/gateway/v1/models/[provider]/[model]/endpoints/route';
import * as gatewayV1Models from '@/app/api/gateway/v1/models/route';
import * as gatewayV1TranscriptionModels from '@/app/api/gateway/v1/transcription-models/route';
import * as editCompletions from '@/app/api/edit/completions/route';
import * as fimCompletions from '@/app/api/fim/completions/route';
import * as openrouterAudioTranscriptions from '@/app/api/openrouter/audio/transcriptions/route';
import * as openrouterEmbeddings from '@/app/api/openrouter/embeddings/route';
import * as openrouterModelEndpoints from '@/app/api/openrouter/models/[provider]/[model]/endpoints/route';
import * as openrouterModels from '@/app/api/openrouter/models/route';
import * as openrouterModelValidation from '@/app/api/openrouter/models/validate/route';
import * as openrouterModelsByProvider from '@/app/api/openrouter/models-by-provider/route';
import * as openrouterPath from '@/app/api/openrouter/[...path]/route';
import * as openrouterProviders from '@/app/api/openrouter/providers/route';
import * as openrouterTranscriptionModels from '@/app/api/openrouter/transcription-models/route';
import * as openrouterV1AudioTranscriptions from '@/app/api/openrouter/v1/audio/transcriptions/route';
import * as openrouterV1ModelEndpoints from '@/app/api/openrouter/v1/models/[provider]/[model]/endpoints/route';
import * as openrouterV1TranscriptionModels from '@/app/api/openrouter/v1/transcription-models/route';
import * as organizationModels from '@/app/api/organizations/[id]/models/route';
import * as organizationModelValidation from '@/app/api/organizations/[id]/models/validate/route';
import { handleAudioTranscriptionsRequest } from '@/lib/ai-gateway/handlers/audio-transcriptions';
import { handleEditCompletionsRequest } from '@/lib/ai-gateway/handlers/edit-completions';
import { handleEmbeddingModelsRequest } from '@/lib/ai-gateway/handlers/embedding-models';
import { handleEmbeddingsRequest } from '@/lib/ai-gateway/handlers/embeddings';
import { handleFimCompletionsRequest } from '@/lib/ai-gateway/handlers/fim-completions';
import { handleLlmProxyRequest } from '@/lib/ai-gateway/handlers/llm-proxy';
import { handleModelEndpointsRequest } from '@/lib/ai-gateway/handlers/model-endpoints';
import { handleModelValidationRequest } from '@/lib/ai-gateway/handlers/model-validation';
import { handleModelsByProviderRequest } from '@/lib/ai-gateway/handlers/models-by-provider';
import { handleModelsRequest } from '@/lib/ai-gateway/handlers/models';
import { handleOrganizationModelValidationRequest } from '@/lib/ai-gateway/handlers/organization-model-validation';
import { handleOrganizationModelsRequest } from '@/lib/ai-gateway/handlers/organization-models';
import { handleProvidersRequest } from '@/lib/ai-gateway/handlers/providers';
import { handleTranscriptionModelsRequest } from '@/lib/ai-gateway/handlers/transcription-models';

describe('gateway route facades', () => {
  test.each([
    ['gateway/embeddings', gatewayEmbeddings.POST, handleEmbeddingsRequest],
    ['openrouter/embeddings', openrouterEmbeddings.POST, handleEmbeddingsRequest],
    ['gateway/embedding-models', gatewayEmbeddingModels.GET, handleEmbeddingModelsRequest],
    [
      'gateway/v1/audio/transcriptions',
      gatewayV1AudioTranscriptions.POST,
      handleAudioTranscriptionsRequest,
    ],
    [
      'openrouter/audio/transcriptions',
      openrouterAudioTranscriptions.POST,
      handleAudioTranscriptionsRequest,
    ],
    [
      'openrouter/v1/audio/transcriptions',
      openrouterV1AudioTranscriptions.POST,
      handleAudioTranscriptionsRequest,
    ],
    [
      'gateway/models/[provider]/[model]/endpoints',
      gatewayModelEndpoints.GET,
      handleModelEndpointsRequest,
    ],
    [
      'gateway/v1/models/[provider]/[model]/endpoints',
      gatewayV1ModelEndpoints.GET,
      handleModelEndpointsRequest,
    ],
    [
      'openrouter/models/[provider]/[model]/endpoints',
      openrouterModelEndpoints.GET,
      handleModelEndpointsRequest,
    ],
    [
      'openrouter/v1/models/[provider]/[model]/endpoints',
      openrouterV1ModelEndpoints.GET,
      handleModelEndpointsRequest,
    ],
    ['openrouter/models/validate', openrouterModelValidation.POST, handleModelValidationRequest],
    ['edit/completions', editCompletions.POST, handleEditCompletionsRequest],
    ['fim/completions', fimCompletions.POST, handleFimCompletionsRequest],
    ['organizations/[id]/models', organizationModels.GET, handleOrganizationModelsRequest],
    [
      'organizations/[id]/models/validate',
      organizationModelValidation.POST,
      handleOrganizationModelValidationRequest,
    ],
  ])('%s exports the implementation handler by identity', (_route, routeHandler, handler) => {
    expect(routeHandler).toBe(handler);
  });

  test.each<[string, unknown, unknown]>([
    ['gateway/[...path]', gatewayPath.POST, handleLlmProxyRequest],
    ['openrouter/[...path]', openrouterPath.POST, handleLlmProxyRequest],
    [
      'gateway/audio/transcriptions',
      gatewayAudioTranscriptions.POST,
      handleAudioTranscriptionsRequest,
    ],
    ['gateway/models', gatewayModels.GET, handleModelsRequest],
    ['gateway/v1/models', gatewayV1Models.GET, handleModelsRequest],
    ['openrouter/models', openrouterModels.GET, handleModelsRequest],
    ['gateway/models-by-provider', gatewayModelsByProvider.GET, handleModelsByProviderRequest],
    [
      'openrouter/models-by-provider',
      openrouterModelsByProvider.GET,
      handleModelsByProviderRequest,
    ],
    ['gateway/providers', gatewayProviders.GET, handleProvidersRequest],
    ['openrouter/providers', openrouterProviders.GET, handleProvidersRequest],
    [
      'gateway/transcription-models',
      gatewayTranscriptionModels.GET,
      handleTranscriptionModelsRequest,
    ],
    [
      'gateway/v1/transcription-models',
      gatewayV1TranscriptionModels.GET,
      handleTranscriptionModelsRequest,
    ],
    [
      'openrouter/transcription-models',
      openrouterTranscriptionModels.GET,
      handleTranscriptionModelsRequest,
    ],
    [
      'openrouter/v1/transcription-models',
      openrouterV1TranscriptionModels.GET,
      handleTranscriptionModelsRequest,
    ],
  ])(
    '%s wraps the implementation handler with its own timing pattern',
    (_route, routeHandler, handler) => {
      // Each alias wraps the handler with its own pattern so its pathname emits
      // its own `api_timing` line (see `rest-routes-data.test.ts`).
      expect(typeof routeHandler).toBe('function');
      expect(routeHandler).not.toBe(handler);
    }
  );

  test.each([
    ['gateway/[...path]', gatewayPath.maxDuration, 800],
    ['openrouter/[...path]', openrouterPath.maxDuration, 800],
    ['gateway/audio/transcriptions', gatewayAudioTranscriptions.maxDuration, 800],
    ['gateway/v1/audio/transcriptions', gatewayV1AudioTranscriptions.maxDuration, 800],
    ['openrouter/audio/transcriptions', openrouterAudioTranscriptions.maxDuration, 800],
    ['openrouter/v1/audio/transcriptions', openrouterV1AudioTranscriptions.maxDuration, 800],
    ['openrouter/embeddings', openrouterEmbeddings.maxDuration, 300],
  ])('%s keeps its route duration limit', (_route, maxDuration, expected) => {
    expect(maxDuration).toBe(expected);
  });
});
