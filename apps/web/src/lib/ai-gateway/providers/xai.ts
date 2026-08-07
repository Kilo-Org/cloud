export const GROK_CURRENT_MODEL_ID = 'x-ai/grok-4.5';
export const GROK_CURRENT_VERCEL_MODEL_ID = 'xai/grok-4.5';

export function isGrokModel(requestedModel: string) {
  return requestedModel.includes('grok');
}
