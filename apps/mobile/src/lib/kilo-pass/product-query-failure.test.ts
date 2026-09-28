import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auditKiloPassProductQueryFailure,
  formatKiloPassProductQueryLogLine,
  getKiloPassProductQueryFingerprint,
  KiloPassProductQueryError,
  type KiloPassProductQueryFailure,
  reportUnresolvedKiloPassProductIdentifiers,
} from './product-query-failure';
import {
  setTelemetrySink,
  TELEMETRY_DESCRIPTION_KEY,
  type TelemetryEvent,
} from '@/lib/telemetry/error-sink';

const storeQueryError = Object.assign(new Error('Failed to query products'), {
  code: 'query-product',
  responseCode: 4,
});

const storeUnavailableFailure: KiloPassProductQueryFailure = {
  cause: storeQueryError,
  kind: 'store-unavailable',
  productIds: ['kilopass_tier19', 'kilopass_tier49'],
  storefront: 'play',
};

let events: TelemetryEvent[] = [];

beforeEach(() => {
  events = [];
  setTelemetrySink(event => {
    events.push(event);
  });
});

afterEach(() => {
  setTelemetrySink(null);
});

describe('KiloPassProductQueryError', () => {
  it('carries the platform, identifiers, and store code of the failure', () => {
    const error = new KiloPassProductQueryError(storeUnavailableFailure);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('KiloPassProductQueryError');
    expect(error.platform).toBe('android');
    expect(error.storefront).toBe('play');
    expect(error.storeCode).toBe('query-product');
    expect(error.responseCode).toBe(4);
    expect(error.productIds).toEqual(['kilopass_tier19', 'kilopass_tier49']);
    expect(error.message).toBe('Kilo Pass product query failed on android (query-product)');
  });

  it('declares a stable telemetry fingerprint that never carries an identifier', () => {
    const error = new KiloPassProductQueryError(storeUnavailableFailure);
    const otherTierError = new KiloPassProductQueryError({
      ...storeUnavailableFailure,
      productIds: ['kilopass_tier199'],
    });

    expect(error[TELEMETRY_DESCRIPTION_KEY].fingerprint).toEqual([
      'kilo-pass-product-query',
      'store-unavailable',
      'android',
      'play',
      'query-product',
    ]);
    expect(otherTierError[TELEMETRY_DESCRIPTION_KEY].fingerprint).toEqual(
      error[TELEMETRY_DESCRIPTION_KEY].fingerprint
    );
  });

  it('reports only the store code and identifiers, never a receipt or a token', () => {
    const error = new KiloPassProductQueryError({
      cause: Object.assign(new Error('Failed to query products'), {
        code: 'query-product',
        purchaseToken: 'SECRET-PURCHASE-TOKEN',
        receipt: 'SECRET-RECEIPT',
      }),
      kind: 'store-unavailable',
      productIds: ['kilopass_tier19'],
      storefront: 'app_store',
    });

    const reported = JSON.stringify(error[TELEMETRY_DESCRIPTION_KEY]);
    expect(reported).toContain('kilopass_tier19');
    expect(reported).not.toContain('SECRET');
  });
});

describe('getKiloPassProductQueryFingerprint', () => {
  it('groups the same platform and store answer, whatever the kind of failure', () => {
    const audit = auditKiloPassProductQueryFailure(storeUnavailableFailure);

    expect(getKiloPassProductQueryFingerprint(audit)).toEqual([
      'kilo-pass-product-query',
      'store-unavailable',
      'android',
      'play',
      'query-product',
    ]);
  });
});

describe('formatKiloPassProductQueryLogLine', () => {
  it('names the platform, the store code, and every identifier that failed', () => {
    expect(formatKiloPassProductQueryLogLine(storeUnavailableFailure)).toBe(
      '[kilo-pass] store product query store-unavailable platform=android storefront=play code=query-product productIds=[kilopass_tier19, kilopass_tier49]'
    );
  });
});

describe('reportUnresolvedKiloPassProductIdentifiers', () => {
  it('reports a recovered failure at warning level under the stable fingerprint', () => {
    reportUnresolvedKiloPassProductIdentifiers({
      ...storeUnavailableFailure,
      kind: 'unresolved-identifiers',
      productIds: ['kilopass_tier49'],
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: 'warning',
      error: storeQueryError,
      tags: {
        'error.subsystem': 'kilo-pass',
        'error.operation': 'store-product-query',
        'kilo_pass.platform': 'android',
        'kilo_pass.storefront': 'play',
        'kilo_pass.failure_kind': 'unresolved-identifiers',
        'kilo_pass.store_code': 'query-product',
      },
      fingerprint: [
        'kilo-pass-product-query',
        'unresolved-identifiers',
        'android',
        'play',
        'query-product',
      ],
    });
  });
});
