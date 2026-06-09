import { buildClassifierMessages, CLASSIFIER_MODEL } from './classifier-prompt';
import type { NormalizedClassifierInput } from './classifier-input';
import { parseClassifierOutput, type ClassifierOutput } from './classification';
import { createOpenRouterClient } from './openrouter';

type ClassifierChatRequest = {
  chatRequest: {
    model: typeof CLASSIFIER_MODEL;
    messages: ReturnType<typeof buildClassifierMessages>;
    responseFormat: { type: 'json_object' };
    stream: false;
    temperature: 0;
    maxTokens: 400;
  };
};

type ClassifierChatResult = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
};

export type ClassifierClient = {
  chat: {
    send(request: ClassifierChatRequest): Promise<ClassifierChatResult>;
  };
};

type ClassifierEnv = Pick<Env, 'OPENROUTER_API_KEY'>;

export async function classifyNormalizedInput(
  env: ClassifierEnv,
  input: NormalizedClassifierInput
): Promise<ClassifierOutput> {
  return classifyWithOpenRouter(createOpenRouterClient(env), input);
}

export async function classifyWithOpenRouter(
  client: ClassifierClient,
  input: NormalizedClassifierInput
): Promise<ClassifierOutput> {
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

  return parseClassifierOutput(extractClassifierText(result));
}

function extractClassifierText(result: ClassifierChatResult) {
  const content = result.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim().length > 0) {
    return content;
  }

  throw new Error('Classifier model returned no text');
}
