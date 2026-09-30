export const CLAUDE_OPUS_FALLBACK_MODEL_ID = 'anthropic/claude-opus-4.8';
export const CLAUDE_OPUS_4_8_STEALTH_MODEL_ID = 'stealth/claude-opus-4.8';
export const CLAUDE_OPUS_STEALTH_MODEL_ID = 'stealth/claude-opus-4.7';
export const CLAUDE_SONNET_STEALTH_MODEL_ID = 'stealth/claude-sonnet-4.6';
export const CLAUDE_OPUS_4_6_STEALTH_MODEL_ID = 'stealth/claude-opus-4.6';

export function isClaudeModel(requestedModel: string) {
  return requestedModel.includes('claude');
}

export function isFableModel(requestedModel: string) {
  return requestedModel.includes('claude-fable');
}

export function isOpus5Model(requestedModel: string) {
  return requestedModel.includes('claude-opus-5');
}
