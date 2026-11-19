/* eslint-disable import/no-nodejs-modules, max-lines, promise/avoid-new, promise/prefer-await-to-callbacks */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { mockKiloApi, safeToolNames } from './kilo-api-fixture';
import {
  launchExtensionContext,
  seedExtensionAuth,
  startFixtureServer,
} from './extension-context-fixture';
import { REMOTE_MCP_STORAGE_KEY } from '../../src/shared/remote-mcp-storage';

type StreamableTransportOptions = ConstructorParameters<typeof StreamableHTTPServerTransport>[0];

// Default Playwright timeout; the OAuth discovery walk needs the longer budget.
test.setTimeout(120_000);

const ACCESS_TOKEN = 'fixture-oauth-access-token';
const CLIENT_ID = 'fixture-oauth-client';
const NEEDS_CREDENTIALS_MESSAGE =
  'This server needs credentials. Add a bearer token, a custom header, or OAuth in Edit.';

interface RecordedRequest {
  readonly authorization: string | undefined;
  readonly method: string;
  readonly path: string;
}

interface OAuthMcpFixture {
  readonly close: () => Promise<void>;
  readonly requests: RecordedRequest[];
  readonly url: string;
}

const jsonResponse = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const readRequestBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: string[] = [];

  for await (const chunk of request) {
    chunks.push(String(chunk));
  }

  return chunks.join('');
};

/*
 * In-test OAuth authorization-server + MCP resource server. The MCP endpoint
 * demands `Bearer <accessToken>`; without it the fixture answers 401 with the
 * RFC 9728 `resource_metadata` pointer, which is what makes the SDK client walk
 * OAuth discovery. Every request path is recorded so a test can see whether the
 * authorization endpoint (`GET /authorize`) was requested.
 */
const startOAuthMcpFixtureServer = async (): Promise<OAuthMcpFixture> => {
  const requests: RecordedRequest[] = [];

  const makeServer = (): McpServer => {
    const server = new McpServer({ name: 'kilo-mcp-fixture', version: '0.0.0' });

    server.registerTool(
      'get_weather',
      {
        description: 'Returns the current weather as JSON.',
        inputSchema: { city: z.string() },
      },
      () => ({
        content: [{ text: JSON.stringify({ city: 'Skopje', tempC: 21 }), type: 'text' as const }],
      })
    );

    return server;
  };

  const serveMcpRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
    body: unknown
  ): Promise<void> => {
    /*
     * Stateless mode: a fresh server + transport per request. The SDK option and
     * Transport types omit undefined under exactOptionalPropertyTypes, so widen
     * through unknown; sessionIdGenerator: undefined is the documented stateless
     * signal.
     */
    const transport = new StreamableHTTPServerTransport(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      { sessionIdGenerator: undefined } as unknown as StreamableTransportOptions
    );
    const server = makeServer();

    response.once('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      transport as unknown as Parameters<McpServer['connect']>[0]
    );
    await transport.handleRequest(request, response, body);
  };

  // The port is only known after listen(), so every absolute URL is read lazily.
  let baseUrl = '';

  const httpServer = createServer((request, response) => {
    void (async (): Promise<void> => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const method = request.method ?? 'GET';

      requests.push({
        authorization: request.headers.authorization,
        method,
        path: url.pathname,
      });

      const authorizationServerMetadata = {
        authorization_endpoint: `${baseUrl}/authorize`,
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        issuer: baseUrl,
        registration_endpoint: `${baseUrl}/register`,
        response_types_supported: ['code'],
        token_endpoint: `${baseUrl}/token`,
        token_endpoint_auth_methods_supported: ['none'],
      };

      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        jsonResponse(response, 200, {
          authorization_servers: [baseUrl],
          resource: `${baseUrl}/mcp`,
        });
        return;
      }

      if (
        url.pathname === '/.well-known/oauth-authorization-server' ||
        url.pathname === '/.well-known/openid-configuration'
      ) {
        jsonResponse(response, 200, authorizationServerMetadata);
        return;
      }

      if (url.pathname === '/register' && method === 'POST') {
        const raw = await readRequestBody(request);
        const parsed = z
          .object({ redirect_uris: z.array(z.string()).optional() })
          .loose()
          .safeParse(raw === '' ? {} : JSON.parse(raw));

        jsonResponse(response, 201, {
          client_id: CLIENT_ID,
          redirect_uris: parsed.success ? (parsed.data.redirect_uris ?? []) : [],
          token_endpoint_auth_method: 'none',
        });
        return;
      }

      // The interactive landing page: recorded above, never completed.
      if (url.pathname === '/authorize') {
        jsonResponse(response, 400, { error: 'access_denied' });
        return;
      }

      if (url.pathname === '/token') {
        jsonResponse(response, 400, { error: 'invalid_grant' });
        return;
      }

      if (url.pathname === '/mcp') {
        /*
         * The client opens a standalone GET SSE stream first; this server offers
         * none, and 405 is the answer the spec lets a server give for it.
         */
        if (method === 'GET') {
          if (request.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
            response.writeHead(401, {
              'content-type': 'application/json',
              'www-authenticate': `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
            });
            response.end(JSON.stringify({ error: 'unauthorized' }));
            return;
          }

          response.writeHead(405, { allow: 'POST' });
          response.end();
          return;
        }

        if (request.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
          response.writeHead(401, {
            'content-type': 'application/json',
            'www-authenticate': `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
          });
          response.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }

        const raw = await readRequestBody(request);
        await serveMcpRequest(request, response, raw === '' ? undefined : JSON.parse(raw));
        return;
      }

      jsonResponse(response, 404, { error: 'not_found' });
    })();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();

  if (address === null || typeof address === 'string') {
    throw new Error('OAuth MCP fixture server did not start on a TCP port.');
  }

  baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        // An open SSE or keep-alive socket would otherwise hold close() forever.
        httpServer.closeAllConnections();
        httpServer.close(error => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
    requests,
    url: `${baseUrl}/mcp`,
  };
};

// Serialize the stored remote MCP servers (or "null") so callers can inspect them.
const readStoredServersJson = (page: Page): Promise<string> =>
  page.evaluate(
    storageKey =>
      new Promise<string>((resolve, reject) => {
        const chromeApi = (
          globalThis as typeof globalThis & {
            chrome?: {
              runtime?: { lastError?: { message?: string } };
              storage?: {
                local?: {
                  get: (keys: string[], callback: (items: Record<string, unknown>) => void) => void;
                };
              };
            };
          }
        ).chrome;

        const runtime = chromeApi?.runtime;
        const storage = chromeApi?.storage?.local;

        if (runtime === undefined || storage === undefined) {
          reject(new Error('Extension runtime storage is unavailable.'));
          return;
        }

        // The WXT `local:` prefix is dropped by chrome.storage; the bare key is stored.
        const bareKey = storageKey.replace(/^local:/u, '');

        storage.get([bareKey], items => {
          const message = runtime.lastError?.message;

          if (message !== undefined && message !== '') {
            reject(new Error(message));
            return;
          }

          resolve(JSON.stringify(items[bareKey] ?? null));
        });
      }),
    REMOTE_MCP_STORAGE_KEY
  );

const writeStoredServers = (page: Page, store: unknown): Promise<void> =>
  page.evaluate(
    ({ storageKey, value }) =>
      new Promise<void>((resolve, reject) => {
        const chromeApi = (
          globalThis as typeof globalThis & {
            chrome?: {
              runtime?: { lastError?: { message?: string } };
              storage?: {
                local?: {
                  set: (items: Record<string, unknown>, callback: () => void) => void;
                };
              };
            };
          }
        ).chrome;

        const runtime = chromeApi?.runtime;
        const storage = chromeApi?.storage?.local;

        if (runtime === undefined || storage === undefined) {
          reject(new Error('Extension runtime storage is unavailable.'));
          return;
        }

        const bareKey = storageKey.replace(/^local:/u, '');

        storage.set({ [bareKey]: value }, () => {
          const message = runtime.lastError?.message;

          if (message !== undefined && message !== '') {
            reject(new Error(message));
            return;
          }

          resolve();
        });
      }),
    { storageKey: REMOTE_MCP_STORAGE_KEY, value: store }
  );

const storedOAuthStateSchema = z
  .object({
    clientInformation: z.object({ client_id: z.string() }).loose().optional(),
    tokens: z.object({ access_token: z.string(), token_type: z.string() }).loose().optional(),
  })
  .loose();

const storedServerSchema = z
  .object({
    auth: z.object({ oauth: storedOAuthStateSchema.optional(), type: z.string() }).loose(),
    displayName: z.string(),
    id: z.string(),
    lastError: z.string().optional(),
    status: z.string(),
  })
  .loose();

const storedStoreSchema = z.object({ servers: z.array(storedServerSchema) }).loose();

type StoredStore = z.infer<typeof storedStoreSchema>;
type StoredOAuthState = z.infer<typeof storedOAuthStateSchema>;

const readStoredStore = async (page: Page): Promise<StoredStore> =>
  storedStoreSchema.parse(JSON.parse(await readStoredServersJson(page)));

// Merge OAuth state into the single fixture server and persist the whole store.
const writeServerOAuthState = async (page: Page, patch: StoredOAuthState): Promise<void> => {
  const store = await readStoredStore(page);
  const servers: Record<string, unknown>[] = [];

  for (const server of store.servers) {
    servers.push({
      ...server,
      auth: { ...server.auth, oauth: { ...server.auth.oauth, ...patch }, type: 'oauth' },
    });
  }

  await writeStoredServers(page, { servers });
};

const readFixtureServerStatus = async (page: Page): Promise<string | undefined> => {
  const store = await readStoredStore(page);
  return store.servers.find(server => server.displayName === 'Fixture MCP')?.status;
};

const readFixtureServerLastError = async (page: Page): Promise<string | undefined> => {
  const store = await readStoredStore(page);
  return store.servers.find(server => server.displayName === 'Fixture MCP')?.lastError;
};

/** The requests that would open the authorization page. */
const authorizeRequests = (requests: readonly RecordedRequest[]): RecordedRequest[] =>
  requests.filter(request => request.method === 'GET' && request.path === '/authorize');

// Display name "Fixture MCP" -> slug "fixture-mcp" -> gateway tool name below.
const MAPPED_TOOL_NAME = 'mcp_fixture-mcp_get_weather';

// A two-turn Kilo API script: call the mapped MCP tool, then answer.
const turnMockConfig = {
  firstCompletionEvents: [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                function: {
                  arguments: JSON.stringify({ city: 'Skopje' }),
                  name: MAPPED_TOOL_NAME,
                },
                id: 'call_mcp_1',
                index: 0,
                type: 'function',
              },
            ],
          },
        },
      ],
    },
  ],
  secondCompletionEvents: [{ choices: [{ delta: { content: 'The weather in Skopje is 21C.' } }] }],
  // Both turns offer the safe tools plus the mapped MCP tool.
  toolNamesByCall: [
    [...safeToolNames, MAPPED_TOOL_NAME],
    [...safeToolNames, MAPPED_TOOL_NAME],
  ],
};

const openSidePanel = async (context: BrowserContext, extensionId: string): Promise<Page> => {
  const sidePanel = await context.newPage();
  await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await seedExtensionAuth(sidePanel);
  await sidePanel.reload();
  return sidePanel;
};

/*
 * Add "Fixture MCP" with OAuth auth through the settings form and allow it in
 * safe mode. Saving connects; with no stored tokens the row settles on its
 * Connect control with no tools, so the caller seeds tokens before the turn.
 */
const addOAuthServerAndAllowInSafeMode = async (sidePanel: Page, url: string): Promise<void> => {
  await sidePanel.getByRole('button', { name: 'Settings' }).click();
  await sidePanel.getByRole('button', { name: 'Add server' }).click();
  await sidePanel.getByLabel('Name').fill('Fixture MCP');
  await sidePanel.getByLabel('URL').fill(url);
  await sidePanel.getByLabel('Auth').selectOption('oauth');
  await sidePanel.getByRole('button', { name: 'Save' }).click();

  await expect(sidePanel.getByText('Fixture MCP')).toBeVisible();
  await expect(sidePanel.getByRole('button', { exact: true, name: 'Connect' })).toBeEnabled({
    timeout: 60_000,
  });

  await sidePanel.getByRole('button', { name: 'Edit Fixture MCP' }).click();
  const allowInSafeMode = sidePanel.getByLabel('Allow in safe mode');
  await expect(allowInSafeMode).not.toBeChecked();
  await allowInSafeMode.check();
  await expect(sidePanel.getByLabel('Enabled')).toBeChecked();
  await sidePanel.getByRole('button', { name: 'Save' }).click();

  // The second save also connects without tokens; wait for the row to settle.
  await expect(sidePanel.getByRole('button', { exact: true, name: 'Connect' })).toBeEnabled({
    timeout: 60_000,
  });
};

/*
 * Opening the panel connects every enabled server in the background (the chat
 * panel's load effect), so a reload with tokens already seeded caches the tool
 * and marks the server connected without touching the Connect control.
 */
const reloadUntilToolCached = async (sidePanel: Page): Promise<void> => {
  await sidePanel.reload();
  await expect
    .poll(
      async () => {
        const store = await readStoredStore(sidePanel);
        return store.servers.find(candidate => candidate.displayName === 'Fixture MCP')?.status;
      },
      { timeout: 60_000 }
    )
    .toBe('connected');

  await sidePanel.getByRole('button', { name: 'Settings' }).click();
  await expect(sidePanel.getByText('1 tool')).toBeVisible({ timeout: 60_000 });
  await expect(sidePanel.getByRole('button', { name: 'Refresh' })).toBeVisible();
};

const sendWeatherTurn = async (sidePanel: Page): Promise<void> => {
  await sidePanel.getByRole('button', { name: 'Close settings' }).click();
  await sidePanel.getByLabel('Message agent').fill('What is the weather in Skopje?');
  await sidePanel.getByLabel('Message agent').press('Enter');
};

test('a model-initiated OAuth tool call asks for credentials and records that the server needs them', async () => {
  const fixture = await startFixtureServer();
  const mcp = await startOAuthMcpFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, turnMockConfig);

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await openSidePanel(context, extensionId);
    await addOAuthServerAndAllowInSafeMode(sidePanel, mcp.url);

    await writeServerOAuthState(sidePanel, {
      clientInformation: { client_id: CLIENT_ID },
      tokens: { access_token: ACCESS_TOKEN, token_type: 'Bearer' },
    });
    await reloadUntilToolCached(sidePanel);

    /*
     * Revoke the token without reloading: the panel keeps the connected server
     * and its cached tool, so the turn offers the tool and the call itself is
     * what fails — the branch under test.
     */
    await writeServerOAuthState(sidePanel, {
      tokens: { access_token: 'revoked-token', token_type: 'Bearer' },
    });

    // Only the turn's own requests matter, so drop the setup traffic first.
    mcp.requests.length = 0;
    await sendWeatherTurn(sidePanel);

    const toolRow = sidePanel
      .getByText(`${MAPPED_TOOL_NAME} failed`)
      .locator('xpath=ancestor::details[1]');
    await expect(toolRow).toBeVisible({ timeout: 60_000 });
    await toolRow.getByText(`${MAPPED_TOOL_NAME} failed`).click();
    await expect(toolRow.getByText('Error')).toBeVisible();
    await expect(toolRow.getByText(NEEDS_CREDENTIALS_MESSAGE)).toBeVisible();

    // The failure persists as needs-sign-in so the next Connect can act on it.
    await expect
      .poll(() => readFixtureServerStatus(sidePanel), { timeout: 30_000 })
      .toBe('needs_auth');

    // The row shows why it needs credentials, not a bare Connect control.
    await expect
      .poll(() => readFixtureServerLastError(sidePanel), { timeout: 30_000 })
      .toBe(NEEDS_CREDENTIALS_MESSAGE);

    // The sign-in step stays with the settings Connect flow; this path asks for credentials.
    expect(authorizeRequests(mcp.requests)).toStrictEqual([]);
    // Discovery still ran: the 401's resource-metadata pointer was followed before the flow stopped.
    expect(mcp.requests.map(request => `${request.method} ${request.path}`)).toContain(
      'GET /.well-known/oauth-protected-resource'
    );
  } finally {
    await context.close();
    await mcp.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('a model-initiated OAuth tool call runs with stored tokens', async () => {
  const fixture = await startFixtureServer();
  const mcp = await startOAuthMcpFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, turnMockConfig);

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await openSidePanel(context, extensionId);
    await addOAuthServerAndAllowInSafeMode(sidePanel, mcp.url);

    await writeServerOAuthState(sidePanel, {
      clientInformation: { client_id: CLIENT_ID },
      tokens: { access_token: ACCESS_TOKEN, token_type: 'Bearer' },
    });
    await reloadUntilToolCached(sidePanel);

    mcp.requests.length = 0;
    await sendWeatherTurn(sidePanel);

    // The tool row renders the fixture's JSON result.
    const toolRow = sidePanel
      .getByText(`${MAPPED_TOOL_NAME} completed`)
      .locator('xpath=ancestor::details[1]');
    await expect(toolRow).toBeVisible({ timeout: 60_000 });
    await toolRow.getByText(`${MAPPED_TOOL_NAME} completed`).click();
    await expect(toolRow.getByText(String.raw`{\"city\":\"Skopje\",\"tempC\":21}`)).toBeVisible();
    await expect(sidePanel.getByText('The weather in Skopje is 21C.')).toBeVisible();

    // The call carried the stored bearer token, and no authorization page was requested.
    expect(mcp.requests.length).toBeGreaterThan(0);
    expect(mcp.requests.map(request => request.authorization)).toContain(`Bearer ${ACCESS_TOKEN}`);
    expect(authorizeRequests(mcp.requests)).toStrictEqual([]);
  } finally {
    await context.close();
    await mcp.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('editing an OAuth server keeps its stored credentials', async () => {
  const fixture = await startFixtureServer();
  const mcp = await startOAuthMcpFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, turnMockConfig);

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await openSidePanel(context, extensionId);
    await addOAuthServerAndAllowInSafeMode(sidePanel, mcp.url);

    await writeServerOAuthState(sidePanel, {
      clientInformation: { client_id: CLIENT_ID },
      tokens: { access_token: ACCESS_TOKEN, token_type: 'Bearer' },
    });
    await reloadUntilToolCached(sidePanel);

    // Only the edit's own requests matter, so drop the setup traffic first.
    mcp.requests.length = 0;

    await sidePanel.getByRole('button', { name: 'Edit Fixture MCP' }).click();
    await sidePanel.getByLabel('Name').fill('Fixture MCP Renamed');
    await sidePanel.getByRole('button', { name: 'Save' }).click();

    await expect(sidePanel.getByText('Fixture MCP Renamed')).toBeVisible();
    // Saving reconnects, so the row must settle with its stored token, not a Connect control.
    await expect(sidePanel.getByRole('button', { name: 'Refresh' })).toBeEnabled({
      timeout: 60_000,
    });

    const store = await readStoredStore(sidePanel);
    const edited = store.servers.find(server => server.displayName === 'Fixture MCP Renamed');
    expect(edited?.auth.oauth?.tokens?.access_token).toBe(ACCESS_TOKEN);
    expect(edited?.auth.oauth?.clientInformation?.client_id).toBe(CLIENT_ID);
    // The edit reused the stored client and token, so it never opened the authorization page.
    expect(authorizeRequests(mcp.requests)).toStrictEqual([]);
  } finally {
    await context.close();
    await mcp.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
