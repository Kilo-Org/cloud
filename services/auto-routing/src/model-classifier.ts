import type { OpenRouter } from '@openrouter/sdk';
import type { ChatResult } from '@openrouter/sdk/models';
import { buildClassifierMessages, CLASSIFIER_MAX_TOKENS } from './classifier-prompt';
import type { NormalizedClassifierInput } from './classifier-input';
import {
  ClassifierOutputParseError,
  parseClassifierOutput,
  type ClassifierOutput,
} from './classifier-output';
import { fallbackClassifierOutput } from './classifier-output/fallback';
import { createOpenRouterClient } from './openrouter';

export type ClassifierRunResult = {
  cost: number | null;
  classifierModel: string;
  classification: ClassifierOutput;
  fallback?: ClassifierRunFallbackMetadata;
  modelCallMeta?: ClassifierModelCallMeta;
  retried?: boolean;
  // Why the first attempt was retried; present only when retried is true.
  firstAttemptFailure?: {
    reason: string;
    failureStage: string | null;
    finishReason: string | null;
  };
};

export type ClassifierModelCallMeta = {
  finishReason: string | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  // Length only — the raw output is derived from untrusted, mirrored user
  // prompts and must not reach persistent logs. Combined with finishReason
  // and token counts this still distinguishes truncation from prompt echo.
  textLength: number | null;
};

export type ClassifierRunFailureMetadata = {
  cost: number | null;
  classifierModel: string;
  failureStage?: string;
  schemaIssueSummary?: string[];
  topLevelKeys?: string[];
};

export type ClassifierRunFallbackMetadata = {
  reason: 'no_text' | 'invalid_output';
  failureStage?: string;
  schemaIssueSummary?: string[];
  topLevelKeys?: string[];
};

export class ClassifierRunError extends Error {
  readonly cost: number | null;
  readonly classifierModel: string;
  readonly failureStage?: string;
  readonly schemaIssueSummary: string[];
  readonly topLevelKeys: string[];

  constructor(message: string, metadata: ClassifierRunFailureMetadata) {
    super(message);
    this.name = 'ClassifierRunError';
    this.cost = metadata.cost;
    this.classifierModel = metadata.classifierModel;
    this.failureStage = metadata.failureStage;
    this.schemaIssueSummary = metadata.schemaIssueSummary ?? [];
    this.topLevelKeys = metadata.topLevelKeys ?? [];
  }
}

type ClassifierEnv = Pick<Env, 'OPENROUTER_API_KEY'>;

export type ClassifierCallOptions = {
  // Sticky routing key passed to OpenRouter so requests from the same
  // session land on the same provider and reuse its prompt cache.
  openrouterSessionId?: string;
};

export async function classifyNormalizedInput(
  env: ClassifierEnv,
  input: NormalizedClassifierInput,
  classifierModel: string,
  options: ClassifierCallOptions = {}
): Promise<ClassifierRunResult> {
  const client = await createOpenRouterClient(env);
  return classifyWithOpenRouter(client, input, classifierModel, options);
}

export async function classifyWithOpenRouter(
  client: OpenRouter,
  input: NormalizedClassifierInput,
  classifierModel: string,
  options: ClassifierCallOptions = {}
): Promise<ClassifierRunResult> {
  // Invalid output is usually a transient provider glitch (responses cut
  // off after a handful of tokens with a "stop" finish reason), so one
  // retry recovers most of those classifications.
  const firstAttempt = await runClassifierAttempt(client, input, classifierModel, options);
  if (!firstAttempt.fallback) {
    return firstAttempt;
  }

  let retryAttempt: ClassifierRunResult;
  try {
    retryAttempt = await runClassifierAttempt(client, input, classifierModel, options);
  } catch (error) {
    // The retry threw (e.g. a transport error) after the first attempt had
    // already billed and produced diagnostics. Surface those rather than
    // letting the raw error escape and underreport spend.
    throw new ClassifierRunError(
      error instanceof Error ? error.message : 'classifier retry failed',
      {
        cost: firstAttempt.cost,
        classifierModel,
        failureStage: firstAttempt.fallback.failureStage ?? firstAttempt.fallback.reason,
        schemaIssueSummary: firstAttempt.fallback.schemaIssueSummary,
        topLevelKeys: firstAttempt.fallback.topLevelKeys,
      }
    );
  }
  return {
    ...retryAttempt,
    cost: sumCosts(firstAttempt.cost, retryAttempt.cost),
    retried: true,
    firstAttemptFailure: {
      reason: firstAttempt.fallback.reason,
      failureStage: firstAttempt.fallback.failureStage ?? null,
      finishReason: firstAttempt.modelCallMeta?.finishReason ?? null,
    },
  };
}

function sumCosts(first: number | null, second: number | null): number | null {
  if (first === null && second === null) return null;
  return (first ?? 0) + (second ?? 0);
}

async function runClassifierAttempt(
  client: OpenRouter,
  input: NormalizedClassifierInput,
  classifierModel: string,
  options: ClassifierCallOptions
): Promise<ClassifierRunResult> {
  const result = await client.chat.send({
    chatRequest: {
      model: classifierModel,
      messages: buildClassifierMessages(input),
      responseFormat: { type: 'json_object' },
      stream: false,
      temperature: 0,
      maxTokens: CLASSIFIER_MAX_TOKENS,
      ...(options.openrouterSessionId ? { sessionId: options.openrouterSessionId } : {}),
    },
  });

  const cost = result.usage?.cost ?? null;
  const text = extractClassifierText(result);
  const modelCallMeta = extractModelCallMeta(result, text);
  if (!text) {
    return fallbackClassifierResult(input, classifierModel, cost, modelCallMeta, {
      reason: 'no_text',
    });
  }

  try {
    return {
      cost,
      classifierModel,
      classification: parseClassifierOutput(text),
      modelCallMeta,
    };
  } catch (error) {
    return fallbackClassifierResult(input, classifierModel, cost, modelCallMeta, {
      reason: 'invalid_output',
      ...(error instanceof ClassifierOutputParseError
        ? {
            failureStage: error.failureStage,
            schemaIssueSummary: error.schemaIssueSummary,
            topLevelKeys: error.topLevelKeys,
          }
        : {}),
    });
  }
}

function extractModelCallMeta(result: ChatResult, text: string | null): ClassifierModelCallMeta {
  return {
    finishReason: result.choices[0]?.finishReason ?? null,
    completionTokens: result.usage?.completionTokens ?? null,
    reasoningTokens: result.usage?.completionTokensDetails?.reasoningTokens ?? null,
    textLength: text?.length ?? null,
  };
}

function fallbackClassifierResult(
  input: NormalizedClassifierInput,
  classifierModel: string,
  cost: number | null,
  modelCallMeta: ClassifierModelCallMeta,
  fallback: ClassifierRunFallbackMetadata
): ClassifierRunResult {
  return {
    cost,
    classifierModel,
    classification: fallbackClassifierOutput(input),
    fallback,
    modelCallMeta,
  };
}

function extractClassifierText(result: ChatResult) {
  const content: unknown = result.choices[0]?.message.content;
  if (typeof content === 'string' && content.trim().length > 0) {
    return content;
  }
  return null;
}
