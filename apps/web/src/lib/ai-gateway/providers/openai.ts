export function isOpenAiModel(requestedModel: string) {
  return (
    (requestedModel.includes('openai') || requestedModel.includes('gpt')) &&
    !isGptOssModel(requestedModel)
  );
}

export function isGptOssModel(requestedModel: string) {
  return requestedModel.includes('gpt-oss');
}

export const GPT_CURRENT_MODEL_ID = 'openai/gpt-5.5';

export const GPT_CURRENT_VERCEL_MODEL_ID = GPT_CURRENT_MODEL_ID;

export const GPT_MINI_CURRENT_MODEL_ID = 'openai/gpt-5.4-mini';

export const GPT_MINI_CURRENT_VERCEL_MODEL_ID = GPT_MINI_CURRENT_MODEL_ID;
