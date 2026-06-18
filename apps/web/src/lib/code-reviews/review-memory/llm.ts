import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  zodSchema,
  type LanguageModel,
} from 'ai';
import * as z from 'zod';

import { getAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import { ensureBotUserForOrg } from '@/lib/bot-users/bot-user-service';
import { DEFAULT_CODE_REVIEW_MODEL } from '@/lib/code-reviews/core/constants';
import { APP_URL } from '@/lib/constants';
import { FEATURE_HEADER } from '@/lib/feature-detection';
import { generateApiToken } from '@/lib/tokens';
import { findUserById } from '@/lib/user';
import { logExceptInTest } from '@/lib/utils.server';
import type { User } from '@kilocode/db/schema';
import type { ReviewMemoryPlatform } from '@kilocode/db/schema-types';
import type { ReviewMemoryOwner } from './db';

const MAX_DIAGNOSTIC_TEXT_LENGTH = 500;
const MAX_DIAGNOSTIC_IDENTIFIER_LENGTH = 200;
// Claude rejects these constraints at the provider boundary; the source Zod schema still validates output locally.
const UNSUPPORTED_WIRE_SCHEMA_KEYWORDS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'maxItems',
  'uniqueItems',
  'contains',
  'minContains',
  'maxContains',
  'minProperties',
  'maxProperties',
  'patternProperties',
  'propertyNames',
  'dependencies',
  'dependentRequired',
  'dependentSchemas',
  'unevaluatedProperties',
  'unevaluatedItems',
  'not',
  'if',
  'then',
  'else',
]);

const ReviewMemoryModelConfigSchema = z.object({
  model_slug: z.string().optional(),
});

export type ReviewMemoryModelOperation = 'proposal_analysis' | 'review_md_integration';
export type ReviewMemoryModelStage = 'gateway_generation' | 'structured_output_validation';
export type ReviewMemoryModelFailureClassification =
  | 'generation_failed'
  | 'incomplete_output'
  | 'invalid_structured_output'
  | 'invalid_semantic_output';

export type ReviewMemoryModelDiagnostics = {
  operation: ReviewMemoryModelOperation;
  stage: ReviewMemoryModelStage;
  outcome: 'success' | 'failure';
  requestCorrelationId: string;
  modelSlug: string;
  finishReason: string | null;
  rawFinishReason: string | null;
  generatedTextCharacterCount: number | null;
  structuredParseCandidateCharacterCount: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  providerRequestId: string | null;
  responseId: string | null;
  failureClassification: ReviewMemoryModelFailureClassification | null;
  errorClass: string | null;
  errorMessage: string | null;
};

export class ReviewMemoryModelBoundaryError extends Error {
  constructor(public readonly diagnostics: ReviewMemoryModelDiagnostics) {
    super(diagnostics.errorMessage ?? 'Review Memory model generation failed.');
    this.name = 'ReviewMemoryModelBoundaryError';
  }
}

type GenerationMetadata = Pick<
  ReviewMemoryModelDiagnostics,
  | 'finishReason'
  | 'rawFinishReason'
  | 'generatedTextCharacterCount'
  | 'structuredParseCandidateCharacterCount'
  | 'inputTokens'
  | 'outputTokens'
  | 'totalTokens'
  | 'providerRequestId'
  | 'responseId'
>;

type GenerationMetadataSource = {
  text?: string;
  finishReason?: string;
  rawFinishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  response?: {
    id?: string;
    headers?: Record<string, string>;
  };
};

type GenerateReviewMemoryStructuredOutputInput<OUTPUT> = {
  model: LanguageModel;
  modelSlug: string;
  operation: ReviewMemoryModelOperation;
  requestCorrelationId: string;
  prompt: string;
  maxOutputTokens: number;
  schemaName: string;
  schema: z.ZodType<OUTPUT>;
  wireSchema?: z.ZodType;
  validate: (output: OUTPUT) => OUTPUT;
  log?: (record: string) => void;
};

export async function resolveReviewMemoryActor(owner: ReviewMemoryOwner): Promise<User> {
  if (owner.type === 'org') {
    return await ensureBotUserForOrg(owner.id, 'code-review');
  }

  const user = await findUserById(owner.id);
  if (!user) throw new Error('Review Memory owner user not found');
  return user;
}

export async function resolveReviewMemoryModel(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
}): Promise<{ modelSlug: string }> {
  const agentConfig = await getAgentConfigForOwner(input.owner, 'code_review', input.platform);
  const parsed = ReviewMemoryModelConfigSchema.safeParse(agentConfig?.config);
  if (!parsed.success) {
    return { modelSlug: DEFAULT_CODE_REVIEW_MODEL };
  }

  return { modelSlug: parsed.data.model_slug || DEFAULT_CODE_REVIEW_MODEL };
}

export function createReviewMemoryGatewayProvider(input: {
  owner: ReviewMemoryOwner;
  actor: User;
  userAgent: string;
  fetch?: typeof globalThis.fetch;
}) {
  const headers: Record<string, string> = {
    'User-Agent': input.userAgent,
    [FEATURE_HEADER]: 'code-review-memory',
  };
  if (input.owner.type === 'org') {
    headers['X-KiloCode-OrganizationId'] = input.owner.id;
  }

  return createOpenAICompatible({
    name: 'kilo-gateway',
    baseURL: `${APP_URL}/api/openrouter`,
    apiKey: generateApiToken(input.actor, { internalApiUse: true }),
    headers,
    fetch: input.fetch,
    supportsStructuredOutputs: true,
  });
}

export async function generateReviewMemoryStructuredOutput<OUTPUT>(
  input: GenerateReviewMemoryStructuredOutputInput<OUTPUT>
): Promise<{
  output: OUTPUT;
  diagnostics: ReviewMemoryModelDiagnostics;
}> {
  const log = input.log ?? logExceptInTest;
  let finishMetadata: GenerationMetadata | undefined;
  const sourceSchema = zodSchema(input.schema);
  const providerSchema = zodSchema(input.wireSchema ?? input.schema);
  const wireSchema = jsonSchema<OUTPUT>(
    Promise.resolve(providerSchema.jsonSchema).then(schema => {
      const transformed = structuredClone(schema);
      transformReviewMemoryWireSchema(transformed);
      return transformed;
    }),
    { validate: sourceSchema.validate }
  );
  const outputSpecification = Output.object({
    schema: wireSchema,
    name: input.schemaName,
  });
  const generate = () =>
    generateText({
      model: input.model,
      prompt: input.prompt,
      maxOutputTokens: input.maxOutputTokens,
      output: outputSpecification,
      experimental_include: {
        requestBody: false,
        responseBody: false,
      },
      onFinish: event => {
        finishMetadata = getGenerationMetadata(event);
      },
    });
  let result: Awaited<ReturnType<typeof generate>>;

  try {
    result = await generate();
  } catch (error) {
    const isStructuredOutputError =
      NoObjectGeneratedError.isInstance(error) || NoOutputGeneratedError.isInstance(error);
    const metadata = NoObjectGeneratedError.isInstance(error)
      ? mergeGenerationMetadata(getGenerationMetadata(error), finishMetadata)
      : (finishMetadata ?? emptyGenerationMetadata());
    throwModelBoundaryError({
      input,
      log,
      metadata,
      stage: isStructuredOutputError ? 'structured_output_validation' : 'gateway_generation',
      classification: isStructuredOutputError ? 'invalid_structured_output' : 'generation_failed',
      sourceError: error,
    });
  }

  const metadata = getGenerationMetadata(result);
  if (result.finishReason === 'length') {
    throwModelBoundaryError({
      input,
      log,
      metadata,
      stage: 'structured_output_validation',
      classification: 'incomplete_output',
      sourceError: new Error('Generation reached its output-token limit.'),
    });
  }
  if (result.finishReason !== 'stop') {
    throwModelBoundaryError({
      input,
      log,
      metadata,
      stage: 'structured_output_validation',
      classification: 'invalid_structured_output',
      sourceError: new NoOutputGeneratedError(),
    });
  }

  let output: OUTPUT;
  try {
    output = result.output;
  } catch (error) {
    throwModelBoundaryError({
      input,
      log,
      metadata,
      stage: 'structured_output_validation',
      classification: 'invalid_structured_output',
      sourceError: error,
    });
  }

  let validated: OUTPUT;
  try {
    validated = input.validate(output);
  } catch (error) {
    throwModelBoundaryError({
      input,
      log,
      metadata,
      stage: 'structured_output_validation',
      classification: 'invalid_semantic_output',
      sourceError: error,
    });
  }

  const diagnostics = createDiagnostics({
    input,
    metadata,
    stage: 'structured_output_validation',
    outcome: 'success',
    classification: null,
    sourceError: null,
  });
  emitModelGenerationRecord(log, diagnostics);
  return { output: validated, diagnostics };
}

export function sanitizeReviewMemoryDiagnosticMessage(message: string): string {
  return message
    .replace(/https?:\/\/[^\s)>'"]+/gi, '[redacted-url]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[redacted-authorization]')
    .replace(/(?:ghs|ghu|ghp|github_pat)_[A-Za-z0-9_]+/g, '[redacted-token]')
    .replace(
      /\b(api[_ -]?key|authorization|password|secret|token)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted]'
    )
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted-value]')
    .slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH);
}

function transformReviewMemoryWireSchema(schema: unknown): void {
  const pending: unknown[] = [schema];

  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!isRecord(value)) continue;

    if (Array.isArray(value.oneOf)) {
      const existingAnyOf = Array.isArray(value.anyOf) ? value.anyOf : [];
      value.anyOf = [...existingAnyOf, ...value.oneOf];
      delete value.oneOf;
    }
    if (value.type === 'object') {
      value.additionalProperties = false;
    }

    for (const [key, nestedValue] of Object.entries(value)) {
      if (
        UNSUPPORTED_WIRE_SCHEMA_KEYWORDS.has(key) ||
        (key === 'minItems' && nestedValue !== 0 && nestedValue !== 1)
      ) {
        delete value[key];
        continue;
      }
      pending.push(nestedValue);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function throwModelBoundaryError<OUTPUT>(input: {
  input: GenerateReviewMemoryStructuredOutputInput<OUTPUT>;
  log: (record: string) => void;
  metadata: GenerationMetadata;
  stage: ReviewMemoryModelStage;
  classification: ReviewMemoryModelFailureClassification;
  sourceError: unknown;
}): never {
  const diagnostics = createDiagnostics({
    input: input.input,
    metadata: input.metadata,
    stage: input.stage,
    outcome: 'failure',
    classification: input.classification,
    sourceError: input.sourceError,
  });
  emitModelGenerationRecord(input.log, diagnostics);
  throw new ReviewMemoryModelBoundaryError(diagnostics);
}

function createDiagnostics<OUTPUT>(input: {
  input: GenerateReviewMemoryStructuredOutputInput<OUTPUT>;
  metadata: GenerationMetadata;
  stage: ReviewMemoryModelStage;
  outcome: 'success' | 'failure';
  classification: ReviewMemoryModelFailureClassification | null;
  sourceError: unknown;
}): ReviewMemoryModelDiagnostics {
  return {
    operation: input.input.operation,
    stage: input.stage,
    outcome: input.outcome,
    requestCorrelationId: input.input.requestCorrelationId,
    modelSlug: input.input.modelSlug,
    ...input.metadata,
    failureClassification: input.classification,
    errorClass: input.sourceError === null ? null : getSafeErrorClass(input.sourceError),
    errorMessage:
      input.classification === null ? null : getSafeModelBoundaryMessage(input.classification),
  };
}

function getSafeModelBoundaryMessage(
  classification: ReviewMemoryModelFailureClassification
): string {
  switch (classification) {
    case 'generation_failed':
      return 'Review Memory model generation failed.';
    case 'incomplete_output':
      return 'Review Memory structured output was incomplete.';
    case 'invalid_structured_output':
      return 'Review Memory model returned invalid structured output.';
    case 'invalid_semantic_output':
      return 'Review Memory structured output failed semantic validation.';
  }
}

function getSafeErrorClass(error: unknown): string {
  let name = 'UnknownError';
  if (error instanceof Error) {
    name = error.name;
  } else if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string'
  ) {
    name = error.name;
  }
  return name.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100) || 'UnknownError';
}

function getGenerationMetadata(source: GenerationMetadataSource): GenerationMetadata {
  const textLength = source.text?.length ?? null;
  return {
    finishReason: boundedIdentifier(source.finishReason),
    rawFinishReason: boundedIdentifier(source.rawFinishReason),
    generatedTextCharacterCount: textLength,
    structuredParseCandidateCharacterCount: textLength,
    inputTokens: source.usage?.inputTokens ?? null,
    outputTokens: source.usage?.outputTokens ?? null,
    totalTokens: source.usage?.totalTokens ?? null,
    providerRequestId: boundedIdentifier(getResponseHeader(source.response?.headers, 'request-id')),
    responseId: boundedIdentifier(source.response?.id),
  };
}

function emptyGenerationMetadata(): GenerationMetadata {
  return {
    finishReason: null,
    rawFinishReason: null,
    generatedTextCharacterCount: null,
    structuredParseCandidateCharacterCount: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    providerRequestId: null,
    responseId: null,
  };
}

function mergeGenerationMetadata(
  primary: GenerationMetadata,
  fallback: GenerationMetadata | undefined
): GenerationMetadata {
  if (!fallback) return primary;
  return {
    finishReason: primary.finishReason ?? fallback.finishReason,
    rawFinishReason: primary.rawFinishReason ?? fallback.rawFinishReason,
    generatedTextCharacterCount:
      primary.generatedTextCharacterCount ?? fallback.generatedTextCharacterCount,
    structuredParseCandidateCharacterCount:
      primary.structuredParseCandidateCharacterCount ??
      fallback.structuredParseCandidateCharacterCount,
    inputTokens: primary.inputTokens ?? fallback.inputTokens,
    outputTokens: primary.outputTokens ?? fallback.outputTokens,
    totalTokens: primary.totalTokens ?? fallback.totalTokens,
    providerRequestId: primary.providerRequestId ?? fallback.providerRequestId,
    responseId: primary.responseId ?? fallback.responseId,
  };
}

function getResponseHeader(
  headers: Record<string, string> | undefined,
  requestedName: string
): string | undefined {
  if (!headers) return undefined;
  const entry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === requestedName.toLowerCase()
  );
  return entry?.[1];
}

function boundedIdentifier(value: string | undefined): string | null {
  return value?.slice(0, MAX_DIAGNOSTIC_IDENTIFIER_LENGTH) ?? null;
}

function emitModelGenerationRecord(
  log: (record: string) => void,
  diagnostics: ReviewMemoryModelDiagnostics
): void {
  try {
    log(
      JSON.stringify({
        event: 'review_memory_model_generation',
        operation: diagnostics.operation,
        stage: diagnostics.stage,
        outcome: diagnostics.outcome,
        request_correlation_id: diagnostics.requestCorrelationId,
        vercel_deployment_id: process.env.VERCEL_DEPLOYMENT_ID ?? null,
        vercel_region: process.env.VERCEL_REGION ?? process.env.VERCEL_FUNCTION_REGION ?? null,
        model_slug: diagnostics.modelSlug,
        finish_reason: diagnostics.finishReason,
        raw_finish_reason: diagnostics.rawFinishReason,
        generated_text_character_count: diagnostics.generatedTextCharacterCount,
        structured_parse_candidate_character_count:
          diagnostics.structuredParseCandidateCharacterCount,
        input_tokens: diagnostics.inputTokens,
        output_tokens: diagnostics.outputTokens,
        total_tokens: diagnostics.totalTokens,
        provider_request_id: diagnostics.providerRequestId,
        response_id: diagnostics.responseId,
        failure_classification: diagnostics.failureClassification,
        error_class: diagnostics.errorClass,
        error_message: diagnostics.errorMessage,
      })
    );
  } catch {
    // Telemetry must not affect model-boundary behavior.
  }
}
