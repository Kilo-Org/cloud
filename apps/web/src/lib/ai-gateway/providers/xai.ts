export const GROK_CURRENT_VERCEL_MODEL_ID = 'xai/grok-4.6';

export function isGrokModel(requestedModel: string) {
  return requestedModel.includes('grok');
}
