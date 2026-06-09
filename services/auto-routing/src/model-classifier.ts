import type { OpenRouter } from '@openrouter/sdk';
import type { ChatResult } from '@openrouter/sdk/models';
import { buildClassifierMessages, CLASSIFIER_MODEL } from './classifier-prompt';
import type { NormalizedClassifierInput } from './classifier-input';
import { parseClassifierOutput, type ClassifierOutput } from './classification';
import { createOpenRouterClient } from './openrouter';

export type ClassifierRunResult = {
  cost: number | null;
  classification: ClassifierOutput;
};

type ClassifierEnv = Pick<Env, 'OPENROUTER_API_KEY'>;

export async function classifyNormalizedInput(
  env: ClassifierEnv,
  input: NormalizedClassifierInput
): Promise<ClassifierRunResult> {
  return classifyWithOpenRouter(await createOpenRouterClient(env), input);
}

export async function classifyWithOpenRouter(
  client: OpenRouter,
  input: NormalizedClassifierInput
): Promise<ClassifierRunResult> {
  const result = await client.chat.send({
    chatRequest: {
      model: CLASSIFIER_MODEL,
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
  const content = result.choices[0]?.message.content as unknown;
  if (typeof content === 'string' && content.trim().length > 0) {
    return content;
  }

  throw new Error('Classifier model returned no text');
}
