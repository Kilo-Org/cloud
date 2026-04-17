export function isOpenAiModel(requestedModel: string) {
  return requestedModel.startsWith('openai/') && !requestedModel.startsWith('openai/gpt-oss');
}

export function isOpenAiOssModel(requestedModel: string) {
  return requestedModel.startsWith('openai/gpt-oss');
}

export const GPT_5_NANO_ID = 'openai/gpt-5-nano';

export const GPT_5_NANO_NAME = 'GPT-5 Nano';
