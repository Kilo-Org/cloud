export function isClaudeModel(requestedModel: string) {
  return requestedModel.includes('claude');
}

export function isOpenAiModel(requestedModel: string) {
  return (
    (requestedModel.includes('openai') || requestedModel.includes('gpt')) &&
    !isGptOssModel(requestedModel)
  );
}

export function isGptOssModel(requestedModel: string) {
  return requestedModel.includes('gpt-oss');
}

export function isGrokModel(requestedModel: string) {
  return requestedModel.includes('grok');
}

export function isMuseModel(model: string) {
  return model.includes('muse-');
}

export function isMinimaxModel(model: string) {
  return model.includes('minimax');
}

export function isQwenModel(model: string) {
  return model.includes('qwen');
}
