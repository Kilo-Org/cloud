jest.mock('@/lib/config.server', () => ({
  COMPOSIO_AGENTS_API_BASE_URL: 'https://agents.example.com',
  COMPOSIO_API_BASE_URL: 'https://api.example.com',
}));

import {
  createComposioGoogleCalendarConnectLink,
  listComposioConnectedAccounts,
  resolveComposioConsumerProject,
  signupComposioAgentIdentity,
} from './composio-client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Composio client', () => {
  it('signs up a ready agent identity', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return jsonResponse({
        status: 'ready',
        agent_key: 'agent-key',
        email: 'agent@example.com',
        composio: {
          org_id: 'org-1',
          project_id: 'project-1',
          api_key: 'api-key',
          user_api_key: 'uak_123',
        },
      });
    };

    const identity = await signupComposioAgentIdentity(fetchImpl as typeof fetch);

    expect(identity.agent_key).toBe('agent-key');
    expect(identity.composio.user_api_key).toBe('uak_123');
    expect(requests).toEqual([
      {
        url: 'https://agents.example.com/api/signup',
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        },
      },
    ]);
  });

  it('sends a recovery request id when signing up an agent identity', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return jsonResponse({
        status: 'ready',
        request_id: 'reservation-1',
        agent_key: 'agent-key',
        composio: {
          org_id: 'org-1',
          user_api_key: 'uak_123',
        },
      });
    };

    await signupComposioAgentIdentity({
      idempotencyKey: 'reservation-1',
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(requests[0]?.init?.body).toBe(JSON.stringify({ request_id: 'reservation-1' }));
  });

  it('creates a Google Calendar Connect Link through a Composio session', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith('/api/v3/tool_router/session')) {
        return jsonResponse({ session_id: 'session_123' });
      }
      return jsonResponse({
        redirect_url: 'https://composio.example.com/connect/link',
        connected_account_id: 'ca_123',
      });
    };

    const result = await createComposioGoogleCalendarConnectLink({
      auth: {
        userApiKey: 'uak_123',
        orgId: 'org-1',
        projectId: 'project-1',
      },
      userId: 'kiloclaw:user:user-1',
      callbackUrl: 'https://app.example.com/api/integrations/composio/callback',
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result).toEqual({
      redirectUrl: 'https://composio.example.com/connect/link',
      connectedAccountId: 'ca_123',
    });
    expect(requests[0].url).toBe('https://api.example.com/api/v3/tool_router/session');
    expect(requests[0].init?.headers).toEqual({
      'content-type': 'application/json',
      'x-user-api-key': 'uak_123',
      'x-org-id': 'org-1',
      'x-project-id': 'project-1',
    });
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      user_id: 'kiloclaw:user:user-1',
      toolkits: { enable: ['googlecalendar'] },
      manage_connections: { enable: true },
    });
    expect(requests[1].url).toBe(
      'https://api.example.com/api/v3/tool_router/session/session_123/link'
    );
    expect(JSON.parse(String(requests[1].init?.body))).toEqual({
      toolkit: 'googlecalendar',
      callback_url: 'https://app.example.com/api/integrations/composio/callback',
    });
    expect(requests[1].init?.headers).toEqual({
      'content-type': 'application/json',
      'x-user-api-key': 'uak_123',
      'x-org-id': 'org-1',
      'x-project-id': 'project-1',
    });
  });

  it('resolves the consumer project using user API key and org context', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return jsonResponse({
        project_id: 'project-db-id',
        project_nano_id: 'proj_nano_123',
        project_name: 'Consumer Project',
        org_id: 'org-1',
        project_type: 'CONSUMER',
        consumer_user_id: 'consumer-user-1',
      });
    };

    const project = await resolveComposioConsumerProject(
      { userApiKey: 'uak_123', orgId: 'org-1' },
      fetchImpl as typeof fetch
    );

    expect(project.project_nano_id).toBe('proj_nano_123');
    expect(project.consumer_user_id).toBe('consumer-user-1');
    expect(requests).toEqual([
      {
        url: 'https://api.example.com/api/v3/org/consumer/project/resolve',
        init: {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-user-api-key': 'uak_123',
            'x-org-id': 'org-1',
          },
          body: '{}',
        },
      },
    ]);
  });

  it('filters connected accounts by consumer user and Google Calendar toolkit', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return jsonResponse({
        items: [
          {
            id: 'ca_123',
            status: 'ACTIVE',
            toolkit: { slug: 'googlecalendar' },
          },
        ],
      });
    };

    const accounts = await listComposioConnectedAccounts({
      auth: {
        userApiKey: 'uak_123',
        orgId: 'org-1',
        projectId: 'project-1',
      },
      userId: 'kiloclaw:user:user-1',
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(accounts).toHaveLength(1);
    const url = new URL(requests[0].url);
    expect(url.origin + url.pathname).toBe('https://api.example.com/api/v3/connected_accounts');
    expect(url.searchParams.get('user_ids')).toBe('kiloclaw:user:user-1');
    expect(url.searchParams.get('auth_config_ids')).toBeNull();
    expect(url.searchParams.get('toolkit_slugs')).toBe('googlecalendar');
    expect(requests[0].init?.headers).toEqual({
      'x-user-api-key': 'uak_123',
      'x-org-id': 'org-1',
      'x-project-id': 'project-1',
    });
  });
});
