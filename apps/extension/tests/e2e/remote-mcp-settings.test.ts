/* eslint-disable import/no-nodejs-modules, max-lines, promise/avoid-new, promise/prefer-await-to-callbacks */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { z } from 'zod';
import { mockKiloApi } from './kilo-api-fixture';
import {
  launchExtensionContext,
  seedExtensionAuth,
  startFixtureServer,
} from './extension-context-fixture';
import { REMOTE_MCP_STORAGE_KEY } from '../../src/shared/remote-mcp-storage';

type StreamableTransportOptions = ConstructorParameters<typeof StreamableHTTPServerTransport>[0];

/*
 * In-test Streamable HTTP MCP server. This runs in the Node test process (not
 * the browser bundle), so importing the SDK server transport is fine. It exposes
 * one valid object-schema tool (McpServer always emits a type:object schema) that
 * maps to a gateway tool.
 *
 * Note on the non-object-schema case: the SDK client's ToolSchema requires
 * inputSchema.type === 'object', so a tool advertising a non-object inputSchema
 * makes the SDK's listTools reject the WHOLE response (not just that tool). The
 * "non_object_schema" skip branch in remote-mcp-tools.ts is therefore unreachable
 * via this client path and is covered by the unit tests in
 * src/shared/remote-mcp-tools.test.ts instead.
 */
const startMcpFixtureServer = async (
  options: {
    readonly requiredBearerToken?: string;
    readonly requiredHeader?: { readonly name: string; readonly value: string };
  } = {}
): Promise<{ close: () => Promise<void>; url: string }> => {
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

  const httpServer = createServer((request, response) => {
    void (async (): Promise<void> => {
      /*
       * Reject requests missing the expected auth header so a successful turn
       * proves the extension forwarded the credential over the plain fetch. Node
       * lowercases header names, so match the custom header case-insensitively.
       */
      const bearerMismatch =
        options.requiredBearerToken !== undefined &&
        request.headers.authorization !== `Bearer ${options.requiredBearerToken}`;
      const headerMismatch =
        options.requiredHeader !== undefined &&
        request.headers[options.requiredHeader.name.toLowerCase()] !== options.requiredHeader.value;

      if (bearerMismatch || headerMismatch) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      const chunks: string[] = [];

      for await (const chunk of request) {
        chunks.push(String(chunk));
      }

      const raw = chunks.join('');
      const body: unknown = raw === '' ? undefined : JSON.parse(raw);

      /*
       * Stateless mode: a fresh server + transport per request. The SDK option
       * and Transport types omit undefined under exactOptionalPropertyTypes, so
       * widen through unknown; sessionIdGenerator: undefined is the documented
       * stateless signal.
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
    throw new Error('MCP fixture server did not start on a TCP port.');
  }

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close(error => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
    url: `http://127.0.0.1:${address.port}/mcp`,
  };
};

// Serialize the stored remote MCP servers (or "null") so callers can substring-match.
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
    ['get_page_snapshot', 'get_element_details', 'find_in_page', MAPPED_TOOL_NAME],
    ['get_page_snapshot', 'get_element_details', 'find_in_page', MAPPED_TOOL_NAME],
  ],
};

/*
 * Add the "Fixture MCP" server (optionally configuring auth), enable it in safe
 * mode, then send a message and assert the mapped MCP tool ran with the
 * fixture's JSON result. Leaves the server in place for the caller.
 */
const addConnectEnableAndRunTurn = async (
  sidePanel: Page,
  { configureAuth, url }: { configureAuth?: (page: Page) => Promise<void>; url: string }
): Promise<void> => {
  await sidePanel.getByRole('button', { name: 'Settings' }).click();
  await sidePanel.getByRole('button', { name: 'Add server' }).click();
  await sidePanel.getByLabel('Name').fill('Fixture MCP');
  await sidePanel.getByLabel('URL').fill(url);
  if (configureAuth !== undefined) {
    await configureAuth(sidePanel);
  }
  await sidePanel.getByRole('button', { name: 'Save' }).click();

  /*
   * Save connects (tests) the server automatically: the tool is cached and the
   * connect control becomes "Refresh" with no manual Connect click.
   */
  await expect(sidePanel.getByText('Fixture MCP')).toBeVisible();
  await expect(sidePanel.getByRole('button', { name: 'Refresh' })).toBeVisible();
  await expect(sidePanel.getByText('1 tool')).toBeVisible();

  // Edit the server to allow it in safe mode (it is enabled by default).
  await sidePanel.getByRole('button', { name: 'Edit Fixture MCP' }).click();
  const allowInSafeMode = sidePanel.getByLabel('Allow in safe mode');
  await expect(allowInSafeMode).not.toBeChecked();
  await allowInSafeMode.check();
  await expect(sidePanel.getByLabel('Enabled')).toBeChecked();
  await sidePanel.getByRole('button', { name: 'Save' }).click();

  // The saved server re-connects; wait for it before closing settings.
  await expect(sidePanel.getByRole('button', { name: 'Refresh' })).toBeVisible();
  await expect(sidePanel.getByText('1 tool')).toBeVisible();

  /*
   * Close settings and send immediately — no reload. Settings and the chat panel
   * share the jotai remote-MCP atom, so the newly enabled server is visible to
   * the turn without a reload.
   */
  await sidePanel.getByRole('button', { name: 'Close settings' }).click();

  // Send a message that triggers the MCP tool call.
  await sidePanel.getByLabel('Message agent').fill('What is the weather in Skopje?');
  await sidePanel.getByLabel('Message agent').press('Enter');

  // The mapped tool-call row appears; expand it and verify the plain JSON result.
  const toolRow = sidePanel
    .getByText(`${MAPPED_TOOL_NAME} completed`)
    .locator('xpath=ancestor::details[1]');
  await expect(toolRow).toBeVisible();
  await toolRow.getByText(`${MAPPED_TOOL_NAME} completed`).click();
  /*
   * Arguments render as pretty JSON; the MCP result renders as the raw text
   * envelope (the inner JSON arrives as an escaped string in the text part).
   */
  await expect(toolRow.getByText('"city": "Skopje"')).toBeVisible();
  await expect(toolRow.getByText('"type": "text"')).toBeVisible();
  await expect(toolRow.getByText(String.raw`{\"city\":\"Skopje\",\"tempC\":21}`)).toBeVisible();
  await expect(sidePanel.getByText('The weather in Skopje is 21C.')).toBeVisible();
};

const openSidePanel = async (context: BrowserContext, extensionId: string): Promise<Page> => {
  const sidePanel = await context.newPage();
  await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await seedExtensionAuth(sidePanel);
  await sidePanel.reload();
  return sidePanel;
};

test('remote MCP server can be added, connected, used in a turn, and removed', async () => {
  const fixture = await startFixtureServer();
  const mcp = await startMcpFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, turnMockConfig);

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await openSidePanel(context, extensionId);
    await addConnectEnableAndRunTurn(sidePanel, { url: mcp.url });

    // Remove the server (no undo) and confirm it leaves storage.
    await sidePanel.getByRole('button', { name: 'Settings' }).click();
    await sidePanel.getByRole('button', { name: 'Remove Fixture MCP' }).click();

    await expect
      .poll(async () => {
        const storedJson = await readStoredServersJson(sidePanel);
        return storedJson.includes('Fixture MCP');
      })
      .toBe(false);
  } finally {
    await context.close();
    await mcp.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('remote MCP server authenticates with a bearer token and runs a turn', async () => {
  const bearerToken = 'fixture-secret-token';
  const fixture = await startFixtureServer();
  // The fixture 401s every request that lacks this exact bearer header.
  const mcp = await startMcpFixtureServer({ requiredBearerToken: bearerToken });
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, turnMockConfig);

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await openSidePanel(context, extensionId);
    await addConnectEnableAndRunTurn(sidePanel, {
      configureAuth: async form => {
        await form.getByLabel('Auth').selectOption('bearer');
        await form.getByLabel('Bearer token').fill(bearerToken);
      },
      url: mcp.url,
    });
  } finally {
    await context.close();
    await mcp.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('remote MCP server authenticates with a custom header and runs a turn', async () => {
  const headerName = 'X-Fixture-Key';
  const headerValue = 'fixture-secret-header';
  const fixture = await startFixtureServer();
  // The fixture 401s every request that lacks this exact custom header.
  const mcp = await startMcpFixtureServer({
    requiredHeader: { name: headerName, value: headerValue },
  });
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, turnMockConfig);

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await openSidePanel(context, extensionId);
    await addConnectEnableAndRunTurn(sidePanel, {
      configureAuth: async form => {
        await form.getByLabel('Auth').selectOption('header');
        await form.getByLabel('Header name').fill(headerName);
        await form.getByLabel('Header value').fill(headerValue);
      },
      url: mcp.url,
    });
  } finally {
    await context.close();
    await mcp.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
