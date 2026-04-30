export function isGptModel(requestedModel: string) {
  return requestedModel.includes('gpt') && !isGptOssModel(requestedModel);
}

export function isGptOssModel(requestedModel: string) {
  return requestedModel.includes('gpt-oss');
}
