import { modelStartsWith, stripModelTilde } from './model-prefix';
import { isAnthropicModel, isHaikuModel } from './anthropic.constants';
import { isOpenAiModel, isOpenAiOssModel } from './openai';
import { isGeminiModel, isGemmaModel, isGemini3Model } from './google';
import { isMoonshotModel } from './moonshotai';
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

describe('provider predicates accept tilde-prefixed model ids', () => {
  test('isAnthropicModel / isHaikuModel', () => {
    expect(isAnthropicModel('~anthropic/claude-sonnet-4.5')).toBe(true);
    expect(isHaikuModel('~anthropic/claude-haiku-4.5')).toBe(true);
  });

  test('isOpenAiModel / isOpenAiOssModel', () => {
    expect(isOpenAiModel('~openai/gpt-5-nano')).toBe(true);
    expect(isOpenAiModel('~openai/gpt-oss')).toBe(false);
    expect(isOpenAiOssModel('~openai/gpt-oss')).toBe(true);
  });

  test('google helpers', () => {
    expect(isGeminiModel('~google/gemini-2.5-flash-lite')).toBe(true);
    expect(isGemmaModel('~google/gemma-4-31b-it')).toBe(true);
    expect(isGemini3Model('~google/gemini-3-pro')).toBe(true);
  });

  test('isMoonshotModel', () => {
    expect(isMoonshotModel('~moonshotai/kimi-k2.6')).toBe(true);
  });

  test('inferVercelFirstPartyInferenceProviderForModel strips tilde', () => {
    expect(inferVercelFirstPartyInferenceProviderForModel('~anthropic/claude-sonnet-4.5')).toBe(
      'anthropic'
    );
    expect(inferVercelFirstPartyInferenceProviderForModel('~openai/gpt-5-nano')).toBe('openai');
    expect(inferVercelFirstPartyInferenceProviderForModel('~openai/gpt-oss')).toBe(null);
  });
});
