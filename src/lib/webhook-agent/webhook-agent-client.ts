import 'server-only';
import { INTERNAL_API_SECRET, WEBHOOK_AGENT_URL } from '@/lib/config.server';
import { encodeUserIdForPath } from './user-id-encoding';

/**
 * Response type for trigger config from the worker.
 */
export type TriggerConfigResponse = {
  triggerId: string;
  namespace: string;
  userId: string | null;
  orgId: string | null;
  createdAt: string;
  isActive: boolean;
  githubRepo: string;
  mode: string;
  model: string;
  promptTemplate: string;
  profileId?: string | null;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
  webhookAuthHeader?: string;
  webhookAuthConfigured: boolean;
};

/**
 * Input for creating a new trigger.
 * Profile is referenced by ID - resolved at runtime in the worker.
 */
export type CreateTriggerInput = {
  githubRepo: string;
  mode: string;
  model: string;
  promptTemplate: string;
  profileId: string;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
  webhookAuth?: {
    header: string;
    secret: string;
  };
};

/**
 * Input for updating an existing trigger.
 * Note: githubRepo and triggerId cannot be changed after creation.
 * Use null to explicitly clear a field, undefined to leave unchanged.
 */
export type UpdateTriggerInput = {
  mode?: string;
  model?: string;
  promptTemplate?: string;
  isActive?: boolean;
  profileId?: string;
  autoCommit?: boolean | null;
  condenseOnComplete?: boolean | null;
  webhookAuth?: {
    header?: string | null;
    secret?: string | null;
  };
};

/**
 * Captured request from the worker.
 */
export type CapturedRequest = {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  queryString: string | null;
  headers: Record<string, string>;
  body: string;
  contentType: string | null;
  sourceIp: string | null;
  startedAt: string | null;
  completedAt: string | null;
  processStatus: 'captured' | 'inprogress' | 'success' | 'failed';
  cloudAgentSessionId: string | null;
  errorMessage: string | null;
};

/**
 * Captured request enriched with kiloSessionId from PostgreSQL lookup.
 * Used for UI display where we need the cli_sessions.id for navigation.
 */
export type EnrichedCapturedRequest = CapturedRequest & {
  kiloSessionId: string | null;
};

type WorkerResponse<T> =
  | { success: true; data: T; status: number }
  | { success: false; error: string; status: number };

function buildNamespace(userId?: string, organizationId?: string): string {
  if (organizationId) {
    return `org/${organizationId}`;
  }
  if (userId) {
    return `user/${userId}`;
  }
  throw new Error('Either userId or organizationId must be provided');
}

function buildTriggerPath(namespace: string, triggerId: string): string {
  if (namespace.startsWith('user/')) {
    return `/api/triggers/user/${encodeUserIdForPath(namespace.slice(5))}/${triggerId}`;
  }
  if (namespace.startsWith('org/')) {
    return `/api/triggers/org/${namespace.slice(4)}/${triggerId}`;
  }
  throw new Error(`Invalid namespace: ${namespace}`);
}

async function workerFetch<T>(path: string, options: RequestInit = {}): Promise<WorkerResponse<T>> {
  const url = `${WEBHOOK_AGENT_URL}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-internal-api-key': INTERNAL_API_SECRET,
      ...options.headers,
    },
  });

  const body = (await response.json()) as { success?: boolean; data?: T; error?: string };

  if (!response.ok) {
    console.error('Webhook agent worker request failed', {
      path,
      status: response.status,
      body,
    });
    return {
      success: false,
      error: body.error ?? `HTTP ${response.status}`,
      status: response.status,
    };
  }

  return {
    success: true,
    data: body.data ?? (body as T),
    status: response.status,
  };
}

/**
 * Create a new trigger in the worker.
 * Throws on network errors - caller should handle rollback.
 */
export async function createWorkerTrigger(
  userId: string | undefined,
  organizationId: string | undefined,
  triggerId: string,
  input: CreateTriggerInput
): Promise<
  | { success: true; inboundUrl: string }
  | { success: false; error: string; status: number; isConflict: boolean }
> {
  const namespace = buildNamespace(userId, organizationId);
  const path = buildTriggerPath(namespace, triggerId);

  const result = await workerFetch<{ triggerId: string; inboundUrl: string }>(path, {
    method: 'POST',
    body: JSON.stringify(input),
  });

  if (!result.success) {
    return {
      success: false,
      error: result.error,
      status: result.status,
      isConflict: result.status === 409,
    };
  }

  return {
    success: true,
    inboundUrl: result.data.inboundUrl,
  };
}

/**
 * Get a trigger's configuration from the worker.
 * Returns { found: false } for 404, throws on transient errors.
 */
export async function getWorkerTrigger(
  userId: string | undefined,
  organizationId: string | undefined,
  triggerId: string
): Promise<
  | { found: true; config: TriggerConfigResponse }
  | { found: false }
  | { found: 'error'; error: string; status: number }
> {
  const namespace = buildNamespace(userId, organizationId);
  const path = buildTriggerPath(namespace, triggerId);

  const result = await workerFetch<TriggerConfigResponse>(path, {
    method: 'GET',
  });

  if (!result.success) {
    // 404 means trigger doesn't exist - this is expected
    if (result.status === 404) {
      return { found: false };
    }
    // Other errors are transient - don't delete DB record
    return { found: 'error', error: result.error, status: result.status };
  }

  return { found: true, config: result.data };
}

export async function updateWorkerTrigger(
  userId: string | undefined,
  organizationId: string | undefined,
  triggerId: string,
  input: UpdateTriggerInput
): Promise<
  | { success: true; config: TriggerConfigResponse }
  | { success: false; error: string; status: number; isNotFound: boolean }
> {
  const namespace = buildNamespace(userId, organizationId);
  const path = buildTriggerPath(namespace, triggerId);

  const result = await workerFetch<TriggerConfigResponse>(path, {
    method: 'PUT',
    body: JSON.stringify(input),
  });

  if (!result.success) {
    return {
      success: false,
      error: result.error,
      status: result.status,
      isNotFound: result.status === 404,
    };
  }

  return {
    success: true,
    config: result.data,
  };
}

export async function deleteWorkerTrigger(
  userId: string | undefined,
  organizationId: string | undefined,
  triggerId: string
): Promise<{ success: boolean; error?: string }> {
  const namespace = buildNamespace(userId, organizationId);
  const path = buildTriggerPath(namespace, triggerId);

  const result = await workerFetch<{ message: string }>(path, {
    method: 'DELETE',
  });

  if (!result.success) {
    // 404 is acceptable for delete - trigger already doesn't exist
    if (result.status === 404) {
      return { success: true };
    }
    return { success: false, error: result.error };
  }

  return { success: true };
}

export async function listWorkerRequests(
  userId: string | undefined,
  organizationId: string | undefined,
  triggerId: string,
  limit: number = 50
): Promise<
  | { success: true; requests: CapturedRequest[] }
  | { success: false; error: string; status: number; isNotFound: boolean }
> {
  const namespace = buildNamespace(userId, organizationId);
  const path = `${buildTriggerPath(namespace, triggerId)}/requests?limit=${limit}`;

  const result = await workerFetch<{ requests: CapturedRequest[] }>(path, {
    method: 'GET',
  });

  if (!result.success) {
    return {
      success: false,
      error: result.error,
      status: result.status,
      isNotFound: result.status === 404,
    };
  }

  return {
    success: true,
    requests: result.data.requests,
  };
}

export function buildInboundUrl(
  userId: string | undefined,
  organizationId: string | undefined,
  triggerId: string
): string {
  if (organizationId) {
    return `${WEBHOOK_AGENT_URL}/inbound/org/${organizationId}/${triggerId}`;
  }
  if (userId) {
    return `${WEBHOOK_AGENT_URL}/inbound/user/${encodeUserIdForPath(userId)}/${triggerId}`;
  }
  throw new Error('Either userId or organizationId must be provided');
}
