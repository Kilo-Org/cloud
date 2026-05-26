import { describe, expect, it } from 'vitest';
import { dispatchedKilocodeModelId, normalizeKilocodeModel } from './model-utils.js';

describe('normalizeKilocodeModel', () => {
  it('returns undefined for empty input', () => {
    expect(normalizeKilocodeModel(undefined)).toBeUndefined();
    expect(normalizeKilocodeModel(null)).toBeUndefined();
    expect(normalizeKilocodeModel('')).toBeUndefined();
    expect(normalizeKilocodeModel('   ')).toBeUndefined();
  });

  it('prefixes non-kilo models', () => {
    expect(normalizeKilocodeModel('code')).toBe('kilo/code');
    expect(normalizeKilocodeModel('anthropic/claude-sonnet-4')).toBe(
      'kilo/anthropic/claude-sonnet-4'
    );
  });

  it('preserves existing kilo prefix', () => {
    expect(normalizeKilocodeModel('kilo/code')).toBe('kilo/code');
    expect(normalizeKilocodeModel('kilo/anthropic/claude-sonnet-4')).toBe(
      'kilo/anthropic/claude-sonnet-4'
    );
  });
});

describe('dispatchedKilocodeModelId', () => {
  it('returns the model ID sent to the kilo provider', () => {
    expect(dispatchedKilocodeModelId('anthropic/claude-sonnet-4')).toBe(
      'anthropic/claude-sonnet-4'
    );
    expect(dispatchedKilocodeModelId('kilo/anthropic/claude-sonnet-4')).toBe(
      'anthropic/claude-sonnet-4'
    );
    expect(dispatchedKilocodeModelId('kilo-auto/free')).toBe('kilo-auto/free');
  });

  it('returns undefined for empty input', () => {
    expect(dispatchedKilocodeModelId(undefined)).toBeUndefined();
    expect(dispatchedKilocodeModelId('   ')).toBeUndefined();
  });
});
