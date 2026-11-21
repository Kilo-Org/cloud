import { type NextResponse as NextResponseType } from 'next/server';
import { type NextRequest } from 'next/server';
import { getTranscriptionProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { debugSaveLog, debugSaveProxyRequest } from '@kilocode/web-shared/lib/debugUtils';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import {
  countAndStoreTranscriptionUsage,
  invalidRequestResponse,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { providerPreferencesSchema } from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import {
  buildUpstreamBody,
  extractTranscriptionPromptInfo,
  TranscriptionRequestSchema,
  type TranscriptionRequest,
} from '@kilocode/web-shared/lib/ai-gateway/transcriptions/transcription-request';
import type { PromptInfo } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import { UPSTREAM_DURATION_BUDGET_MS } from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-request';
import {
  accountAndRewriteUsageResponse,
  handleUsageEndpointRequest,
  type ParsedUsageRequest,
  type UsageEndpoint,
} from '@kilocode/web-shared/lib/ai-gateway/handlers/usage-endpoint-pipeline';

/** Prompt info attributed from a multipart upload: file name and size. */
function extractMultipartPromptInfo(file: File, language: string | null): PromptInfo {
  const languagePart = language ? ` language=${language.slice(0, 32)}` : '';
  return {
    system_prompt_prefix: '',
    system_prompt_length: 0,
    user_prompt_prefix: `audio/${file.name} size=${file.size}${languagePart}`.slice(0, 100),
  };
}

function extractMultipartLanguage(formData: FormData): string | null {
  const language = formData.get('language');
  return typeof language === 'string' && language.trim().length > 0 ? language.trim() : null;
}

/**
 * Either a JSON transcription body or a multipart upload. The request body
 * stream is single-consumption, so the shape is resolved once, from the
 * content-type header, before anything reads the body.
 */
type ParsedTranscriptionRequest =
  | { kind: 'json'; body: TranscriptionRequest }
  | { kind: 'multipart'; file: File; model: string; language: string | null };

async function parseMultipartTranscriptionRequest(
  request: NextRequest
): Promise<Extract<ParsedTranscriptionRequest, { kind: 'multipart' }> | null> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (error) {
    // A malformed body or a missing boundary rejects instead of returning form
    // data. This is client input, so answer the controlled 400 without
    // reporting it to Sentry. Never log the body: it is audio.
    errorExceptInTest('[transcription-proxy] Invalid multipart body:', error);
    return null;
  }
  const modelField = formData.get('model');
  if (typeof modelField !== 'string' || modelField.trim().length === 0) return null;
  const filePart = formData.get('file');
  if (!filePart || typeof filePart === 'string') return null;
  return {
    kind: 'multipart',
    file: filePart,
    model: modelField.trim(),
    language: extractMultipartLanguage(formData),
  };
}

function parseJsonTranscriptionRequest(
  requestBodyText: string
): Extract<ParsedTranscriptionRequest, { kind: 'json' }> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBodyText);
  } catch (error) {
    errorExceptInTest('[transcription-proxy] Invalid JSON body:', error);
    return null;
  }

  const result = TranscriptionRequestSchema.safeParse(parsed);
  if (!result.success) {
    errorExceptInTest('[transcription-proxy] Invalid request body:', result.error.issues);
    return null;
  }

  return { kind: 'json', body: result.data };
}

async function parseTranscriptionRequest(
  request: NextRequest
): Promise<ParsedUsageRequest<ParsedTranscriptionRequest> | null> {
  const isMultipartRequest = (request.headers.get('content-type') ?? '')
    .toLowerCase()
    .startsWith('multipart/form-data');

  if (isMultipartRequest) {
    const parsedRequest = await parseMultipartTranscriptionRequest(request);
    if (!parsedRequest) return null;
    debugSaveLog(
      `multipart file="${parsedRequest.file.name}" bytes=${parsedRequest.file.size} model="${parsedRequest.model}"`,
      'log.req.txt'
    );
    return {
      kind: 'parsed',
      body: parsedRequest,
      model: parsedRequest.model,
      requestProvider: undefined,
      promptInfo: extractMultipartPromptInfo(parsedRequest.file, parsedRequest.language),
    };
  }

  const requestBodyText = await request.text();
  debugSaveProxyRequest(requestBodyText);
  const parsedRequest = parseJsonTranscriptionRequest(requestBodyText);
  if (!parsedRequest) return null;
  // OpenRouter's transcription endpoint accepts the same provider preferences
  // as chat, so the organization data-collection policy and provider routes are
  // forwarded with the request instead of rejecting it.
  const requestPrivacy = providerPreferencesSchema
    .optional()
    .safeParse(parsedRequest.body.provider);
  if (!requestPrivacy.success) return null;
  return {
    kind: 'parsed',
    body: parsedRequest,
    model: parsedRequest.body.model.trim(),
    requestProvider: requestPrivacy.data,
    promptInfo: extractTranscriptionPromptInfo(parsedRequest.body),
  };
}

const transcriptionsEndpoint: UsageEndpoint<ParsedTranscriptionRequest> = {
  apiKind: 'audio_transcriptions',
  spanPrefix: 'transcription',
  path: '/audio/transcriptions',
  // The route's maxDuration matches chat's, and so does the usage work after the response.
  durationBudgetMs: UPSTREAM_DURATION_BUDGET_MS,
  defaultFeature: '',
  allowAnonymousFreeModels: false,

  async parse(request) {
    const parsed = await parseTranscriptionRequest(request);
    return parsed ?? { kind: 'rejected', response: invalidRequestResponse() };
  },

  async resolveProvider({ requestedModelLowerCased, user, organizationId }) {
    const { provider, userByok } = await getTranscriptionProvider({
      requestedModel: requestedModelLowerCased,
      user,
      organizationId,
    });
    return { provider, userByok, isFree: isFreeModel(requestedModelLowerCased) };
  },

  // Transcriptions only route to OpenRouter, through the owner's OpenRouter key or Kilo's account.
  // OpenRouter cannot pin a region, so the gateway settings refuse Kilo's route when OpenRouter is
  // disabled or an inference region is set, and the owner's key is exempt from both.
  async buildUpstreamBody({
    body: parsedRequest,
    requestedModel,
    safetyIdentifier,
    organizationProvider,
  }) {
    if (parsedRequest.kind === 'multipart') {
      const upstreamForm = new FormData();
      upstreamForm.append('file', parsedRequest.file, parsedRequest.file.name);
      upstreamForm.append('model', requestedModel);
      if (parsedRequest.language) upstreamForm.append('language', parsedRequest.language);
      upstreamForm.append('safety_identifier', safetyIdentifier);
      upstreamForm.append('user', safetyIdentifier);
      // The multipart form takes the provider preferences as a JSON string.
      if (organizationProvider) {
        upstreamForm.append('provider', JSON.stringify(organizationProvider));
      }
      return { body: upstreamForm };
    }

    parsedRequest.body.safety_identifier = safetyIdentifier;
    parsedRequest.body.user = safetyIdentifier;
    if (organizationProvider) {
      parsedRequest.body.provider = { ...parsedRequest.body.provider, ...organizationProvider };
    }
    return { body: buildUpstreamBody(parsedRequest.body) };
  },

  accountAndRespond: upstream =>
    accountAndRewriteUsageResponse(upstream, countAndStoreTranscriptionUsage),
};

export async function handleAudioTranscriptionsRequest(
  request: NextRequest
): Promise<NextResponseType<unknown>> {
  return await handleUsageEndpointRequest(request, transcriptionsEndpoint);
}
