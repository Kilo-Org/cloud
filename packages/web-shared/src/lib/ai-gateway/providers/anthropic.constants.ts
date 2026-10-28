export const CLAUDE_SONNET_CURRENT_MODEL_ID = 'anthropic/claude-sonnet-5.5';
export const CLAUDE_OPUS_CURRENT_MODEL_ID = 'anthropic/claude-opus-5.5';

export function isClaudeModel(requestedModel: string) {
  return requestedModel.includes('claude');
}
