/* eslint-disable import/no-nodejs-modules, max-lines */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { dangerousToolNames, mockKiloApi, safeToolNames } from './kilo-api-fixture';
import {
  launchExtensionContext,
  seedExtensionAuth,
  setExtensionStorage,
  startFixtureServer,
} from './extension-context-fixture';

const WEB_MCP_SETTINGS_STORAGE_KEY = 'kiloWebMcpSettings';

const webMcpPageHtml = `
<script>
  (async () => {
    const modelContext = document.modelContext;
    if (!modelContext || typeof modelContext.registerTool !== 'function') return;
    await modelContext.registerTool({
      name: 'double',
      title: 'Double',
      description: 'Doubles a number.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
      },
      execute: async ({ value }) => ({ doubled: value * 2 }),
    });
  })();
</script>
`;

const doubleParameters = {
  properties: { value: { type: 'number' } },
  required: ['value'],
  type: 'object',
};

type WebMcpDocument = Document & {
  modelContext?: {
    getTools?: () => Promise<unknown>;
    registerTool?: (tool: unknown) => Promise<unknown>;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const detectWebMcpApi = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const { modelContext } = document as WebMcpDocument;

    return (
      typeof modelContext === 'object' &&
      modelContext !== null &&
      typeof modelContext.registerTool === 'function'
    );
  });

const waitForRegisteredTool = async (page: Page): Promise<void> => {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const { modelContext } = document as WebMcpDocument;

          if (modelContext === undefined || typeof modelContext.getTools !== 'function') {
            return 0;
          }

          const tools = await modelContext.getTools();

          return Array.isArray(tools) ? tools.length : 0;
        }),
      { timeout: 5000 }
    )
    .toBeGreaterThan(0);
};

const getGatewayTools = (body: unknown): Record<string, unknown>[] => {
  if (!isRecord(body) || !Array.isArray(body['tools'])) {
    return [];
  }

  return body['tools'].filter(isRecord);
};

const getGatewayToolMessages = (body: unknown): Record<string, unknown>[] => {
  if (!isRecord(body) || !Array.isArray(body['messages'])) {
    return [];
  }

  return body['messages'].filter(
    (message): message is Record<string, unknown> => isRecord(message) && message['role'] === 'tool'
  );
};

const getGatewayToolNames = (body: unknown): string[] =>
  getGatewayTools(body).map(tool => {
    const fn = tool['function'];

    return isRecord(fn) && typeof fn['name'] === 'string' ? fn['name'] : '';
  });

const findGatewayTool = (body: unknown, name: string): Record<string, unknown> | undefined =>
  getGatewayTools(body).find(tool => {
    const fn = tool['function'];

    return isRecord(fn) && fn['name'] === name;
  });

const getToolResultValue = (body: unknown): unknown => {
  const content = getGatewayToolMessages(body)[0]?.['content'];

  if (typeof content !== 'string') {
    return undefined;
  }

  return JSON.parse(content) as unknown;
};

const getToolDescription = (tool: Record<string, unknown> | undefined): unknown => {
  const fn = tool?.['function'];

  return isRecord(fn) ? fn['description'] : undefined;
};

test('safe mode omits the page double tool when WebMCP in safe mode is off', async () => {
  const fixture = await startFixtureServer({ bodyHtml: webMcpPageHtml });
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    const seenChatBodies: unknown[] = [];
    await mockKiloApi(context, {
      firstCompletionEvents: [{ choices: [{ delta: { content: 'I will read the page.' } }] }],
      seenChatBodies,
      toolNames: safeToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await sidePanel.getByLabel('Message agent').fill('What tools are available?');
    await sidePanel.getByLabel('Message agent').press('Enter');

    await expect(sidePanel.getByText('I will read the page.')).toBeVisible();
    expect(getGatewayToolNames(seenChatBodies[0])).not.toContain('double');
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('safe mode exposes and executes the page double tool when WebMCP in safe mode is on', async () => {
  const fixture = await startFixtureServer({ bodyHtml: webMcpPageHtml });
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    const page = await context.newPage();
    await page.goto(fixture.url);
    const hasWebMcp = await detectWebMcpApi(page);
    test.skip(!hasWebMcp, 'WebMCP API is not available in this browser');
    await waitForRegisteredTool(page);

    const seenChatBodies: unknown[] = [];
    await mockKiloApi(context, {
      firstCompletionEvents: [
        { choices: [{ delta: { content: 'I will double the number.' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    function: {
                      arguments: JSON.stringify({ value: 21 }),
                      name: 'double',
                    },
                    id: 'call_double_1',
                    index: 0,
                    type: 'function',
                  },
                ],
              },
            },
          ],
        },
      ],
      secondCompletionEvents: [{ choices: [{ delta: { content: 'The doubled value is 42.' } }] }],
      seenChatBodies,
      toolNames: [...safeToolNames, 'double'],
    });

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await setExtensionStorage(sidePanel, {
      [WEB_MCP_SETTINGS_STORAGE_KEY]: { allowWebMcpInSafeMode: true },
    });
    await sidePanel.reload();

    await sidePanel.getByLabel('Message agent').fill('Double 21.');
    await sidePanel.getByLabel('Message agent').press('Enter');

    // The page executed the tool and the panel shows the completed exchange.
    await expect(sidePanel.getByText('double completed')).toBeVisible();
    await expect(sidePanel.getByText('The doubled value is 42.')).toBeVisible();

    // The first request carries the double definition with name, title/description, and schema.
    const doubleTool = findGatewayTool(seenChatBodies[0], 'double');
    expect(doubleTool).toBeDefined();
    expect(doubleTool).toMatchObject({
      function: {
        name: 'double',
        parameters: doubleParameters,
      },
      type: 'function',
    });
    // Chrome may omit the tool title; assert on the description text alone.
    const description = getToolDescription(doubleTool);
    expect(typeof description).toBe('string');
    expect(String(description)).toContain('Doubles a number.');

    // The next request carries the structured tool result.
    expect(getGatewayToolMessages(seenChatBodies[1])).toHaveLength(1);
    expect(getToolResultValue(seenChatBodies[1])).toMatchObject({
      ok: true,
      value: { doubled: 42 },
    });
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('dangerous mode sends the page double tool while the setting stays off', async () => {
  const fixture = await startFixtureServer({ bodyHtml: webMcpPageHtml });
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    const page = await context.newPage();
    await page.goto(fixture.url);
    const hasWebMcp = await detectWebMcpApi(page);
    test.skip(!hasWebMcp, 'WebMCP API is not available in this browser');
    await waitForRegisteredTool(page);

    const seenChatBodies: unknown[] = [];
    await mockKiloApi(context, {
      firstCompletionEvents: [{ choices: [{ delta: { content: 'I will read the page.' } }] }],
      seenChatBodies,
      toolNames: [...dangerousToolNames, 'double'],
    });

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await sidePanel.getByRole('button', { name: /Safe mode/u }).click();
    await sidePanel.getByRole('button', { name: 'Dangerous' }).click();
    await sidePanel.getByLabel('Message agent').fill('What tools are available?');
    await sidePanel.getByLabel('Message agent').press('Enter');

    await expect(sidePanel.getByText('I will read the page.')).toBeVisible();
    expect(getGatewayToolNames(seenChatBodies[0])).toContain('double');
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
