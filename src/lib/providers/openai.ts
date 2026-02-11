export function isOpenAiModel(requestedModel: string) {
  return requestedModel.startsWith('openai/') && !requestedModel.startsWith('openai/gpt-oss');
}
