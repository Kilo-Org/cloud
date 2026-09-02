import { describe, expect, test } from '@jest/globals';
import * as gatewayAudioTranscriptions from '@/app/api/gateway/audio/transcriptions/route';
import * as gatewayEmbeddings from '@/app/api/gateway/embeddings/route';
import * as gatewayModels from '@/app/api/gateway/models/route';
import * as gatewayModelsByProvider from '@/app/api/gateway/models-by-provider/route';
import * as gatewayPath from '@/app/api/gateway/[...path]/route';
import * as gatewayV1AudioTranscriptions from '@/app/api/gateway/v1/audio/transcriptions/route';
import * as gatewayV1Models from '@/app/api/gateway/v1/models/route';
import * as gatewayV1TranscriptionModels from '@/app/api/gateway/v1/transcription-models/route';
import * as openrouterAudioTranscriptions from '@/app/api/openrouter/audio/transcriptions/route';
import * as openrouterModels from '@/app/api/openrouter/models/route';
import * as openrouterModelsByProvider from '@/app/api/openrouter/models-by-provider/route';
import * as openrouterPath from '@/app/api/openrouter/[...path]/route';
import * as openrouterV1AudioTranscriptions from '@/app/api/openrouter/v1/audio/transcriptions/route';
import * as openrouterV1TranscriptionModels from '@/app/api/openrouter/v1/transcription-models/route';
import * as openrouterTranscriptionModels from '@/app/api/openrouter/transcription-models/route';
import * as transcriptionModels from '@/app/api/gateway/transcription-models/route';
import * as gatewayEmbeddingsImplementation from '@/app/api/openrouter/embeddings/route';

describe('gateway route aliases', () => {
  test.each([
    ['gateway/[...path]', gatewayPath.POST, openrouterPath.POST],
    ['gateway/embeddings', gatewayEmbeddings.POST, gatewayEmbeddingsImplementation.POST],
    [
      'gateway/audio/transcriptions',
      gatewayAudioTranscriptions.POST,
      openrouterAudioTranscriptions.POST,
    ],
    ['gateway/models', gatewayModels.GET, openrouterModels.GET],
    ['gateway/models-by-provider', gatewayModelsByProvider.GET, openrouterModelsByProvider.GET],
    ['gateway/v1/models', gatewayV1Models.GET, openrouterModels.GET],
    [
      'gateway/v1/audio/transcriptions',
      gatewayV1AudioTranscriptions.POST,
      openrouterAudioTranscriptions.POST,
    ],
    ['gateway/v1/transcription-models', gatewayV1TranscriptionModels.GET, transcriptionModels.GET],
    [
      'openrouter/v1/audio/transcriptions',
      openrouterV1AudioTranscriptions.POST,
      openrouterAudioTranscriptions.POST,
    ],
    [
      'openrouter/v1/transcription-models',
      openrouterV1TranscriptionModels.GET,
      transcriptionModels.GET,
    ],
    ['openrouter/transcription-models', openrouterTranscriptionModels.GET, transcriptionModels.GET],
  ])(
    '%s exports the implementation handler by identity',
    (_route, aliasHandler, implementationHandler) => {
      expect(aliasHandler).toBe(implementationHandler);
    }
  );
});
