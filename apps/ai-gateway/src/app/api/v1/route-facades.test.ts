import { describe, expect, test } from '@jest/globals';
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

describe('ai-gateway route facades', () => {
  test.each([
    ['embeddings', embeddings.POST, handleEmbeddingsRequest],
    ['embedding-models', embeddingModels.GET, handleEmbeddingModelsRequest],
    ['models/[provider]/[model]/endpoints', modelEndpoints.GET, handleModelEndpointsRequest],
    ['models/validate', modelValidation.POST, handleModelValidationRequest],
    ['edit/completions', editCompletions.POST, handleEditCompletionsRequest],
    ['fim/completions', fimCompletions.POST, handleFimCompletionsRequest],
    ['organizations/[id]/models', organizationModels.GET, handleOrganizationModelsRequest],
    [
      'organizations/[id]/models/validate',
      organizationModelValidation.POST,
      handleOrganizationModelValidationRequest,
    ],
    [
      'internal/auto-routing/denied-models',
      autoRoutingDeniedModels.POST,
      handleAutoRoutingDeniedModelsRequest,
    ],
  ])('%s exports the implementation handler by identity', (_route, routeHandler, handler) => {
    expect(routeHandler).toBe(handler);
  });

  test.each<[string, unknown, unknown]>([
    ['[...path]', llmProxy.POST, handleLlmProxyRequest],
    ['audio/transcriptions', audioTranscriptions.POST, handleAudioTranscriptionsRequest],
    ['models', models.GET, handleModelsRequest],
    ['models-by-provider', modelsByProvider.GET, handleModelsByProviderRequest],
    ['providers', providers.GET, handleProvidersRequest],
    ['transcription-models', transcriptionModels.GET, handleTranscriptionModelsRequest],
  ])(
    '%s wraps the implementation handler with its timing pattern',
    (_route, routeHandler, handler) => {
      expect(typeof routeHandler).toBe('function');
      expect(routeHandler).not.toBe(handler);
    }
  );

  test.each([
    ['[...path]', llmProxy.maxDuration, 800],
    ['audio/transcriptions', audioTranscriptions.maxDuration, 800],
    ['embeddings', embeddings.maxDuration, 300],
  ])('%s keeps its route duration limit', (_route, maxDuration, expected) => {
    expect(maxDuration).toBe(expected);
  });
});
