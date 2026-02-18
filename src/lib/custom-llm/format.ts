export enum ReasoningFormat {
  Unknown = 'unknown',
  OpenAIResponsesV1 = 'openai-responses-v1',
  XAIResponsesV1 = 'xai-responses-v1',
  AnthropicClaudeV1 = 'anthropic-claude-v1',
  GoogleGeminiV1 = 'google-gemini-v1',

  // this is a hack to prevent the extension from stripping ids
  // https://github.com/Kilo-Org/kilocode/blob/e47803d78f14fe49173d1a4b5bdd0a0e3a3901ed/src/api/transform/openai-format.ts#L308
  OpenAIResponsesV1_Obscured = 'openai-responses-v1-obscured',
}

// Anthropic Claude was the first reasoning that we're
// passing back and forth
export const DEFAULT_REASONING_FORMAT = ReasoningFormat.AnthropicClaudeV1;
