/* eslint-disable import/no-nodejs-modules */
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { dangerousToolNames, mockKiloApi } from './kilo-api-fixture';
import {
  launchExtensionContext,
  seedExtensionAuth,
  setExtensionStorage,
  startFixtureServer,
} from './extension-context-fixture';

/*
 * A caller's element refs outlive its turn, like Playwright page handles: the
 * tab lease is released when a turn ends, but the refs that turn snapshotted
 * stay resolvable for the caller until a navigation, a tab dispose, or the
 * caller's own disposal. This is the end-to-end proof: conversation A
 * snapshots and its turn ends, conversation B runs a workflow on the same tab,
 * and A's next turn clicks by the earlier ref with no second attachment and no
 * stale-ref error.
 */

const AGENT_WORKFLOWS_KEY = 'kiloAgentWorkflows';
const WORKFLOW_SETTINGS_KEY = 'kiloWorkflowSettings';
const changedHeading = 'Changed by click';

const fixtureBodyHtml = [
  '<h2 id="state">Initial fixture state</h2>',
  `<button id="change" type="button" onclick="document.getElementById('state').textContent = '${changedHeading}'">Change fixture state</button>`,
].join('');

// A workflow reads the page through the same tab session the browser tools use.
const WORKFLOW_SCRIPT = `
  const heading = await page.text('h1');
  return { done: true, result: { heading } };
`;

const toolCallEvents = (id: string, name: string, args: Record<string, unknown>): unknown[] => [
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              function: { arguments: JSON.stringify(args), name },
              id,
              index: 0,
              type: 'function',
            },
          ],
        },
      },
    ],
  },
];

const contentEvents = (text: string): unknown[] => [{ choices: [{ delta: { content: text } }] }];

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

test('a ref snapped before a turn and another caller still clicks after both turns', async () => {
  const fixture = await startFixtureServer({ bodyHtml: fixtureBodyHtml, title: 'Ref lifetime' });
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    // One entry per gateway call: A's snapshot turn, then A's click turn.
    // The click entry is filled in once A's snapshot reveals the ref.
    const completionEventsByCall: unknown[][] = [];

    await mockKiloApi(context, { completionEventsByCall, toolNames: dangerousToolNames });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await openAuthedSidePanel(context, extensionId);
    await switchToDangerMode(sidePanel);

    // Conversation A: snapshot, then the turn ends and releases its lease.
    completionEventsByCall[0] = toolCallEvents('call_snapshot_1', 'kilo_browser_snapshot', {});
    completionEventsByCall[1] = contentEvents('Snapshot taken.');

    await sendMessage(sidePanel, 'Take a snapshot.');
    await expect(toolPanel(sidePanel, 'Page snapshot', 'completed')).toBeVisible();
    await expect(sidePanel.getByText('Snapshot taken.')).toBeVisible();

    const snapshotText = await toolPanel(sidePanel, 'Page snapshot', 'completed').evaluate(
      element => element.outerHTML
    );
    const refs = [...snapshotText.matchAll(/\[ref=(e\d+)\]/gu)].map(match => match[1]);

    // The fixture's only interactive node is the button, so its ref is the one to click.
    expect(refs).toHaveLength(1);
    const [ref = ''] = refs;

    // Seed a workflow scoped to this fixture so B can run it on the same tab.
    const script = WORKFLOW_SCRIPT;
    await setExtensionStorage(sidePanel, {
      [AGENT_WORKFLOWS_KEY]: [
        {
          approvedScriptHash: createHash('sha256').update(script).digest('hex'),
          createdAt: Date.now() - 60_000,
          description: 'Read the heading through the shared tab session.',
          id: crypto.randomUUID(),
          name: 'Inspect page',
          scopeOrigin: new URL(fixture.url).origin,
          script,
          updatedAt: Date.now() - 60_000,
        },
      ],
      [WORKFLOW_SETTINGS_KEY]: {
        allowWorkflowsInSafeMode: false,
        autoApproveWorkflowChanges: false,
        autoApproveWorkflowRuns: false,
      },
    });

    // Conversation B: a workflow run on the same tab, with a caller and a lease of its own.
    await sidePanel.getByLabel('New conversation').click();
    await sidePanel.getByLabel('Settings').click();

    const workflowRegion = sidePanel.getByRole('region', { name: 'Workflows' });

    await expect(workflowRegion).toBeVisible();
    await workflowRegion.getByRole('button', { name: 'Run workflow "Inspect page"' }).click();
    await expect(sidePanel.getByText('run_workflow completed')).toBeVisible();
    await sidePanel.getByLabel('Close settings').click();

    // Conversation A's next turn: click by the ref its earlier turn snapshotted.
    completionEventsByCall[2] = toolCallEvents('call_click_1', 'kilo_browser_click', {
      target: ref,
    });
    completionEventsByCall[3] = contentEvents('Clicked by the earlier ref.');

    await sidePanel.getByRole('tab', { name: /Take a snapshot/u }).click();
    await sendMessage(sidePanel, 'Click the button.');

    await expect(toolPanel(sidePanel, 'Click', 'completed')).toBeVisible();
    await expect(sidePanel.getByText('Clicked by the earlier ref.')).toBeVisible();

    // The click really landed, and the shared attachment never re-attached.
    await expect(page.locator('#state')).toHaveText(changedHeading);
    await expect(sidePanel.getByText(/already attached/iu)).toHaveCount(0);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
