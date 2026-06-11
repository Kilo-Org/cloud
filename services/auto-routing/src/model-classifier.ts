import type { OpenRouter } from '@openrouter/sdk';
import type { ChatResult } from '@openrouter/sdk/models';
import { getClassifierModel } from './classifier-config';
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
};

export type ClassifierModelCallMeta = {
  finishReason: string | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  textHead: string | null;
  textTail: string | null;
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

type ClassifierEnv = Pick<Env, 'AUTO_ROUTING_CONFIG' | 'OPENROUTER_API_KEY'>;

export async function classifyNormalizedInput(
  env: ClassifierEnv,
  input: NormalizedClassifierInput
): Promise<ClassifierRunResult> {
  const [client, classifierModel] = await Promise.all([
    createOpenRouterClient(env),
    getClassifierModel(env),
  ]);

  return classifyWithOpenRouter(client, input, classifierModel);
}

export async function classifyWithOpenRouter(
  client: OpenRouter,
  input: NormalizedClassifierInput,
  classifierModel: string
): Promise<ClassifierRunResult> {
  const result = await client.chat.send({
    chatRequest: {
      model: classifierModel,
      messages: buildClassifierMessages(input),
      responseFormat: { type: 'json_object' },
      stream: false,
      temperature: 0,
      maxTokens: CLASSIFIER_MAX_TOKENS,
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
    textHead: text?.slice(0, 200) ?? null,
    textTail: text && text.length > 200 ? text.slice(-100) : null,
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
