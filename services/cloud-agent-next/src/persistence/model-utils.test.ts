import { describe, expect, it } from 'vitest';
import {
  gatewayModelIdCases,
  invalidCloudModelIds,
} from '../../test/fixtures/gateway-model-ids.js';
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
  it.each(gatewayModelIdCases)(
    'converts $cloudModel to the opaque gateway ID $gatewayModelId',
    ({ cloudModel, gatewayModelId }) => {
      expect(dispatchedKilocodeModelId(cloudModel)).toBe(gatewayModelId);
    }
  );

  it.each([undefined, null])('returns undefined for omitted input %s', model => {
    expect(dispatchedKilocodeModelId(model)).toBeUndefined();
  });

  it.each(invalidCloudModelIds)('does not produce a usable gateway ID for %j', model => {
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
