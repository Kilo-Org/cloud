// Pure diagnostics module — no React, no react-native. The only imports are
// the shared tRPC error-code reader and the Node stdlib for types.
//
// Payload rule: counts, booleans, and fixed enum strings only. No URLs, no
// search text, no error messages, no PII, no free text. The payload is read
// in the PostHog person timeline, so it must carry no secret.

import { readTrpcErrorCode } from '@/lib/pr-review/classify-pr-review-query-state';

export const DIAGNOSTICS_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_DIAGNOSTICS_EVENTS_PER_LAUNCH = 20;

export function selectDiagnosticsWindowActive(input: {
  flagEnabled: boolean;
  consentGranted: boolean;
  payloadJson: string | null;
  nowMs: number;
}): boolean {
  // Fails closed in every branch.
  if (!input.flagEnabled) {
    return false;
  }
  if (!input.consentGranted) {
    return false;
  }
  if (input.payloadJson === null) {
    return false;
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(input.payloadJson);
  } catch {
    return false;
  }
  if (!(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))) {
    return false;
  }
  const record = parsed as Record<string, unknown>;
  const until = record.until;
  if (typeof until !== 'string' || until.length === 0) {
    return false;
  }
  const untilMs = Date.parse(until);
  if (Number.isNaN(untilMs)) {
    return false;
  }
  if (untilMs <= input.nowMs) {
    return false;
  }
  if (untilMs - input.nowMs > DIAGNOSTICS_MAX_WINDOW_MS) {
    return false;
  }
  return true;
}

/**
 * Reuses the repository's single tRPC code reader. A code only — never the
 * message, which can carry user data.
 */
export function selectTrpcErrorCode(error: unknown): string {
  if (error === null || error === undefined) {
    return 'none';
  }
  const code = readTrpcErrorCode(error);
  return code !== undefined && /^[A-Z_]{1,40}$/.test(code) ? code : 'unknown';
}

export type AgentsListDiagnostics = {
  surface: string;
  list_empty: string;
  body_kind: string;
  order_by: string;
  page_size: number;
  page_count: number;
  has_next_page: boolean;
  has_organization: boolean;
  platform_filter: string;
  project_filter_count: number;
  is_searching: boolean;
  search_query_length: number;
  stored_count: number;
  active_count: number;
  pinned_count: number;
  section_count: number;
  row_count: number;
  has_any_sessions: boolean;
  ready: boolean;
  filters_loaded: boolean;
  org_loaded: boolean;
  is_loading: boolean;
  stored_is_loading: boolean;
  active_is_loading: boolean;
  stored_is_error: boolean;
  active_is_error: boolean;
  search_is_error: boolean;
  stored_error_code: string;
};

/**
 * Build a flat diagnostics payload. Returns only the documented keys.
 * Never forwards a URL, git URL, session id, organization id, search text,
 * or error message. The payload is read in the PostHog person timeline and
 * carries no secret.
 */
export function buildAgentsListDiagnostics(
  input: AgentsListDiagnostics
): Record<string, string | number | boolean> {
  return {
    surface: input.surface,
    list_empty: input.list_empty,
    body_kind: input.body_kind,
    order_by: input.order_by,
    page_size: input.page_size,
    page_count: input.page_count,
    has_next_page: input.has_next_page,
    has_organization: input.has_organization,
    platform_filter: input.platform_filter,
    project_filter_count: input.project_filter_count,
    is_searching: input.is_searching,
    search_query_length: input.search_query_length,
    stored_count: input.stored_count,
    active_count: input.active_count,
    pinned_count: input.pinned_count,
    section_count: input.section_count,
    row_count: input.row_count,
    has_any_sessions: input.has_any_sessions,
    ready: input.ready,
    filters_loaded: input.filters_loaded,
    org_loaded: input.org_loaded,
    is_loading: input.is_loading,
    stored_is_loading: input.stored_is_loading,
    active_is_loading: input.active_is_loading,
    stored_is_error: input.stored_is_error,
    active_is_error: input.active_is_error,
    search_is_error: input.search_is_error,
    stored_error_code: input.stored_error_code,
  };
}

/**
 * Build a deterministic signature for deduplication. Sorted key=value pairs
 * joined with `|`.
 */
export function buildDiagnosticsSignature(
  payload: Record<string, string | number | boolean>
): string {
  // eslint-disable-next-line unicorn/no-array-sort -- toSorted unavailable in Hermes
  const entries = Object.entries(payload).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${k}=${String(v)}`).join('|');
}

/**
 * true only when active, signature changed, and under the per-launch cap.
 */
export function shouldCaptureDiagnostics(input: {
  active: boolean;
  signature: string;
  lastSignature: string | null;
  sentCount: number;
}): boolean {
  return (
    input.active &&
    input.signature !== input.lastSignature &&
    input.sentCount < MAX_DIAGNOSTICS_EVENTS_PER_LAUNCH
  );
}
