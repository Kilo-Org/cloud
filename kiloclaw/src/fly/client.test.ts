import { describe, it, expect, vi } from 'vitest';
import { FlyApiError, isFlyNotFound, isFlyInsufficientResources } from './client';

describe('isFlyNotFound', () => {
  it('returns true for FlyApiError with status 404', () => {
    const err = new FlyApiError('not found', 404, '{}');
    expect(isFlyNotFound(err)).toBe(true);
  });

  it('returns false for FlyApiError with non-404 status', () => {
    const err = new FlyApiError('server error', 500, '{}');
    expect(isFlyNotFound(err)).toBe(false);
  });

  it('returns false for generic Error', () => {
    expect(isFlyNotFound(new Error('something'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isFlyNotFound('string')).toBe(false);
    expect(isFlyNotFound(null)).toBe(false);
    expect(isFlyNotFound(undefined)).toBe(false);
    expect(isFlyNotFound(42)).toBe(false);
  });
});

describe('isFlyInsufficientResources', () => {
  // -- Confirmed production payload --

  it('matches production payload: insufficient resources + existing volume', () => {
    const body =
      '{"error":"insufficient resources to create new machine with existing volume \'vol_4y5gkog8p5kj839r\'"}';
    const err = new FlyApiError(`Fly API createMachine failed (412): ${body}`, 412, body);
    expect(isFlyInsufficientResources(err)).toBe(true);
  });

  it('matches capacity marker case-insensitively', () => {
    const body = '{"error":"Insufficient Resources for volume"}';
    const err = new FlyApiError(`Fly API failed (412): ${body}`, 412, body);
    expect(isFlyInsufficientResources(err)).toBe(true);
  });

  it('matches capacity marker in non-JSON body text', () => {
    const body = 'insufficient resources to create machine';
    const err = new FlyApiError(`Fly API failed (412): ${body}`, 412, body);
    expect(isFlyInsufficientResources(err)).toBe(true);
  });

  // -- Version/precondition 412s: must NOT trigger recovery --

  it('returns false for version/precondition 412s', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // These are hypothetical but represent the class of 412s we must NOT match
    const preconditionBodies = [
      '{"error":"min_secrets_version 3 is not yet available on this app"}',
      '{"error":"machine_version mismatch: expected 5, got 4"}',
      '{"error":"precondition failed: current_version does not match"}',
    ];

    for (const body of preconditionBodies) {
      const err = new FlyApiError(`Fly API failed (412): ${body}`, 412, body);
      expect(isFlyInsufficientResources(err)).toBe(false);
    }

    warnSpy.mockRestore();
  });

  // -- Unclassified 412: should return false and warn --

  it('returns false and logs warning for unclassified 412', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = '{"error":"some unknown 412 reason"}';
    const err = new FlyApiError(`Fly API failed (412): ${body}`, 412, body);

    expect(isFlyInsufficientResources(err)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      '[fly] Unclassified 412 error (not treated as capacity):',
      body
    );
    warnSpy.mockRestore();
  });

  // -- Non-412 and non-FlyApiError --

  it('returns false for non-412 status', () => {
    expect(isFlyInsufficientResources(new FlyApiError('not found', 404, '{}'))).toBe(false);
    expect(isFlyInsufficientResources(new FlyApiError('server error', 500, '{}'))).toBe(false);
  });

  it('returns false for generic Error', () => {
    expect(isFlyInsufficientResources(new Error('something'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isFlyInsufficientResources('string')).toBe(false);
    expect(isFlyInsufficientResources(null)).toBe(false);
    expect(isFlyInsufficientResources(undefined)).toBe(false);
  });
});
