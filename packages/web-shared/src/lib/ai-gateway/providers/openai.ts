export function isOpenAiModel(requestedModel: string) {
  return (
    (requestedModel.includes('openai') || requestedModel.includes('gpt')) &&
    !isGptOssModel(requestedModel)
  );
}

export function isGptOssModel(requestedModel: string) {
  return requestedModel.includes('gpt-oss');
}

export const GPT_SOL_CURRENT_MODEL_ID = 'openai/gpt-6.1-sol';
