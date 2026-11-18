import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll } from 'vitest';
import { answer, bodyOf, readingFile, write, type Fixture } from './remote-mcp-fixture.js';
import type {
  RemoteMcpOAuthClient,
  RemoteMcpOAuthClientMetadata,
  RemoteMcpOAuthTokens,
  RemoteMcpServer,
  RemoteMcpSignInProvider,
} from './index.js';

/**
 * An MCP server behind its own OAuth authorization server, for the sign-in
 * suite: protected-resource metadata (RFC 9728), authorization-server metadata
 * (RFC 8414), dynamic registration (RFC 7591), PKCE, and refresh. `/authorize`
 * approves at once and redirects, so the browser a person would use is one
 * `fetch` that does not follow the redirect.
 */

interface OAuthServer {
  readonly url: string;
  /** The server stops accepting every access token; a refresh still works. */
  readonly revokeAccess: () => void;
  /** The server stops accepting every access and refresh token. */
  readonly revokeAll: () => void;
}

interface Grants {
  readonly access: Set<string>;
  readonly refresh: Set<string>;
  readonly challenges: Map<string, string>;
  minted: number;
}

interface Context {
  origin: string;
  readonly grants: Grants;
}

type Handler = (request: IncomingMessage, response: ServerResponse, context: Context) => unknown;

const opened: Server[] = [];

afterAll(() => {
  for (const server of opened) {
    server.close();
  }
});

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const textOf = async (request: IncomingMessage): Promise<string> => {
  const chunks: string[] = [];
  for await (const chunk of request) {
    chunks.push(String(chunk));
  }
  return chunks.join('');
};

const mint = (grants: Grants, prefix: string): string => {
  grants.minted += 1;
  return `${prefix}-${String(grants.minted)}`;
};

const issue = (response: ServerResponse, grants: Grants): void => {
  const access = mint(grants, 'access');
  const refresh = mint(grants, 'refresh');
  grants.access.add(access);
  grants.refresh.add(refresh);
  json(response, 200, {
    access_token: access,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: refresh,
  });
};

/** Whether a code was issued here and the verifier is the one its challenge was made from. */
const codeGranted = (form: URLSearchParams, grants: Grants): boolean => {
  const code = form.get('code') ?? '';
  const challenge = grants.challenges.get(code);
  const verifier = createHash('sha256')
    .update(form.get('code_verifier') ?? '')
    .digest('base64url');
  return grants.challenges.delete(code) && challenge === verifier;
};

const token: Handler = async (request, response, { grants }) => {
  const form = new URLSearchParams(await textOf(request));
  const granted =
    form.get('grant_type') === 'authorization_code'
      ? codeGranted(form, grants)
      : grants.refresh.delete(form.get('refresh_token') ?? '');
  if (granted) {
    issue(response, grants);
  } else {
    json(response, 400, { error: 'invalid_grant' });
  }
};

const authorize: Handler = (request, response, { origin, grants }) => {
  const url = new URL(request.url ?? '/', origin);
  const code = mint(grants, 'code');
  grants.challenges.set(code, url.searchParams.get('code_challenge') ?? '');
  const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
  redirect.searchParams.set('code', code);
  response.writeHead(302, { location: redirect.href });
  response.end();
};

const register: Handler = async (request, response) => {
  const asked: unknown = JSON.parse(await textOf(request));
  json(response, 201, { ...(typeof asked === 'object' ? asked : {}), client_id: 'client-1' });
};

const authorizationServer: Handler = (_request, response, { origin }) => {
  json(response, 200, {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
};

const protectedResource: Handler = (_request, response, { origin }) => {
  json(response, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
};

const answering: Fixture = {
  tools: readingFile,
  seen: { authorization: [] },
  mode: 'answer',
  callDelayMs: 0,
};

const mcp: Handler = async (request, response, { origin, grants }) => {
  const bearer = request.headers.authorization?.replace(/^Bearer /u, '') ?? '';
  if (!grants.access.has(bearer)) {
    response.writeHead(401, {
      'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    });
    response.end();
    return;
  }
  if (request.method === 'GET') {
    write(response, [405]);
    return;
  }
  write(response, answer(await bodyOf(request), answering));
};

const routes: Readonly<Record<string, Handler>> = {
  '/.well-known/oauth-protected-resource': protectedResource,
  '/.well-known/oauth-protected-resource/mcp': protectedResource,
  '/.well-known/oauth-authorization-server': authorizationServer,
  '/register': register,
  '/authorize': authorize,
  '/token': token,
  '/mcp': mcp,
};

const route: Handler = (request, response, context) => {
  const { pathname } = new URL(request.url ?? '/', context.origin);
  const handler = routes[pathname];
  if (handler === undefined) {
    json(response, 404, { error: 'not_found' });
    return;
  }
  return handler(request, response, context);
};

const listening = async (server: Server): Promise<string> => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test server took no port');
  }
  return `http://127.0.0.1:${String(address.port)}`;
};

const serveOAuth = async (): Promise<OAuthServer> => {
  const grants: Grants = {
    access: new Set(),
    refresh: new Set(),
    challenges: new Map(),
    minted: 0,
  };
  const context: Context = { origin: '', grants };
  const server = createServer((request, response) => {
    void route(request, response, context);
  });
  opened.push(server);
  context.origin = await listening(server);
  return {
    url: `${context.origin}/mcp`,
    revokeAccess: () => {
      grants.access.clear();
    },
    revokeAll: () => {
      grants.access.clear();
      grants.refresh.clear();
    },
  };
};

interface MemoryProvider extends RemoteMcpSignInProvider {
  readonly saved: () => RemoteMcpOAuthTokens | undefined;
}

interface Remembered {
  tokens?: RemoteMcpOAuthTokens;
  client?: RemoteMcpOAuthClient;
  verifier?: string;
  code?: string;
}

const redirectUrl = 'kiloapp:///remote-mcp';

const clientMetadata: RemoteMcpOAuthClientMetadata = {
  client_name: 'Harness test',
  redirect_uris: [redirectUrl],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

/** The code `/authorize` redirects with, read without following the redirect. */
const followed = async (url: URL): Promise<string | undefined> => {
  const redirected = await fetch(url, { redirect: 'manual' });
  return new URL(redirected.headers.get('location') ?? '').searchParams.get('code') ?? undefined;
};

/**
 * A provider that keeps its state in memory. Its browser follows the
 * authorization URL once and keeps the code the redirect carries, unless the
 * person `turnsBack`.
 */
const memoryProvider = ({ turnsBack = false } = {}): MemoryProvider => {
  const state: Remembered = {};
  return {
    redirectUrl,
    clientMetadata,
    clientInformation: () => state.client,
    saveClientInformation: client => {
      state.client = client;
    },
    tokens: () => state.tokens,
    saveTokens: tokens => {
      state.tokens = tokens;
    },
    saved: () => state.tokens,
    saveCodeVerifier: verifier => {
      state.verifier = verifier;
    },
    codeVerifier: () => state.verifier ?? '',
    invalidateCredentials: scope => {
      if (scope === 'all' || scope === 'tokens') {
        delete state.tokens;
      }
    },
    redirectToAuthorization: async url => {
      const code = turnsBack ? undefined : await followed(url);
      if (code !== undefined) {
        state.code = code;
      }
    },
    takeAuthorizationCode: () => {
      const { code } = state;
      delete state.code;
      return code;
    },
  };
};

const oauthServerFor = (url: string): RemoteMcpServer => ({
  id: 'work',
  name: 'Test server',
  url,
  auth: { type: 'oauth' },
});

export type { MemoryProvider, OAuthServer };
export { memoryProvider, oauthServerFor, serveOAuth };
