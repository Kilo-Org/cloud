export function isOpenAiModel(requestedModel: string) {
  return (
    (requestedModel.includes('openai') || requestedModel.includes('gpt')) &&
    !isGptOssModel(requestedModel)
  );
}

export function isGptOssModel(requestedModel: string) {
  return requestedModel.includes('gpt-oss');
}

export const GPT_CURRENT_MODEL_ID = 'openai/gpt-5.6-sol';

export const GPT_CURRENT_VERCEL_MODEL_ID = GPT_CURRENT_MODEL_ID;

export const GPT_MINI_CURRENT_MODEL_ID = 'openai/gpt-5.4-mini';

export const GPT_MINI_CURRENT_VERCEL_MODEL_ID = GPT_MINI_CURRENT_MODEL_ID;

// OpenAI BYOK must be disabled on the OpenRouter website before enabling this flag.
export const ENABLE_OPENROUTER_GPT56_PROMO = false;

export const OPENROUTER_GPT56_PROMO_MODEL_IDS = [
  'openai/gpt-5.6-terra',
  'openai/gpt-5.6-terra-pro',
  'openai/gpt-5.6-luna',
  'openai/gpt-5.6-luna-pro',
] as const;

export function isOpenRouterGpt56PromoModel(modelId: string): boolean {
  return (
    ENABLE_OPENROUTER_GPT56_PROMO &&
    OPENROUTER_GPT56_PROMO_MODEL_IDS.some(promoModelId => promoModelId === modelId)
  );
}
