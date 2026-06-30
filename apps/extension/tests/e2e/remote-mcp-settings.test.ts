/* eslint-disable import/no-nodejs-modules, promise/avoid-new, promise/prefer-await-to-callbacks */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
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
const startMcpFixtureServer = async (): Promise<{ close: () => Promise<void>; url: string }> => {
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

test('remote MCP server can be added, connected, used in a turn, and removed', async () => {
  const fixture = await startFixtureServer();
  const mcp = await startMcpFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  // Display name "Fixture MCP" -> slug "fixture-mcp" -> gateway tool name below.
  const mappedToolName = 'mcp_fixture-mcp_get_weather';

  try {
    await mockKiloApi(context, {
      firstCompletionEvents: [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    function: {
                      arguments: JSON.stringify({ city: 'Skopje' }),
                      name: mappedToolName,
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
      secondCompletionEvents: [
        { choices: [{ delta: { content: 'The weather in Skopje is 21C.' } }] },
      ],
      // Both turns offer the safe tools plus the mapped MCP tool.
      toolNamesByCall: [
        ['get_page_snapshot', 'get_element_details', 'find_in_page', mappedToolName],
        ['get_page_snapshot', 'get_element_details', 'find_in_page', mappedToolName],
      ],
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    // Open Settings and add a server.
    await sidePanel.getByRole('button', { name: 'Settings' }).click();
    await sidePanel.getByRole('button', { name: 'Add server' }).click();
    await sidePanel.getByLabel('Name').fill('Fixture MCP');
    await sidePanel.getByLabel('URL').fill(mcp.url);
    // Auth type defaults to "None"; leave it.
    await sidePanel.getByRole('button', { name: 'Save' }).click();

    // The saved row shows the name; connect to discover tools.
    await expect(sidePanel.getByText('Fixture MCP')).toBeVisible();
    await sidePanel.getByRole('button', { name: 'Connect' }).click();

    // Connected: the discovered tool is cached and the connect control becomes
    // "Refresh".
    await expect(sidePanel.getByRole('button', { name: 'Refresh' })).toBeVisible();
    await expect(sidePanel.getByText('1 tool')).toBeVisible();

    // Edit the server to enable it and allow it in safe mode.
    await sidePanel.getByRole('button', { name: 'Edit Fixture MCP' }).click();
    const allowInSafeMode = sidePanel.getByLabel('Allow in safe mode');
    await expect(allowInSafeMode).not.toBeChecked();
    await allowInSafeMode.check();
    await expect(sidePanel.getByLabel('Enabled')).toBeChecked();
    await sidePanel.getByRole('button', { name: 'Save' }).click();

    /*
     * Close settings. The chat panel reads remote MCP servers once on mount and
     * refreshes the enabled ones, so reload to pick up the newly enabled server.
     */
    await sidePanel.getByRole('button', { name: 'Close settings' }).click();
    await sidePanel.reload();

    /*
     * Wait for the post-reload background refresh to reconnect and re-cache the
     * tool before sending — otherwise the turn would omit the MCP tool.
     */
    await sidePanel.getByRole('button', { name: 'Settings' }).click();
    await expect(sidePanel.getByRole('button', { name: 'Refresh' })).toBeVisible();
    await expect(sidePanel.getByText('1 tool')).toBeVisible();
    await sidePanel.getByRole('button', { name: 'Close settings' }).click();

    // Send a message that triggers the MCP tool call.
    await sidePanel.getByLabel('Message agent').fill('What is the weather in Skopje?');
    await sidePanel.getByLabel('Message agent').press('Enter');

    // The mapped tool-call row appears; expand it and verify the plain JSON result.
    const toolRow = sidePanel
      .getByText(`${mappedToolName} completed`)
      .locator('xpath=ancestor::details[1]');
    await expect(toolRow).toBeVisible();
    await toolRow.getByText(`${mappedToolName} completed`).click();
    /*
     * Arguments render as pretty JSON; the MCP result renders as the raw text
     * envelope (the inner JSON arrives as an escaped string in the text part).
     */
    await expect(toolRow.getByText('"city": "Skopje"')).toBeVisible();
    await expect(toolRow.getByText('"type": "text"')).toBeVisible();
    await expect(toolRow.getByText(String.raw`{\"city\":\"Skopje\",\"tempC\":21}`)).toBeVisible();
    await expect(sidePanel.getByText('The weather in Skopje is 21C.')).toBeVisible();

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
