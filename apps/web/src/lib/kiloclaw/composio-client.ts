import 'server-only';

import * as z from 'zod';
import { COMPOSIO_AGENTS_API_BASE_URL, COMPOSIO_API_BASE_URL } from '@/lib/config.server';

const AgentSignupReadyResponseSchema = z.object({
  status: z.string(),
  request_id: z.string().optional(),
  slug: z.string().optional(),
  email: z.string().optional(),
  agent_key: z.string(),
  composio: z.object({
    member_id: z.string().optional(),
    org_id: z.string(),
    project_id: z.string().optional(),
    api_key: z.string().optional(),
    user_api_key: z.string(),
  }),
});

const AgentWhoamiResponseSchema = AgentSignupReadyResponseSchema.extend({
  claimed_by: z.string().nullable().optional(),
  claimed_at: z.string().nullable().optional(),
});

const ConsumerProjectResolveResponseSchema = z.object({
  project_id: z.string(),
  project_nano_id: z.string(),
  project_name: z.string(),
  org_id: z.string(),
  project_type: z.literal('CONSUMER'),
  consumer_user_id: z.string(),
});

const LinkCreateResponseSchema = z.object({
  redirect_url: z.string().url(),
  connected_account_id: z.string(),
  expires_at: z.string().optional(),
  link_token: z.string().optional(),
});

const SessionCreateResponseSchema = z.object({
  session_id: z.string(),
});

const ConnectedAccountSchema = z.object({
  id: z.string(),
  status: z.string(),
  toolkit: z.object({ slug: z.string() }).optional(),
  auth_config: z.object({ id: z.string() }).optional(),
});

const ConnectedAccountListResponseSchema = z.object({
  items: z.array(ConnectedAccountSchema),
});

export type ComposioAgentIdentity = z.infer<typeof AgentSignupReadyResponseSchema>;
export type ComposioConnectedAccount = z.infer<typeof ConnectedAccountSchema>;
export type ComposioConsumerProject = z.infer<typeof ConsumerProjectResolveResponseSchema>;

export type ComposioUserContextAuth = {
  userApiKey: string;
  orgId: string;
  projectId: string;
};

const GOOGLE_CALENDAR_TOOLKIT_SLUG = 'googlecalendar';

class ComposioApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly operation: string
  ) {
    super(message);
    this.name = 'ComposioApiError';
  }
}

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  return `${normalizedBase}${path}`;
}

function contextAuthHeaders(auth: ComposioUserContextAuth): Record<string, string> {
  return {
    'x-user-api-key': auth.userApiKey,
    'x-org-id': auth.orgId,
    'x-project-id': auth.projectId,
  };
}

function userOrgAuthHeaders(params: { userApiKey: string; orgId: string }): Record<string, string> {
  return {
    'x-user-api-key': params.userApiKey,
    'x-org-id': params.orgId,
  };
}

function safeComposioErrorMetadata(
  value: unknown
): Record<string, string | number | boolean> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;

  const source = value as Record<string, unknown>;
  const metadata: Record<string, string | number | boolean> = {};
  for (const key of ['code', 'field', 'path', 'status']) {
    const field = source[key];
    if (typeof field === 'string') metadata[key] = field.slice(0, 120);
    else if (typeof field === 'number' || typeof field === 'boolean') metadata[key] = field;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

async function parseJsonResponse(response: Response, operation: string): Promise<unknown> {
  const raw = await response.text();
  let json: unknown;
  try {
    json = raw.length > 0 ? JSON.parse(raw) : null;
  } catch {
    if (!response.ok) {
      console.warn('[kiloclaw:composio] upstream request failed', {
        operation,
        status: response.status,
        upstream: { invalidJson: true },
      });
      throw new ComposioApiError(`Composio ${operation} failed`, response.status, operation);
    }
    throw new ComposioApiError(
      `Composio ${operation} returned invalid JSON`,
      response.status,
      operation
    );
  }

  if (!response.ok) {
    const upstream = safeComposioErrorMetadata(json);
    console.warn('[kiloclaw:composio] upstream request failed', {
      operation,
      status: response.status,
      upstream,
    });
    throw new ComposioApiError(`Composio ${operation} failed`, response.status, operation);
  }

  return json;
}

export async function signupComposioAgentIdentity(
  params: { idempotencyKey?: string; fetchImpl?: typeof fetch } | typeof fetch = {}
): Promise<ComposioAgentIdentity> {
  const fetchImpl = typeof params === 'function' ? params : (params.fetchImpl ?? fetch);
  const idempotencyKey = typeof params === 'function' ? undefined : params.idempotencyKey;
  const response = await fetchImpl(joinUrl(COMPOSIO_AGENTS_API_BASE_URL, '/api/signup'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(idempotencyKey ? { request_id: idempotencyKey } : {}),
  });
  const json = await parseJsonResponse(response, 'agent signup');
  const parsed = AgentSignupReadyResponseSchema.safeParse(json);
  if (!parsed.success || parsed.data.status.toLowerCase() !== 'ready') {
    throw new ComposioApiError(
      'Composio agent identity is not ready',
      response.status,
      'agent signup'
    );
  }
  return parsed.data;
}

export async function getComposioAgentIdentity(
  agentKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<ComposioAgentIdentity> {
  const response = await fetchImpl(joinUrl(COMPOSIO_AGENTS_API_BASE_URL, '/api/whoami'), {
    headers: { authorization: `Bearer ${agentKey}` },
  });
  const json = await parseJsonResponse(response, 'agent whoami');
  const parsed = AgentWhoamiResponseSchema.safeParse(json);
  if (!parsed.success || parsed.data.status.toLowerCase() !== 'ready') {
    throw new ComposioApiError(
      'Composio agent identity is not ready',
      response.status,
      'agent whoami'
    );
  }
  return parsed.data;
}

export async function resolveComposioConsumerProject(
  params: {
    userApiKey: string;
    orgId: string;
  },
  fetchImpl: typeof fetch = fetch
): Promise<ComposioConsumerProject> {
  const response = await fetchImpl(
    joinUrl(COMPOSIO_API_BASE_URL, '/api/v3/org/consumer/project/resolve'),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...userOrgAuthHeaders(params),
      },
      body: '{}',
    }
  );
  const json = await parseJsonResponse(response, 'consumer project resolve');
  return ConsumerProjectResolveResponseSchema.parse(json);
}

export async function createComposioGoogleCalendarConnectLink(params: {
  auth: ComposioUserContextAuth;
  userId: string;
  callbackUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<{ redirectUrl: string; connectedAccountId: string }> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const sessionResponse = await fetchImpl(
    joinUrl(COMPOSIO_API_BASE_URL, '/api/v3/tool_router/session'),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...contextAuthHeaders(params.auth),
      },
      body: JSON.stringify({
        user_id: params.userId,
        toolkits: { enable: [GOOGLE_CALENDAR_TOOLKIT_SLUG] },
        manage_connections: { enable: true },
      }),
    }
  );
  const sessionJson = await parseJsonResponse(sessionResponse, 'session create');
  const session = SessionCreateResponseSchema.parse(sessionJson);

  const linkResponse = await fetchImpl(
    joinUrl(COMPOSIO_API_BASE_URL, `/api/v3/tool_router/session/${session.session_id}/link`),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...contextAuthHeaders(params.auth),
      },
      body: JSON.stringify({
        toolkit: GOOGLE_CALENDAR_TOOLKIT_SLUG,
        callback_url: params.callbackUrl,
      }),
    }
  );
  const json = await parseJsonResponse(linkResponse, 'connect link create');
  const parsed = LinkCreateResponseSchema.parse(json);
  return {
    redirectUrl: parsed.redirect_url,
    connectedAccountId: parsed.connected_account_id,
  };
}

export async function listComposioConnectedAccounts(params: {
  auth: ComposioUserContextAuth;
  userId: string;
  fetchImpl?: typeof fetch;
}): Promise<ComposioConnectedAccount[]> {
  const url = new URL(joinUrl(COMPOSIO_API_BASE_URL, '/api/v3/connected_accounts'));
  url.searchParams.append('user_ids', params.userId);
  url.searchParams.append('toolkit_slugs', GOOGLE_CALENDAR_TOOLKIT_SLUG);
  url.searchParams.append('limit', '25');

  const response = await (params.fetchImpl ?? fetch)(url, {
    headers: contextAuthHeaders(params.auth),
  });
  const json = await parseJsonResponse(response, 'connected account list');
  return ConnectedAccountListResponseSchema.parse(json).items;
}
