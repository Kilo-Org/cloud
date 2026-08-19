import { getEnvVariable } from '@/lib/dotenvx';
import {
  USER_DELETION_PROVIDER_TIMEOUT_MS,
  USER_DELETION_PYLON_API_BASE,
} from '@/lib/user/deletion-queue/deletion-constants';
import type {
  DeletionHandlerContext,
  DeletionHandlerOutcome,
} from '@/lib/user/deletion-queue/deletion-types';
import {
  classifyResponse,
  configurationMissing,
  deletionFetch,
  isRecord,
  readJsonUnknown,
} from '@/lib/user/deletion-queue/handlers/common';

export function pylonHost(): string {
  const configured = getEnvVariable('PYLON_HOST').trim().replace(/\/$/, '');
  return configured || USER_DELETION_PYLON_API_BASE;
}

export function pylonConfig(): { apiKey: string } | DeletionHandlerOutcome {
  const apiKey = getEnvVariable('PYLON_API_KEY').trim();
  if (!apiKey) return configurationMissing();
  return { apiKey };
}

export function pylonHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

export async function pylonRequest(
  context: DeletionHandlerContext,
  apiKey: string,
  path: string,
  init?: RequestInit
): Promise<{ response: Response } | { outcome: DeletionHandlerOutcome }> {
  return deletionFetch(context, `${pylonHost()}${path}`, {
    ...init,
    headers: { ...pylonHeaders(apiKey), ...init?.headers },
  });
}

export function pylonData(payload: unknown): unknown {
  return isRecord(payload) && 'data' in payload ? payload.data : payload;
}

export async function pylonJson(
  response: Response
): Promise<{ payload: unknown } | { outcome: DeletionHandlerOutcome }> {
  if (!response.ok) return { outcome: classifyResponse(response) };
  return { payload: await readJsonUnknown(response) };
}

export function normalizePylonTicket(ref: string): string {
  return ref.replace(/^#/, '').trim();
}

export async function lookupPylonRequesterEmail(ticket: string): Promise<string | null> {
  const config = pylonConfig();
  if (!('apiKey' in config)) return null;
  const issueId = normalizePylonTicket(ticket);
  if (!issueId) return null;
  let response: Response;
  try {
    response = await fetch(`${pylonHost()}/issues/${encodeURIComponent(issueId)}`, {
      headers: pylonHeaders(config.apiKey),
      signal: AbortSignal.timeout(USER_DELETION_PROVIDER_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  const data = pylonData(payload);
  if (!isRecord(data)) return null;
  const requester = isRecord(data.requester) ? data.requester : null;
  const email = requester && typeof requester.email === 'string' ? requester.email.trim() : '';
  return email || null;
}
