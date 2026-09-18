/* eslint-disable import/no-nodejs-modules, max-lines */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import {
  BROWSER_TOOL_CONTRACT,
  KILO_BROWSER_TOOL_PREFIX,
} from '../../src/shared/browser-tool-contract';
import {
  dangerousToolNames,
  expectedToolNamesForMode,
  mockKiloApi,
  safeToolNames,
} from './kilo-api-fixture';
import type { ExtensionAgentMode } from './kilo-api-fixture';
import {
  launchExtensionContext,
  seedExtensionAuth,
  startFixtureServer,
} from './extension-context-fixture';

/*
 * The end-to-end proof for the exposure request: with the extension running,
 * the gateway request lists the `kilo_` tools against the vendored Playwright
 * MCP contract (same set, same order, only the prefix renamed), and one
 * read-only and one state-changing call run or refuse per mode.
 */

const fixtureTitle = 'Browser tools fixture';
const secondPath = '/second';
const changedHeading = 'Changed by click';
const fixtureBodyHtml = [
  '<h2 id="state">Initial fixture state</h2>',
  `<button id="change" type="button" onclick="document.getElementById('state').textContent = '${changedHeading}'">Change fixture state</button>`,
].join('');
const secondPageHtml =
  '<!doctype html><html><head><title>Second fixture page</title></head><body><main><h1>Second fixture page</h1></main></body></html>';

const launchFixturePage = async (): Promise<{
  context: BrowserContext;
  extensionId: string;
  fixture: Awaited<ReturnType<typeof startFixtureServer>>;
  page: Page;
  userDataDir: string;
}> => {
  const fixture = await startFixtureServer({
    bodyHtml: fixtureBodyHtml,
    pathHtml: { [secondPath]: secondPageHtml },
    title: fixtureTitle,
  });
  const { context, extensionId, userDataDir } = await launchExtensionContext();
  const page = await context.newPage();
  await page.goto(fixture.url);

  return { context, extensionId, fixture, page, userDataDir };
};

const openAuthedSidePanel = async (context: BrowserContext, extensionId: string): Promise<Page> => {
  const sidePanel = await context.newPage();
  await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await seedExtensionAuth(sidePanel);
  await sidePanel.reload();

  return sidePanel;
};

const sendMessage = async (sidePanel: Page, text: string): Promise<void> => {
  await sidePanel.getByLabel('Message agent').fill(text);
  await sidePanel.getByLabel('Message agent').press('Enter');
};

const switchToDangerMode = async (sidePanel: Page): Promise<void> => {
  await sidePanel.getByRole('button', { name: /Safe mode/u }).click();
  await sidePanel.getByRole('button', { name: 'Dangerous' }).click();
};

const toolPanel = (sidePanel: Page, title: string, status: 'completed' | 'failed') =>
  sidePanel.getByText(`${title} ${status}`).locator('xpath=ancestor::details[1]');

const listingRequestSchema = z.object({
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })),
});

const toPlaywrightName = (kiloName: string): string =>
  `playwright_${kiloName.slice(KILO_BROWSER_TOOL_PREFIX.length)}`;

/**
 * Shows the exposed `kilo_` browser tools against their `playwright_`
 * counterparts: the request carries exactly the mode's expected list, and the
 * browser entries are the upstream read-only (safe) or full (danger) contract
 * with only the prefix renamed.
 */
const expectToolListing = (bodies: readonly unknown[], mode: ExtensionAgentMode): void => {
  const parsed = listingRequestSchema.safeParse(bodies[0]);

  expect(parsed.success).toBe(true);

  if (!parsed.success) {
    return;
  }

  const names = parsed.data.tools.map(tool => tool.function.name);
  const upstreamEntries = BROWSER_TOOL_CONTRACT.filter(
    entry => mode === 'dangerous' || entry.readOnly
  );
  const expectedKiloBrowserNames = upstreamEntries.map(
    entry => `${KILO_BROWSER_TOOL_PREFIX}${entry.name}`
  );

  expect(names).toStrictEqual(expectedToolNamesForMode(mode));
  expect(expectedKiloBrowserNames).toHaveLength(mode === 'dangerous' ? 26 : 8);

  const kiloNames = names.filter(name => name.startsWith(`${KILO_BROWSER_TOOL_PREFIX}browser_`));
  expect(kiloNames).toStrictEqual(expectedKiloBrowserNames);
  expect(kiloNames.map(name => toPlaywrightName(name))).toStrictEqual(
    upstreamEntries.map(entry => `playwright_${entry.name}`)
  );
};

test('safe mode lists the read-only kilo_ browser tools against their playwright_ counterparts', async () => {
  const { context, extensionId, fixture, page, userDataDir } = await launchFixturePage();

  try {
    const seenChatBodies: unknown[] = [];
    await mockKiloApi(context, {
      firstCompletionEvents: [{ choices: [{ delta: { content: 'No tool needed.' } }] }],
      seenChatBodies,
      toolNames: safeToolNames,
    });

    const sidePanel = await openAuthedSidePanel(context, extensionId);
    await expect(sidePanel.getByRole('button', { name: /Safe mode/u })).toBeVisible();
    await expect(sidePanel.getByLabel('Target tab')).toContainText(fixtureTitle);

    await sendMessage(sidePanel, 'Which tools do you have?');
    await expect(sidePanel.getByText('No tool needed.')).toBeVisible();

    expectToolListing(seenChatBodies, 'safe');
    await expect(page).toHaveTitle(fixtureTitle);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('danger mode lists all 26 kilo_browser_ tools against their playwright_ counterparts', async () => {
  const { context, extensionId, fixture, page, userDataDir } = await launchFixturePage();

  try {
    const seenChatBodies: unknown[] = [];
    await mockKiloApi(context, {
      firstCompletionEvents: [{ choices: [{ delta: { content: 'No tool needed.' } }] }],
      seenChatBodies,
      toolNames: dangerousToolNames,
    });

    const sidePanel = await openAuthedSidePanel(context, extensionId);
    await switchToDangerMode(sidePanel);

    await sendMessage(sidePanel, 'Which tools do you have now?');
    await expect(sidePanel.getByText('No tool needed.')).toBeVisible();

    expectToolListing(seenChatBodies, 'dangerous');
    await expect(page).toHaveTitle(fixtureTitle);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('safe mode read-only kilo_browser_snapshot shows the page snapshot', async () => {
  const { context, extensionId, fixture, page, userDataDir } = await launchFixturePage();

  try {
    await mockKiloApi(context, {
      firstCompletionEvents: [
        { choices: [{ delta: { content: 'I will take a snapshot.' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    function: {
                      arguments: JSON.stringify({}),
                      name: 'kilo_browser_snapshot',
                    },
                    id: 'call_snapshot_1',
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
        {
          choices: [{ delta: { content: 'The snapshot shows the fixture heading.' } }],
        },
      ],
      toolNames: safeToolNames,
    });

    const sidePanel = await openAuthedSidePanel(context, extensionId);
    await expect(sidePanel.getByRole('button', { name: /Safe mode/u })).toBeVisible();
    await expect(sidePanel.getByLabel('Target tab')).toContainText(fixtureTitle);

    await sendMessage(sidePanel, 'Take a snapshot of this page.');

    const panel = toolPanel(sidePanel, 'Page snapshot', 'completed');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(/heading "Browser tools fixture"/u);
    await expect(sidePanel.getByText('The snapshot shows the fixture heading.')).toBeVisible();

    // The read-only call never changes the page.
    await expect(page.locator('#state')).toHaveText('Initial fixture state');
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('safe mode refuses the state-changing kilo_browser_click and leaves the page unchanged', async () => {
  const { context, extensionId, fixture, page, userDataDir } = await launchFixturePage();

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
                      arguments: JSON.stringify({ target: '#change' }),
                      name: 'kilo_browser_click',
                    },
                    id: 'call_click_1',
                    index: 0,
                    type: 'function',
                  },
                ],
              },
            },
          ],
        },
      ],
      secondCompletionEvents: [{ choices: [{ delta: { content: 'The click was refused.' } }] }],
      toolNames: safeToolNames,
    });

    const sidePanel = await openAuthedSidePanel(context, extensionId);
    await expect(sidePanel.getByRole('button', { name: /Safe mode/u })).toBeVisible();
    await expect(sidePanel.getByLabel('Target tab')).toContainText(fixtureTitle);

    await sendMessage(sidePanel, 'Click the button.');

    const panel = toolPanel(sidePanel, 'Click', 'failed');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(/kilo_browser_click is not read-only/u);
    await expect(sidePanel.getByText('The click was refused.')).toBeVisible();

    // The refusal is real: the page never received the click.
    await expect(page.locator('#state')).toHaveText('Initial fixture state');
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('danger mode completes kilo_browser_click and a second snapshot shows the changed page', async () => {
  const { context, extensionId, fixture, page, userDataDir } = await launchFixturePage();

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
                      arguments: JSON.stringify({ target: '#change' }),
                      name: 'kilo_browser_click',
                    },
                    id: 'call_click_1',
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
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    function: {
                      arguments: JSON.stringify({}),
                      name: 'kilo_browser_snapshot',
                    },
                    id: 'call_snapshot_1',
                    index: 0,
                    type: 'function',
                  },
                ],
              },
            },
          ],
        },
      ],
      thirdCompletionEvents: [
        { choices: [{ delta: { content: 'The page changed after the click.' } }] },
      ],
      toolNames: dangerousToolNames,
    });

    const sidePanel = await openAuthedSidePanel(context, extensionId);
    await switchToDangerMode(sidePanel);

    await sendMessage(sidePanel, 'Click the button and show me the result.');

    await expect(toolPanel(sidePanel, 'Click', 'completed')).toBeVisible();

    const panel = toolPanel(sidePanel, 'Page snapshot', 'completed');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(new RegExp(`heading "${changedHeading}"`, 'u'));
    await expect(sidePanel.getByText('The page changed after the click.')).toBeVisible();
    await expect(page.locator('#state')).toHaveText(changedHeading);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('danger mode kilo_browser_navigate returns the new URL', async () => {
  const { context, extensionId, fixture, page, userDataDir } = await launchFixturePage();

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
                      arguments: JSON.stringify({ url: `${fixture.url}${secondPath}` }),
                      name: 'kilo_browser_navigate',
                    },
                    id: 'call_navigate_1',
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
        { choices: [{ delta: { content: 'I navigated to the second page.' } }] },
      ],
      toolNames: dangerousToolNames,
    });

    const sidePanel = await openAuthedSidePanel(context, extensionId);
    await switchToDangerMode(sidePanel);

    await sendMessage(sidePanel, 'Open the second page.');

    const panel = toolPanel(sidePanel, 'Navigate to a URL', 'completed');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(`${fixture.url}${secondPath}`);
    await expect(sidePanel.getByText('I navigated to the second page.')).toBeVisible();
    await expect.poll(() => page.url()).toContain(secondPath);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('a snapshot of an uninspectable tab reports the error and the next snapshot succeeds', async () => {
  const { context, extensionId, fixture, page, userDataDir } = await launchFixturePage();

  try {
    await mockKiloApi(context, {
      // Message 1 navigates the captured tab to about:blank before the model answers; the extension only debugs http(s)/file documents (isInspectablePageUrl), so this snapshot fails as uninspectable. Message 2 runs after the fixture tab is restored and succeeds.
      beforeFirstCompletion: async () => {
        await page.goto('about:blank');
      },
      completionEventsByCall: [
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      function: {
                        arguments: JSON.stringify({}),
                        name: 'kilo_browser_snapshot',
                      },
                      id: 'call_snapshot_1',
                      index: 0,
                      type: 'function',
                    },
                  ],
                },
              },
            ],
          },
        ],
        [{ choices: [{ delta: { content: 'The tab could not be inspected.' } }] }],
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      function: {
                        arguments: JSON.stringify({}),
                        name: 'kilo_browser_snapshot',
                      },
                      id: 'call_snapshot_2',
                      index: 0,
                      type: 'function',
                    },
                  ],
                },
              },
            ],
          },
        ],
        [{ choices: [{ delta: { content: 'The page is readable again.' } }] }],
      ],
      toolNames: safeToolNames,
    });

    const sidePanel = await openAuthedSidePanel(context, extensionId);
    await expect(sidePanel.getByRole('button', { name: /Safe mode/u })).toBeVisible();
    await expect(sidePanel.getByLabel('Target tab')).toContainText(fixtureTitle);

    await sendMessage(sidePanel, 'Take a snapshot of this page.');

    const failed = toolPanel(sidePanel, 'Page snapshot', 'failed');
    await expect(failed).toBeVisible();
    await expect(failed).toContainText(/not inspectable|cannot be inspected/iu);
    await expect(sidePanel.getByText('The tab could not be inspected.')).toBeVisible();

    // Restore the fixture tab; the run keeps its captured tab id, so the next call inspects it.
    await page.goto(fixture.url);
    await page.bringToFront();
    await expect(sidePanel.getByLabel('Target tab')).toContainText(fixtureTitle);

    await sendMessage(sidePanel, 'Now snapshot the fixture page.');

    const completed = toolPanel(sidePanel, 'Page snapshot', 'completed');
    await expect(completed).toBeVisible();
    await expect(completed).toContainText(/heading "Browser tools fixture"/u);
    await expect(sidePanel.getByText('The page is readable again.')).toBeVisible();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
