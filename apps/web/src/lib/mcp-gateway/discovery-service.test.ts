jest.mock('node:dns/promises', () => ({ resolve4: jest.fn(), resolve6: jest.fn() }));
jest.mock('node:https', () => ({ request: jest.fn() }));

import { resolve4, resolve6 } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import {
  connectedAddress,
  recordHttpsRequests,
  type RecordedRequest,
} from '@/tests/helpers/outbound-https-mock';
import { createDiscoveryService } from './discovery-service';

const publicAddresses: Record<string, string> = {
  'mcp.example': '93.184.216.34',
  'auth.example': '93.184.216.99',
  'register.example': '93.184.216.100',
};

function json(value: unknown, status = 200) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  };
}

function discoveryReply(request: RecordedRequest) {
  const { hostname, path } = request.options;
  if (hostname === 'mcp.example' && path === '/.well-known/oauth-protected-resource') {
    return json({
      resource: 'https://mcp.example/mcp',
      authorization_servers: ['https://auth.example'],
    });
  }
  if (hostname === 'mcp.example' && path === '/mcp') {
    return {
      status: 401,
      headers: { 'www-authenticate': 'Bearer scope="files:read"' },
    };
  }
  if (hostname === 'auth.example' && path === '/.well-known/oauth-authorization-server') {
    return { status: 404 };
  }
  if (hostname === 'auth.example' && path === '/.well-known/openid-configuration') {
    return json({
      issuer: 'https://auth.example',
      authorization_endpoint: 'https://auth.example/authorize',
      token_endpoint: 'https://auth.example/token',
    });
  }
  return { status: 404 };
}

describe('MCP gateway discovery outbound requests', () => {
  let answers: Record<string, string>;

  beforeEach(() => {
    answers = { ...publicAddresses };
    jest.mocked(resolve4).mockReset();
    jest.mocked(resolve6).mockReset();
    jest.mocked(httpsRequest).mockReset();
    jest.mocked(resolve4).mockImplementation(async hostname => [answers[hostname] as string]);
    jest.mocked(resolve6).mockResolvedValue([]);
  });

  it('connects discovery requests to the address resolved for each request', async () => {
    const recorded = recordHttpsRequests(discoveryReply);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const service = createDiscoveryService({});

    const discovery = await service.discoverRemoteProvider('https://mcp.example/mcp');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(discovery.providerCandidates).toEqual([
      {
        issuer: 'https://auth.example',
        authorization_endpoint: 'https://auth.example/authorize',
        token_endpoint: 'https://auth.example/token',
      },
    ]);
    expect(recorded.map(request => request.options.path)).toEqual([
      '/.well-known/oauth-protected-resource',
      '/mcp',
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
    ]);
    expect(jest.mocked(resolve4)).toHaveBeenCalledTimes(recorded.length);
    for (const request of recorded) {
      const hostname = request.options.hostname;
      expect(connectedAddress(request)).toBe(publicAddresses[hostname]);
      expect(jest.mocked(resolve4)).toHaveBeenCalledTimes(recorded.length);
    }
  });

  it('keeps the address chosen when the request started', async () => {
    const recorded = recordHttpsRequests(discoveryReply);
    const service = createDiscoveryService({});

    await service.discoverRemoteProvider('https://mcp.example/mcp');
    const resolveCalls = jest.mocked(resolve4).mock.calls.length;
    answers['mcp.example'] = '169.254.169.254';
    answers['auth.example'] = '10.0.0.7';

    for (const request of recorded) {
      const hostname = request.options.hostname;
      expect(connectedAddress(request)).toBe(publicAddresses[hostname]);
    }
    expect(jest.mocked(resolve4).mock.calls.length).toBe(resolveCalls);
  });

  it('rejects discovery when a resolved address is not public', async () => {
    answers['auth.example'] = '169.254.169.254';
    recordHttpsRequests(discoveryReply);
    const service = createDiscoveryService({});

    await expect(service.discoverRemoteProvider('https://mcp.example/mcp')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(jest.mocked(httpsRequest)).toHaveBeenCalledTimes(2);
  });

  it('posts dynamic registration to the resolved address', async () => {
    const recorded = recordHttpsRequests(() => json({ client_id: 'client-1' }));
    const service = createDiscoveryService({});

    const registration = await service.registerDynamicProviderClient({
      registrationEndpoint: 'https://register.example/register',
      redirectUri: 'https://app.example/callback',
    });

    expect(registration).toEqual({ client_id: 'client-1' });
    expect(recorded).toHaveLength(1);
    const request = recorded[0] as RecordedRequest;
    expect(request.options.method).toBe('POST');
    expect(request.options.path).toBe('/register');
    expect(jest.mocked(resolve4)).toHaveBeenCalledTimes(1);
    expect(connectedAddress(request)).toBe(publicAddresses['register.example']);
  });
});
