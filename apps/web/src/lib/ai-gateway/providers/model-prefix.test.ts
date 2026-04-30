import { modelStartsWith, stripModelTilde } from './model-prefix';
import { isClaudeModel, isHaikuModel, isOpusModel } from './anthropic.constants';
import { isOpenAiModel, isGptOssModel } from './openai';
import { isGeminiModel, isGemmaModel, isGemini3Model } from './google';
import { isKimiModel } from './moonshotai';
import { isGrokModel, isGrok4Model } from './xai';
import { isGlmModel } from './zai';
import { isMinimaxModel } from './minimax';
import { isStepModel } from './stepfun';
import { isCodestralModel, isMistralModel } from './mistral';
import { inferVercelFirstPartyInferenceProviderForModel } from './openrouter/inference-provider-id';

describe('modelStartsWith', () => {
  test('matches the bare prefix', () => {
    expect(modelStartsWith('anthropic/claude-sonnet-4.5', 'anthropic/')).toBe(true);
  });

  test('matches the tilde-prefixed variant', () => {
    expect(modelStartsWith('~anthropic/claude-sonnet-4.5', 'anthropic/')).toBe(true);
  });

  test('rejects unrelated prefixes', () => {
    expect(modelStartsWith('openai/gpt-5', 'anthropic/')).toBe(false);
    expect(modelStartsWith('~openai/gpt-5', 'anthropic/')).toBe(false);
  });
});

describe('stripModelTilde', () => {
  test('removes a leading tilde', () => {
    expect(stripModelTilde('~anthropic/claude-sonnet-4.5')).toBe('anthropic/claude-sonnet-4.5');
  });

  test('leaves untilded ids alone', () => {
    expect(stripModelTilde('anthropic/claude-sonnet-4.5')).toBe('anthropic/claude-sonnet-4.5');
  });
});

describe('provider predicates match substrings, regardless of prefix', () => {
  test('isClaudeModel / isHaikuModel / isOpusModel', () => {
    expect(isClaudeModel('~anthropic/claude-sonnet-4.5')).toBe(true);
    expect(isClaudeModel('anthropic/claude-sonnet-4.5')).toBe(true);
    expect(isClaudeModel('claude-sonnet-4-6')).toBe(true);
    expect(isClaudeModel('openai/gpt-5')).toBe(false);
    expect(isHaikuModel('~anthropic/claude-haiku-4.5')).toBe(true);
    expect(isHaikuModel('claude-haiku-4-6')).toBe(true);
    expect(isOpusModel('~anthropic/claude-opus-4.7')).toBe(true);
    expect(isOpusModel('claude-opus-4-7')).toBe(true);
  });

  test('isOpenAiModel / isGptOssModel', () => {
    expect(isOpenAiModel('~openai/gpt-5-nano')).toBe(true);
    expect(isOpenAiModel('openai/gpt-5-nano')).toBe(true);
    expect(isOpenAiModel('openai/o3')).toBe(true);
    expect(isOpenAiModel('openai/codex-mini')).toBe(true);
    expect(isOpenAiModel('gpt-5.5')).toBe(true);
    expect(isOpenAiModel('~openai/gpt-oss')).toBe(false);
    expect(isGptOssModel('~openai/gpt-oss')).toBe(true);
    expect(isGptOssModel('gpt-oss-20b')).toBe(true);
  });

  test('google helpers', () => {
    expect(isGeminiModel('~google/gemini-2.5-flash-lite')).toBe(true);
    expect(isGeminiModel('gemini-2.5-flash-lite')).toBe(true);
    expect(isGemmaModel('~google/gemma-4-31b-it')).toBe(true);
    expect(isGemini3Model('~google/gemini-3-pro')).toBe(true);
    expect(isGemini3Model('gemini-3-pro')).toBe(true);
    expect(isGemini3Model('gemini-2.5-flash-lite')).toBe(false);
  });

  test('isKimiModel', () => {
    expect(isKimiModel('~moonshotai/kimi-k2.6')).toBe(true);
    expect(isKimiModel('kimi-k2.6')).toBe(true);
  });

  test('isGrokModel / isGrok4Model', () => {
    expect(isGrokModel('x-ai/grok-code-fast-1')).toBe(true);
    expect(isGrokModel('grok-4.1-fast')).toBe(true);
    expect(isGrok4Model('x-ai/grok-4')).toBe(true);
    expect(isGrok4Model('grok-4.1-fast')).toBe(true);
    expect(isGrok4Model('x-ai/grok-code-fast-1')).toBe(false);
  });

  test('isGlmModel', () => {
    expect(isGlmModel('z-ai/glm-4.7-flash')).toBe(true);
    expect(isGlmModel('glm-5.1')).toBe(true);
  });

  test('isMinimaxModel', () => {
    expect(isMinimaxModel('minimax/minimax-m2.5')).toBe(true);
    expect(isMinimaxModel('minimax-m2.7')).toBe(true);
  });

  test('isStepModel', () => {
    expect(isStepModel('stepfun/step-3.5-flash')).toBe(true);
    expect(isStepModel('step-3.5-flash')).toBe(true);
  });

  test('isMistralModel / isCodestralModel', () => {
    expect(isMistralModel('mistralai/devstral-2')).toBe(true);
    expect(isMistralModel('mistralai/codestral')).toBe(true);
    expect(isCodestralModel('mistralai/codestral')).toBe(true);
    expect(isCodestralModel('mistralai/devstral-2')).toBe(false);
  });

  test('inferVercelFirstPartyInferenceProviderForModel strips tilde', () => {
    expect(inferVercelFirstPartyInferenceProviderForModel('~anthropic/claude-sonnet-4.5')).toBe(
      'anthropic'
    );
    expect(inferVercelFirstPartyInferenceProviderForModel('~openai/gpt-5-nano')).toBe('openai');
    expect(inferVercelFirstPartyInferenceProviderForModel('~openai/gpt-oss')).toBe(null);
  });
});
