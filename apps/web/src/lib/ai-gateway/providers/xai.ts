export const GROK_CURRENT_VERCEL_MODEL_ID = 'spacexai/grok-4.7';

export function isGrokModel(requestedModel: string) {
  return requestedModel.includes('grok');
}
