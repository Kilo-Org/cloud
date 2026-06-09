import type { OpenRouter } from '@openrouter/sdk';
import type { ChatResult } from '@openrouter/sdk/models';
import { getClassifierModel } from './classifier-config';
import { buildClassifierMessages } from './classifier-prompt';
import type { NormalizedClassifierInput } from './classifier-input';
import { parseClassifierOutput, type ClassifierOutput } from './classification';
import { createOpenRouterClient } from './openrouter';

export type ClassifierRunResult = {
  cost: number | null;
  classification: ClassifierOutput;
};

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
      maxTokens: 400,
    },
  });

  return {
    cost: result.usage?.cost ?? null,
    classification: parseClassifierOutput(extractClassifierText(result)),
  };
}

function extractClassifierText(result: ChatResult) {
  const content: unknown = result.choices[0]?.message.content;
  if (typeof content === 'string' && content.trim().length > 0) {
    return content;
  }

  throw new Error('Classifier model returned no text');
}
