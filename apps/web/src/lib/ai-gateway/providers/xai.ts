export const GROK_CURRENT_VERCEL_MODEL_ID = 'xai/grok-4.3';

export function isGrokModel(requestedModel: string) {
  return requestedModel.includes('grok');
}

export function isGrokToggleableReasoningModel(model: string) {
  return model.includes('grok-4.2');
}
