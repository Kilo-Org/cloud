import { describe, expect, it } from 'vitest';

import {
  type AgentsListDiagnostics,
  buildAgentsListDiagnostics,
  buildDiagnosticsSignature,
  DIAGNOSTICS_MAX_WINDOW_MS,
  MAX_DIAGNOSTICS_EVENTS_PER_LAUNCH,
  selectDiagnosticsWindowActive,
  selectTrpcErrorCode,
  shouldCaptureDiagnostics,
} from './list-diagnostics';

// Payload helpers at module scope.
function futurePayloadJson(hoursFromNow: number): string | null {
  if (hoursFromNow === 0) {
    return null;
  }
  const msFromNow = hoursFromNow * 3600 * 1000;
  return JSON.stringify({ until: new Date(Date.now() + msFromNow).toISOString() });
}

// T1 — selectDiagnosticsWindowActive
// ---------------------------------------------------------------------------

describe('selectDiagnosticsWindowActive', () => {
  const nowMs = Date.now();
  const oneHour = futurePayloadJson(1);

  it('fails closed on each required condition', () => {
    expect(
      selectDiagnosticsWindowActive({
        flagEnabled: false,
        consentGranted: true,
        payloadJson: oneHour,
        nowMs,
      })
    ).toBe(false);
    expect(
      selectDiagnosticsWindowActive({
        flagEnabled: true,
        consentGranted: false,
        payloadJson: oneHour,
        nowMs,
      })
    ).toBe(false);
    expect(
      selectDiagnosticsWindowActive({
        flagEnabled: true,
        consentGranted: true,
        payloadJson: null,
        nowMs,
      })
    ).toBe(false);
  });

  it('fails on invalid payloads', () => {
    expect(
      selectDiagnosticsWindowActive({
        flagEnabled: true,
        consentGranted: true,
        payloadJson: '{',
        nowMs,
      })
    ).toBe(false);
    for (const bad of ['[]', '"string"', '42']) {
      expect(
        selectDiagnosticsWindowActive({
          flagEnabled: true,
          consentGranted: true,
          payloadJson: bad,
          nowMs,
        })
      ).toBe(false);
    }
    for (const bad of ['{}', '{"until":""}', '{"until":42}']) {
      expect(
        selectDiagnosticsWindowActive({
          flagEnabled: true,
          consentGranted: true,
          payloadJson: bad,
          nowMs,
        })
      ).toBe(false);
    }
  });

  it('fails on nonsense date', () => {
    expect(
      selectDiagnosticsWindowActive({
        flagEnabled: true,
        consentGranted: true,
        payloadJson: '{"until":"nonsense"}',
        nowMs,
      })
    ).toBe(false);
  });

  it('fails when expired or too far ahead', () => {
    const past = new Date(nowMs - 3600 * 1000).toISOString();
    expect(
      selectDiagnosticsWindowActive({
        flagEnabled: true,
        consentGranted: true,
        payloadJson: JSON.stringify({ until: past }),
        nowMs,
      })
    ).toBe(false);
    const tooFar = new Date(nowMs + DIAGNOSTICS_MAX_WINDOW_MS + 3600 * 1000).toISOString();
    expect(
      selectDiagnosticsWindowActive({
        flagEnabled: true,
        consentGranted: true,
        payloadJson: JSON.stringify({ until: tooFar }),
        nowMs,
      })
    ).toBe(false);
  });

  it('passes with valid future until', () => {
    expect(
      selectDiagnosticsWindowActive({
        flagEnabled: true,
        consentGranted: true,
        payloadJson: oneHour,
        nowMs,
      })
    ).toBe(true);
    expect(
      selectDiagnosticsWindowActive({
        flagEnabled: true,
        consentGranted: true,
        payloadJson: futurePayloadJson(23.9),
        nowMs,
      })
    ).toBe(true);
  });
});

// shouldCaptureDiagnostics
// ---------------------------------------------------------------------------

describe('shouldCaptureDiagnostics', () => {
  it('returns false when not active or same signature or at cap, true when new sig under cap', () => {
    expect(
      shouldCaptureDiagnostics({
        active: false,
        signature: 'a=1|b=2',
        lastSignature: null,
        sentCount: 0,
      })
    ).toBe(false);
    expect(
      shouldCaptureDiagnostics({
        active: true,
        signature: 'a=1|b=2',
        lastSignature: 'a=1|b=2',
        sentCount: 0,
      })
    ).toBe(false);
    expect(
      shouldCaptureDiagnostics({
        active: true,
        signature: 'a=2',
        lastSignature: 'a=1',
        sentCount: MAX_DIAGNOSTICS_EVENTS_PER_LAUNCH,
      })
    ).toBe(false);
    expect(
      shouldCaptureDiagnostics({
        active: true,
        signature: 'a=2',
        lastSignature: null,
        sentCount: 3,
      })
    ).toBe(true);
  });
});

// selectTrpcErrorCode
// ---------------------------------------------------------------------------

describe('selectTrpcErrorCode', () => {
  it('returns "none" for null and undefined', () => {
    expect(selectTrpcErrorCode(null)).toBe('none');
    expect(selectTrpcErrorCode(undefined)).toBe('none');
  });

  it('reads the code from all known shapes', () => {
    expect(selectTrpcErrorCode({ data: { code: 'UNAUTHORIZED' } })).toBe('UNAUTHORIZED');
    expect(selectTrpcErrorCode({ shape: { data: { code: 'NOT_FOUND' } } })).toBe('NOT_FOUND');
    expect(selectTrpcErrorCode({ code: 'FORBIDDEN' })).toBe('FORBIDDEN');
  });

  it('returns "unknown" without leaking message content', () => {
    expect(selectTrpcErrorCode({ message: 'token abc' })).toBe('unknown');
    const result = selectTrpcErrorCode({ message: 'token abcdef123456' });
    expect(result).not.toMatch(/token|abc/i);
  });
});

// buildDiagnosticsSignature
// ---------------------------------------------------------------------------

describe('buildDiagnosticsSignature', () => {
  it('produces sorted deterministic strings', () => {
    expect(buildDiagnosticsSignature({ b: 2, a: 1 })).toBe('a=1|b=2');
    expect(buildDiagnosticsSignature({ a: 1, b: true, c: 'x' })).toBe(
      buildDiagnosticsSignature({ c: 'x', b: true, a: 1 })
    );
  });
});

// T2 — buildAgentsListDiagnostics
// ---------------------------------------------------------------------------

describe('buildAgentsListDiagnostics', () => {
  const fullInput: AgentsListDiagnostics = {
    surface: 'section-list',
    list_empty: 'none',
    body_kind: 'render-list',
    order_by: 'updated_at',
    page_size: 30,
    page_count: 1,
    has_next_page: false,
    has_organization: true,
    platform_filter: 'claw,cloud-agent',
    project_filter_count: 0,
    is_searching: false,
    search_query_length: 0,
    stored_count: 3,
    active_count: 1,
    pinned_count: 1,
    section_count: 1,
    row_count: 3,
    has_any_sessions: true,
    ready: true,
    filters_loaded: true,
    org_loaded: true,
    is_loading: false,
    stored_is_loading: false,
    active_is_loading: false,
    stored_is_error: false,
    active_is_error: false,
    search_is_error: false,
    stored_error_code: 'none',
  };
  const expectedKeys = [
    'surface',
    'list_empty',
    'body_kind',
    'order_by',
    'page_size',
    'page_count',
    'has_next_page',
    'has_organization',
    'platform_filter',
    'project_filter_count',
    'is_searching',
    'search_query_length',
    'stored_count',
    'active_count',
    'pinned_count',
    'section_count',
    'row_count',
    'has_any_sessions',
    'ready',
    'filters_loaded',
    'org_loaded',
    'is_loading',
    'stored_is_loading',
    'active_is_loading',
    'stored_is_error',
    'active_is_error',
    'search_is_error',
    'stored_error_code',
  ];
  const forbidden = /token|password|cookie|secret|api[_-]?key|bearer|authorization|https?:\/\/|@/i;

  it('returns exactly the documented key set', () => {
    const result = buildAgentsListDiagnostics(fullInput);
    expect(Object.keys(result).toSorted()).toEqual([...expectedKeys].toSorted());
  });

  it('every value is string, number, or boolean', () => {
    for (const v of Object.values(buildAgentsListDiagnostics(fullInput))) {
      expect(typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean').toBe(true);
    }
  });

  it('no key and no string value match PII / secret patterns', () => {
    const result = buildAgentsListDiagnostics(fullInput);
    for (const key of Object.keys(result)) {
      expect(key).not.toMatch(forbidden);
    }
    for (const value of Object.values(result)) {
      if (typeof value === 'string') {
        expect(value).not.toMatch(forbidden);
      }
    }
  });
});
