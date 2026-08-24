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

export async function addPylonIssueTag(
  context: DeletionHandlerContext,
  apiKey: string,
  issueId: string,
  tag: string
): Promise<{ issue: Record<string, unknown> } | { outcome: DeletionHandlerOutcome }> {
  const normalizedTag = tag.trim();
  if (!normalizedTag) {
    return { outcome: { kind: 'needs_attention', errorCode: 'pylon_tag_invalid' } };
  }

  const issueResult = await pylonRequest(context, apiKey, `/issues/${encodeURIComponent(issueId)}`);
  if ('outcome' in issueResult) return issueResult;
  const issueJson = await pylonJson(issueResult.response);
  if ('outcome' in issueJson) return issueJson;
  const data = pylonData(issueJson.payload);
  if (!isRecord(data)) {
    return { outcome: { kind: 'needs_attention', errorCode: 'pylon_issue_unparsed' } };
  }

  const tags = Array.isArray(data.tags)
    ? data.tags.filter((value): value is string => typeof value === 'string')
    : [];
  if (tags.includes(normalizedTag)) return { issue: data };

  const patch = await pylonRequest(context, apiKey, `/issues/${encodeURIComponent(issueId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ tags: [...tags, normalizedTag] }),
  });
  if ('outcome' in patch) return patch;
  if (!patch.response.ok) return { outcome: classifyResponse(patch.response) };
  const patchedJson = await pylonJson(patch.response);
  if ('outcome' in patchedJson) return patchedJson;
  const patched = pylonData(patchedJson.payload);
  if (!isRecord(patched) || !Array.isArray(patched.tags) || !patched.tags.includes(normalizedTag)) {
    return {
      outcome: { kind: 'retry', errorCode: 'pylon_tag_unconfirmed', httpStatusClass: 'error' },
    };
  }
  return { issue: patched };
}

export type PylonIssueForPreflight = {
  id: string;
  tags: string[];
  requesterEmail: string | null;
};

export type PylonMessageForPreflight = {
  emailInfo: Record<string, unknown> | null;
  authorContactEmail: string | null;
  authorUserEmail: string | null;
  timestamp: string | null;
};

export type PylonPreflightFetchResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'retryable'; status: number | null }
  | { kind: 'attention'; code: string };

export async function fetchPylonIssueForPreflight(
  ticket: string
): Promise<PylonPreflightFetchResult<PylonIssueForPreflight>> {
  const issueId = normalizePylonTicket(ticket);
  if (!issueId) return { kind: 'attention', code: 'pylon_ticket_invalid' };
  const fetched = await pylonGetJson(`/issues/${encodeURIComponent(issueId)}`);
  if (fetched.kind !== 'ok') return fetched;
  const data = pylonData(fetched.value);
  if (!isRecord(data)) {
    return { kind: 'attention', code: 'pylon_issue_unparsed' };
  }
  const id = typeof data.id === 'string' && data.id.trim() ? data.id.trim() : issueId;
  const tags = Array.isArray(data.tags)
    ? data.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  const requester = isRecord(data.requester) ? data.requester : null;
  const requesterEmail =
    requester && typeof requester.email === 'string' ? requester.email.trim() : '';
  return {
    kind: 'ok',
    value: {
      id,
      tags,
      requesterEmail: requesterEmail || null,
    },
  };
}

export async function fetchPylonIssueMessagesForPreflight(
  issueId: string
): Promise<PylonPreflightFetchResult<PylonMessageForPreflight[]>> {
  const messages: PylonMessageForPreflight[] = [];
  let cursor: string | undefined;
  do {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const fetched = await pylonGetJson(`/issues/${encodeURIComponent(issueId)}/messages${query}`);
    if (fetched.kind !== 'ok') return fetched;
    const data = pylonData(fetched.value);
    if (!Array.isArray(data)) {
      return { kind: 'attention', code: 'pylon_messages_unparsed' };
    }
    for (const entry of data) {
      const parsed = parsePylonMessageForPreflight(entry);
      if (!parsed) return { kind: 'attention', code: 'pylon_messages_unparsed' };
      messages.push(parsed);
    }
    const pagination =
      isRecord(fetched.value) && isRecord(fetched.value.pagination)
        ? fetched.value.pagination
        : null;
    cursor =
      pagination?.has_next_page === true && typeof pagination.cursor === 'string'
        ? pagination.cursor
        : undefined;
  } while (cursor);
  messages.sort((a, b) => {
    const aTime = a.timestamp ? Date.parse(a.timestamp) : Number.NaN;
    const bTime = b.timestamp ? Date.parse(b.timestamp) : Number.NaN;
    if (Number.isNaN(aTime) && Number.isNaN(bTime)) return 0;
    if (Number.isNaN(aTime)) return 1;
    if (Number.isNaN(bTime)) return -1;
    return aTime - bTime;
  });
  return { kind: 'ok', value: messages };
}

function parsePylonMessageForPreflight(entry: unknown): PylonMessageForPreflight | null {
  if (!isRecord(entry)) return null;
  const author = isRecord(entry.author) ? entry.author : null;
  const authorContact = author && isRecord(author.contact) ? author.contact : null;
  const authorUser = author && isRecord(author.user) ? author.user : null;
  return {
    emailInfo: isRecord(entry.email_info) ? entry.email_info : null,
    authorContactEmail:
      authorContact && typeof authorContact.email === 'string' ? authorContact.email : null,
    authorUserEmail: authorUser && typeof authorUser.email === 'string' ? authorUser.email : null,
    timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
  };
}

async function pylonGetJson(path: string): Promise<PylonPreflightFetchResult<unknown>> {
  const config = pylonConfig();
  if (!('apiKey' in config)) return { kind: 'attention', code: 'configuration_missing' };
  let response: Response;
  try {
    response = await fetch(`${pylonHost()}${path}`, {
      headers: pylonHeaders(config.apiKey),
      signal: AbortSignal.timeout(USER_DELETION_PROVIDER_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'retryable', status: null };
  }
  if (response.status === 429 || response.status >= 500) {
    return { kind: 'retryable', status: response.status };
  }
  if (!response.ok) {
    return { kind: 'attention', code: `http_${response.status}` };
  }
  try {
    return { kind: 'ok', value: await response.json() };
  } catch {
    return { kind: 'attention', code: 'pylon_issue_unparsed' };
  }
}
