jest.mock('@/lib/config.server', () => ({
  COMPOSIO_AGENTS_API_BASE_URL: 'https://agents.example.com',
  COMPOSIO_API_BASE_URL: 'https://api.example.com',
}));

import {
  createComposioConnectLink,
  listComposioConnectedAccounts,
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

  it('creates a Connect Link with the managed identity API key', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return jsonResponse({
        redirect_url: 'https://composio.example.com/connect/link',
        connected_account_id: 'ca_123',
      });
    };

    const result = await createComposioConnectLink({
      apiKey: 'api-key',
      userId: 'kiloclaw:user:user-1',
      authConfigId: 'auth-config-1',
      callbackUrl: 'https://app.example.com/api/integrations/composio/callback',
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result).toEqual({
      redirectUrl: 'https://composio.example.com/connect/link',
      connectedAccountId: 'ca_123',
    });
    expect(requests[0].url).toBe('https://api.example.com/api/v3/connected_accounts/link');
    expect(requests[0].init?.headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'api-key',
    });
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      auth_config_id: 'auth-config-1',
      user_id: 'kiloclaw:user:user-1',
      callback_url: 'https://app.example.com/api/integrations/composio/callback',
    });
  });

  it('filters connected accounts by consumer user and auth config', async () => {
    const requests: string[] = [];
    const fetchImpl = async (url: string | URL | Request) => {
      requests.push(String(url));
      return jsonResponse({
        items: [
          {
            id: 'ca_123',
            status: 'ACTIVE',
            toolkit: { slug: 'googlecalendar' },
            auth_config: { id: 'auth-config-1' },
          },
        ],
      });
    };

    const accounts = await listComposioConnectedAccounts({
      apiKey: 'api-key',
      userId: 'kiloclaw:user:user-1',
      authConfigId: 'auth-config-1',
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(accounts).toHaveLength(1);
    const url = new URL(requests[0]);
    expect(url.origin + url.pathname).toBe('https://api.example.com/api/v3/connected_accounts');
    expect(url.searchParams.get('user_ids')).toBe('kiloclaw:user:user-1');
    expect(url.searchParams.get('auth_config_ids')).toBe('auth-config-1');
    expect(url.searchParams.get('toolkit_slugs')).toBe('googlecalendar');
  });
});
