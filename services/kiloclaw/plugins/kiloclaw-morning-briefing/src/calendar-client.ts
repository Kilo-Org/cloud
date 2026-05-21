/**
 * HTTP wrappers for the controller's Google OAuth broker
 * (`/_kilo/google-oauth/{status,token}`) and Google Calendar's
 * `events.list` REST endpoint.
 *
 * The broker handles both connection paths in Settings transparently:
 *   - "Calendar Connect" (simple OAuth, credential_profile=kilo_owned)
 *   - "Full Google Account" (gog migrated to db, credential_profile=legacy)
 * Both materialize as a single per-instance row, so this client only
 * needs to ask the broker for status + tokens and doesn't branch on
 * which UI path was used.
 *
 * All HTTP failures surface as thrown Errors with stable string codes
 * so `collectCalendar` can map them to `SourceCollectionResult.ok=false`
 * summaries.
 */

import type { CalendarEvent } from './calendar-utils';

const DEFAULT_CONTROLLER_URL = 'http://127.0.0.1:18789';
const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
const REQUEST_TIMEOUT_MS = 15_000;

export interface CalendarClientDeps {
  controllerUrl?: string;
  gatewayToken?: string;
  fetchImpl?: typeof fetch;
}

export interface CalendarReadiness {
  statusOk: boolean;
  connected: boolean;
  accountEmail: string | null;
  hasCalendarCapability: boolean;
  reason: string;
}

export interface CalendarToken {
  accessToken: string;
  accountEmail: string;
  scopes: string[];
}

interface BrokerStatusAccount {
  email: string;
  client: string;
  services: string[];
  scopes: string[];
  auth: string;
  profile: string;
  status: string;
}

interface BrokerStatusResponse {
  connected: boolean;
  accounts: BrokerStatusAccount[];
}

function resolveControllerUrl(deps: CalendarClientDeps): string {
  return deps.controllerUrl ?? process.env.KILOCLAW_CONTROLLER_URL ?? DEFAULT_CONTROLLER_URL;
}

function resolveGatewayToken(deps: CalendarClientDeps): string {
  const token = deps.gatewayToken ?? process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) {
    throw new Error('OPENCLAW_GATEWAY_TOKEN is not set');
  }
  return token;
}

function resolveFetch(deps: CalendarClientDeps): typeof fetch {
  return deps.fetchImpl ?? fetch;
}

async function brokerPost<T>(
  path: string,
  body: unknown,
  deps: CalendarClientDeps
): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
  const url = `${resolveControllerUrl(deps).replace(/\/$/, '')}${path}`;
  const fetchImpl = resolveFetch(deps);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resolveGatewayToken(deps)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const message =
        typeof payload.error === 'string' ? payload.error : `broker_${response.status}`;
      return { ok: false, status: response.status, message };
    }
    return { ok: true, data: payload as T };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Capability flag the broker uses for calendar.events.list scope.
 * Mirrors `GOOGLE_CAPABILITY_SCOPES` in the worker controller.
 */
const CALENDAR_CAPABILITY = 'calendar_read';

export async function resolveCalendarReady(
  deps: CalendarClientDeps = {}
): Promise<CalendarReadiness> {
  const result = await brokerPost<BrokerStatusResponse>('/_kilo/google-oauth/status', {}, deps);
  if (!result.ok) {
    return {
      statusOk: false,
      connected: false,
      accountEmail: null,
      hasCalendarCapability: false,
      reason: `Google OAuth status check failed (${result.status}): ${result.message}`,
    };
  }
  if (!result.data.connected || result.data.accounts.length === 0) {
    return {
      statusOk: true,
      connected: false,
      accountEmail: null,
      hasCalendarCapability: false,
      reason: 'Google account not connected',
    };
  }
  const account = result.data.accounts[0];
  const hasCalendarCapability =
    account.services.includes(CALENDAR_CAPABILITY) ||
    account.scopes.some(scope => scope.includes('calendar'));
  return {
    statusOk: true,
    connected: true,
    accountEmail: account.email,
    hasCalendarCapability,
    reason: hasCalendarCapability
      ? 'connected'
      : 'Google account connected but missing calendar scope',
  };
}

export async function fetchCalendarAccessToken(
  deps: CalendarClientDeps = {}
): Promise<CalendarToken> {
  const result = await brokerPost<{
    accessToken: string;
    accountEmail: string;
    scopes: string[];
  }>('/_kilo/google-oauth/token', { capabilities: [CALENDAR_CAPABILITY] }, deps);
  if (!result.ok) {
    throw new Error(`google_oauth_token_fetch_failed:${result.status}:${result.message}`);
  }
  return {
    accessToken: result.data.accessToken,
    accountEmail: result.data.accountEmail,
    scopes: result.data.scopes,
  };
}

export async function fetchCalendarEvents(
  accessToken: string,
  timeMin: string,
  timeMax: string,
  deps: CalendarClientDeps = {}
): Promise<CalendarEvent[]> {
  const fetchImpl = resolveFetch(deps);
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '25',
  });
  const url = `${CALENDAR_API_BASE}/calendars/primary/events?${params.toString()}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      const errorPayload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const message =
        (errorPayload.error as Record<string, unknown>)?.message ?? `google_api_${response.status}`;
      throw new Error(`google_calendar_fetch_failed:${response.status}:${String(message)}`);
    }
    const payload = (await response.json()) as { items?: unknown };
    if (!Array.isArray(payload.items)) return [];
    return payload.items.filter(isCalendarEvent);
  } finally {
    clearTimeout(timeout);
  }
}

function isCalendarEvent(value: unknown): value is CalendarEvent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.start === 'object' && typeof v.end === 'object';
}
