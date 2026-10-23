import 'server-only';

import {
  fetchGitLabBoundToAddress,
  GITLAB_REQUEST_TIMEOUT_MS,
  MAX_GITLAB_RESPONSE_BYTES,
} from '@/lib/integrations/platforms/gitlab/adapter';
import {
  buildGitLabUrl,
  resolveGitLabUrlSafely,
} from '@/lib/integrations/platforms/gitlab/instance-url';
import { classifyGitLabError, GitLabApiStatusError } from './gitlab-authorization';

const GITLAB_RESPONSE_TOO_LARGE_MESSAGE = 'GitLab response exceeded size limit';

/**
 * One JSON request against the authorized instance. The instance URL is the
 * server-derived one from authorizeProject/authorizeOwner. The URL is resolved
 * once with the adapter's guard and the request is then bound to that exact
 * resolved address, so a stored self-managed host cannot be DNS-rebound
 * between the check and the connect.
 */
export async function requestGitLabJson<T>(
  access: { accessToken: string; instanceUrl: string },
  path: string,
  request: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
  } = {}
): Promise<T> {
  const query = request.query
    ? (Object.fromEntries(
        Object.entries(request.query).filter(([, value]) => value !== undefined)
      ) as Record<string, string | number | boolean>)
    : undefined;
  const url = buildGitLabUrl(access.instanceUrl, path, query);
  try {
    const response = await fetchGitLabValidated(url, {
      method: request.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${access.accessToken}`,
        Accept: 'application/json',
        ...(request.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(GITLAB_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      // Only the status survives — the provider body is never re-emitted.
      throw new GitLabApiStatusError(
        response.status,
        `GitLab ${request.method ?? 'GET'} request failed: ${response.status}`
      );
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  } catch (error) {
    // This layer has no owner: the status travels on the classified error so
    // the owner-aware caller can weigh a 403 against the connection's owner.
    throw classifyGitLabError(error);
  }
}

/**
 * Resolve the URL once (refusing unsafe hosts), then send the request bound
 * to the resolved address. Only an IP literal or gitlab.com keeps the plain
 * transport — the same split the adapter's fetchGitLabOnce makes. Both
 * transports read the reply within MAX_GITLAB_RESPONSE_BYTES; the plain
 * transport returns it buffered within that limit.
 */
async function fetchGitLabValidated(url: string, init: RequestInit): Promise<Response> {
  const resolvedUrl = await resolveGitLabUrlSafely(url);
  if (!resolvedUrl.address) {
    return readBoundedGitLabResponse(await fetch(url, { ...init, redirect: 'manual' }));
  }
  return fetchGitLabBoundToAddress({ ...resolvedUrl, address: resolvedUrl.address }, init);
}

/**
 * Read the plain transport's reply within MAX_GITLAB_RESPONSE_BYTES, mirroring
 * fetchGitLabBoundToAddress: a declared length above the limit is answered
 * without reading the body, and the reply is otherwise returned buffered
 * within the limit.
 */
async function readBoundedGitLabResponse(response: Response): Promise<Response> {
  // Response rejects a body for these statuses, so they keep their own object.
  if (response.body === null || [204, 205, 304].includes(response.status)) {
    return response;
  }

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_GITLAB_RESPONSE_BYTES) {
    await response.body.cancel().catch(() => undefined);
    throw new Error(GITLAB_RESPONSE_TOO_LARGE_MESSAGE);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let responseBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      responseBytes += value.byteLength;
      if (responseBytes > MAX_GITLAB_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(GITLAB_RESPONSE_TOO_LARGE_MESSAGE);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(responseBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
