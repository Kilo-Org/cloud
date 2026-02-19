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
  // -- Capacity signals: should return true --

  it('matches exact production payload (insufficient resources + existing volume)', () => {
    const body =
      '{"error":"insufficient resources to create new machine with existing volume \'vol_4y5gkog8p5kj839r\'"}';
    const err = new FlyApiError(`Fly API createMachine failed (412): ${body}`, 412, body);
    expect(isFlyInsufficientResources(err)).toBe(true);
  });

  it('matches insufficient_capacity in json.status field', () => {
    const body = '{"status":"insufficient_capacity","error":"no hosts available"}';
    const err = new FlyApiError(`Fly API failed (412): ${body}`, 412, body);
    expect(isFlyInsufficientResources(err)).toBe(true);
  });

  it('matches "no capacity" in json.error field', () => {
    const body = '{"error":"no capacity in region iad"}';
    const err = new FlyApiError(`Fly API failed (412): ${body}`, 412, body);
    expect(isFlyInsufficientResources(err)).toBe(true);
  });

  it('matches "at capacity" in json.error field', () => {
    const body = '{"error":"host at capacity"}';
    const err = new FlyApiError(`Fly API failed (412): ${body}`, 412, body);
    expect(isFlyInsufficientResources(err)).toBe(true);
  });

  it('matches capacity markers case-insensitively', () => {
    const body = '{"error":"Insufficient Resources for volume"}';
    const err = new FlyApiError(`Fly API failed (412): ${body}`, 412, body);
    expect(isFlyInsufficientResources(err)).toBe(true);
  });

  it('matches capacity markers in non-JSON body text', () => {
    const body = 'insufficient resources to create machine';
    const err = new FlyApiError(`Fly API failed (412): ${body}`, 412, body);
    expect(isFlyInsufficientResources(err)).toBe(true);
  });

  // -- Version/precondition signals: should return false --

  it('returns false for min_secrets_version mismatch', () => {
    const body = '{"error":"min_secrets_version 3 is not yet available on this app"}';
    const err = new FlyApiError(`Fly API failed (412): ${body}`, 412, body);
    expect(isFlyInsufficientResources(err)).toBe(false);
  });

  it('returns false for machine_version mismatch', () => {
    const body = '{"error":"machine_version mismatch: expected 5, got 4"}';
    const err = new FlyApiError(`Fly API failed (412): ${body}`, 412, body);
    expect(isFlyInsufficientResources(err)).toBe(false);
  });

  it('returns false for generic precondition failure', () => {
    const body = '{"error":"precondition failed: current_version does not match"}';
    const err = new FlyApiError(`Fly API failed (412): ${body}`, 412, body);
    expect(isFlyInsufficientResources(err)).toBe(false);
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

  // -- Non-412 and non-FlyApiError: should return false --

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
