export function isGrokModel(requestedModel: string) {
  return requestedModel.includes('grok');
}

export function isGrokToggleableReasoningModel(model: string) {
  return model.includes('grok-4.2');
}
