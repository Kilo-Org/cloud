import { describe, expect, it } from 'vitest';

import { classifyLocalRuntimeCatalogError } from './local-runtime-catalog-errors';

describe('classifyLocalRuntimeCatalogError', () => {
  it('classifies CLI_UPGRADE_REQUIRED as non-retryable capability with the exact copy', () => {
    const result = classifyLocalRuntimeCatalogError({
      data: { upstreamCode: 'CLI_UPGRADE_REQUIRED' },
    });
    expect(result.kind).toBe('non-retryable-capability');
    if (result.kind !== 'non-retryable-capability') {
      throw new Error('expected non-retryable');
    }
    expect(result.title).toBe('Update Kilo CLI');
    expect(result.message).toBe('Update Kilo CLI and reconnect.');
  });

  it('classifies INVALID_RUNTIME_RESPONSE as non-retryable malformed', () => {
    const result = classifyLocalRuntimeCatalogError({
      data: { upstreamCode: 'INVALID_RUNTIME_RESPONSE' },
    });
    expect(result.kind).toBe('non-retryable-malformed');
  });

  it('classifies RESULT_TOO_LARGE as non-retryable malformed', () => {
    const result = classifyLocalRuntimeCatalogError({
      data: { upstreamCode: 'RESULT_TOO_LARGE' },
    });
    expect(result.kind).toBe('non-retryable-malformed');
  });

  it('classifies a missing/unknown upstream code as non-retryable malformed', () => {
    expect(classifyLocalRuntimeCatalogError({ data: {} }).kind).toBe('non-retryable-malformed');
    expect(classifyLocalRuntimeCatalogError({ data: { upstreamCode: 'BOGUS' } }).kind).toBe(
      'non-retryable-malformed'
    );
  });

  it('classifies RUNTIME_NOT_CONNECTED as retryable with the exact copy', () => {
    const result = classifyLocalRuntimeCatalogError({
      data: { upstreamCode: 'RUNTIME_NOT_CONNECTED' },
    });
    expect(result.kind).toBe('retryable');
    if (result.kind !== 'retryable') {
      throw new Error('expected retryable');
    }
    expect(result.title).toBe("Couldn't load runtime catalog");
    expect(result.message).toBe('Check that kilo remote is still connected, then try again.');
  });

  it('classifies a plain network error (no upstreamCode) as retryable', () => {
    expect(classifyLocalRuntimeCatalogError(new Error('network down')).kind).toBe('retryable');
  });
});
