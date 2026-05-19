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

const LinkCreateResponseSchema = z.object({
  redirect_url: z.string().url(),
  connected_account_id: z.string(),
  expires_at: z.string().optional(),
  link_token: z.string().optional(),
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

async function parseJsonResponse(response: Response, operation: string): Promise<unknown> {
  if (!response.ok) {
    throw new ComposioApiError(`Composio ${operation} failed`, response.status, operation);
  }

  try {
    return await response.json();
  } catch {
    throw new ComposioApiError(
      `Composio ${operation} returned invalid JSON`,
      response.status,
      operation
    );
  }
}

export async function signupComposioAgentIdentity(
  fetchImpl: typeof fetch = fetch
): Promise<ComposioAgentIdentity> {
  const response = await fetchImpl(joinUrl(COMPOSIO_AGENTS_API_BASE_URL, '/api/signup'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
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

export async function createComposioConnectLink(params: {
  apiKey: string;
  userId: string;
  authConfigId: string;
  callbackUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<{ redirectUrl: string; connectedAccountId: string }> {
  const response = await (params.fetchImpl ?? fetch)(
    joinUrl(COMPOSIO_API_BASE_URL, '/api/v3/connected_accounts/link'),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': params.apiKey,
      },
      body: JSON.stringify({
        auth_config_id: params.authConfigId,
        user_id: params.userId,
        callback_url: params.callbackUrl,
      }),
    }
  );
  const json = await parseJsonResponse(response, 'connect link create');
  const parsed = LinkCreateResponseSchema.parse(json);
  return {
    redirectUrl: parsed.redirect_url,
    connectedAccountId: parsed.connected_account_id,
  };
}

export async function listComposioConnectedAccounts(params: {
  apiKey: string;
  userId: string;
  authConfigId: string;
  fetchImpl?: typeof fetch;
}): Promise<ComposioConnectedAccount[]> {
  const url = new URL(joinUrl(COMPOSIO_API_BASE_URL, '/api/v3/connected_accounts'));
  url.searchParams.append('user_ids', params.userId);
  url.searchParams.append('auth_config_ids', params.authConfigId);
  url.searchParams.append('toolkit_slugs', 'googlecalendar');
  url.searchParams.append('limit', '25');

  const response = await (params.fetchImpl ?? fetch)(url, {
    headers: { 'x-api-key': params.apiKey },
  });
  const json = await parseJsonResponse(response, 'connected account list');
  return ConnectedAccountListResponseSchema.parse(json).items;
}
