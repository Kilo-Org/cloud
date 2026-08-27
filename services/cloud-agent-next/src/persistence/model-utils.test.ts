import { describe, expect, it } from 'vitest';
import {
  dispatchedKilocodeModelId,
  isLocalFakeDeterministicModel,
  normalizeKilocodeModel,
} from './model-utils.js';

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
  it.each([
    ['anthropic/claude-sonnet-4', 'anthropic/claude-sonnet-4'],
    ['kilo/anthropic/claude-sonnet-4', 'anthropic/claude-sonnet-4'],
    ['fake-deterministic', 'fake-deterministic'],
    ['kilo/fake-deterministic', 'fake-deterministic'],
    ['kilo-auto/free', 'kilo-auto/free'],
    ['\t kilo/vendor/Team/Model:free~Alias \n', 'vendor/Team/Model:free~Alias'],
    ['kilo/kilo/example', 'kilo/example'],
  ])('converts %j to the opaque gateway ID %j', (cloudModel, gatewayModelId) => {
    expect(dispatchedKilocodeModelId(cloudModel)).toBe(gatewayModelId);
  });

  it('returns undefined for empty input', () => {
    expect(dispatchedKilocodeModelId(undefined)).toBeUndefined();
    expect(dispatchedKilocodeModelId(null)).toBeUndefined();
    expect(dispatchedKilocodeModelId('   ')).toBeUndefined();
  });

  it.each(['', ' \t\n ', 'kilo/'])('does not produce a usable gateway ID for %j', model => {
    expect(dispatchedKilocodeModelId(model)).toBeFalsy();
  });
});

describe('isLocalFakeDeterministicModel', () => {
  it('matches the catalog id and kilo session id', () => {
    expect(isLocalFakeDeterministicModel('fake-deterministic')).toBe(true);
    expect(isLocalFakeDeterministicModel('kilo/fake-deterministic')).toBe(true);
    expect(isLocalFakeDeterministicModel('kilo-auto/efficient')).toBe(false);
  });
});
