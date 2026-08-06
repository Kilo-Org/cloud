/* eslint-disable id-length, import/no-nodejs-modules, jest/no-conditional-in-test, max-lines, typescript-eslint/no-unsafe-type-assertion */
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { dangerousToolNames, mockKiloApi, safeToolNames } from './kilo-api-fixture';
import {
  launchExtensionContext,
  readExtensionLocalStorage,
  seedExtensionAuth,
  setExtensionStorage,
  startFixtureServer,
} from './extension-context-fixture';

const AGENT_WORKFLOWS_KEY = 'kiloAgentWorkflows';
const AGENT_MEMORIES_KEY = 'kiloAgentMemories';

const SIMPLE_HEADING_SCRIPT = `
  const heading = await page.text('h1');
  return { done: true, result: { heading } };
`;

const SELECTOR_MISSING_SCRIPT = `
  await page.text('.does-not-exist');
  return { done: true, result: 'found' };
`;

const INTERACTIVE_SCRIPT = `
  await page.click('#fixture-button');
  await page.fill('#fixture-input', 'test value');
  const heading = await page.text('h1');
  return { done: true, result: { heading } };
`;

const hashScript = (script: string): string => createHash('sha256').update(script).digest('hex');

const contentOnlyCompletion = (text: string): unknown[] => [
  { choices: [{ delta: { content: text } }] },
];

const openAuthenticatedSidePanel = async (
  context: BrowserContext,
  extensionId: string
): Promise<Page> => {
  const sidePanel = await context.newPage();
  await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await seedExtensionAuth(sidePanel);
  await sidePanel.reload();
  await expect(sidePanel.getByLabel('Settings')).toBeVisible({ timeout: 15_000 });
  return sidePanel;
};

const switchToDangerousMode = async (sidePanel: Page): Promise<void> => {
  await sidePanel.getByRole('button', { name: /Safe mode/u }).click();
  await sidePanel.getByRole('button', { name: 'Dangerous' }).click();
};

const openSettings = async (sidePanel: Page): Promise<void> => {
  await sidePanel.getByLabel('Settings').click();
};

const closeSettings = async (sidePanel: Page): Promise<void> => {
  await sidePanel.getByLabel('Close settings').click();
};

/** Enable the "Allow workflows in safe mode" toggle in settings. */
const enableWorkflowsInSafeMode = async (sidePanel: Page): Promise<void> => {
  await openSettings(sidePanel);
  const toggle = sidePanel.getByRole('switch', { name: 'Allow workflows in safe mode' });
  const checked = await toggle.getAttribute('aria-checked');
  if (checked !== 'true') {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
  }
  await closeSettings(sidePanel);
};

/**
 * Seed a workflow directly into extension storage with an approved hash.
 * Returns the seeded workflow id.
 */
const seedApprovedWorkflow = async (
  sidePanel: Page,
  overrides: {
    name?: string;
    description?: string;
    scopeOrigin?: string;
    pathPrefix?: string;
    startUrl?: string;
    script?: string;
  } = {}
): Promise<string> => {
  const script = overrides.script ?? SIMPLE_HEADING_SCRIPT;
  const approvedScriptHash = hashScript(script);
  const workflow = {
    approvedScriptHash,
    createdAt: Date.now() - 60_000,
    description: overrides.description ?? 'Find and return the price.',
    id: crypto.randomUUID(),
    name: overrides.name ?? 'Get Price',
    scopeOrigin: overrides.scopeOrigin ?? 'http://127.0.0.1',
    script,
    updatedAt: Date.now() - 60_000,
    ...(overrides.pathPrefix === undefined ? {} : { pathPrefix: overrides.pathPrefix }),
    ...(overrides.startUrl === undefined ? {} : { startUrl: overrides.startUrl }),
  };
  await setExtensionStorage(sidePanel, { [AGENT_WORKFLOWS_KEY]: [workflow] });
  return workflow.id;
};

interface TestContext {
  context: Awaited<ReturnType<typeof launchExtensionContext>>;
  fixture: Awaited<ReturnType<typeof startFixtureServer>>;
}

const withTestContext = async (run: (ctx: TestContext) => Promise<void>): Promise<void> => {
  const fixture = await startFixtureServer();
  const launched = await launchExtensionContext();
  try {
    await run({ context: launched, fixture });
  } finally {
    await launched.context.close();
    await fixture.close();
    await rm(launched.userDataDir, { force: true, recursive: true });
  }
};

// ── Scenario 1: create + approve + dry run ──────────────────────────────────

test('create workflow, approve card, and dry-run', async () => {
  test.setTimeout(60_000);

  await withTestContext(async ({ context: { context, extensionId } }) => {
    const bodyWithControls =
      '<button id="fixture-button" onclick="this.textContent = \'Clicked\'">Click me</button><input id="fixture-input" placeholder="Enter text" />';
    // Serve a fixture page with interactive controls for dry-run action recording.
    const interactiveFixture = await startFixtureServer({
      bodyHtml: bodyWithControls,
      title: 'Interactive fixture',
    });
    try {
      // Container for the workflow ID discovered after the create card is approved.
      // Third completion events with a mutable payload patched after approval.
      const thirdEvents: unknown[] = [
        { choices: [{ delta: { content: 'Let me dry-run the workflow.' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    function: {
                      // Patched after approval with the actual workflowId.
                      arguments: '',
                      name: 'run_workflow',
                    },
                    id: 'call_dry_run_1',
                    index: 0,
                    type: 'function',
                  },
                ],
              },
            },
          ],
        },
      ];

      // Register mock BEFORE openAuthenticatedSidePanel so the /api/user route is available for auth validation.
      await mockKiloApi(context, {
        // Turn 1: save_workflow without workflowId — a true create.
        firstCompletionEvents: [
          { choices: [{ delta: { content: "I'll save this workflow." } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      function: {
                        arguments: JSON.stringify({
                          description: 'Click, fill, and read heading.',
                          name: 'Interactive workflow',
                          scopeOrigin: new URL(interactiveFixture.url).origin,
                          script: INTERACTIVE_SCRIPT,
                        }),
                        name: 'save_workflow',
                      },
                      id: 'call_save_wf_1',
                      index: 0,
                      type: 'function',
                    },
                  ],
                },
              },
            ],
          },
        ],
        // After approval, turn 1 ends with acknowledgment text.
        secondCompletionEvents: contentOnlyCompletion('Workflow saved.'),
        // Turn 2 (new user message): dry-run the workflow. Arguments are patched after approval.
        thirdCompletionEvents: thirdEvents,
        toolNames: dangerousToolNames,
      });

      const sidePanel = await openAuthenticatedSidePanel(context, extensionId);

      // No seed: the storage starts empty. This proves a true create.

      const page = await context.newPage();
      await page.goto(interactiveFixture.url);

      await expect(sidePanel.getByLabel('Target tab')).toContainText('Interactive fixture');

      await switchToDangerousMode(sidePanel);

      // Turn 1: save + approve.
      await sidePanel.getByLabel('Message agent').fill('Save a workflow for the interactive page');
      await sidePanel.getByLabel('Message agent').press('Enter');

      const saveCard = sidePanel.getByRole('dialog', { name: 'Save workflow' });
      await expect(saveCard).toBeVisible();
      await expect(saveCard).toHaveAttribute('aria-modal', 'true');
      await expect(saveCard.getByText('Interactive workflow')).toBeVisible();

      await saveCard.getByRole('button', { name: 'Approve and save' }).click();
      await expect(saveCard).toBeHidden();
      await expect(sidePanel.getByText('Workflow saved.')).toBeVisible();

      // Read the created record id from extension storage.
      await expect
        .poll(
          async () => {
            const workflows = (await readExtensionLocalStorage(sidePanel, AGENT_WORKFLOWS_KEY)) as
              | { id: string }[]
              | undefined;
            return workflows?.[0]?.id;
          },
          { timeout: 10_000 }
        )
        .toBeTruthy();

      const workflows = (await readExtensionLocalStorage(sidePanel, AGENT_WORKFLOWS_KEY)) as {
        id: string;
      }[];
      const createdId = workflows[0]!.id;

      // Patch the dry-run tool call to reference the actual workflow ID.
      (
        thirdEvents[1] as {
          choices: { delta: { tool_calls: { function: { arguments: string } }[] } }[];
        }
      ).choices[0]!.delta.tool_calls[0]!.function.arguments = JSON.stringify({
        dryRun: true,
        workflowId: createdId,
      });

      // Turn 2: dry-run the approved workflow.
      await sidePanel.getByLabel('Message agent').fill('Dry run the interactive workflow');
      await sidePanel.getByLabel('Message agent').press('Enter');

      // Assert the dry-run recorded actions in the tool exchange.
      await expect(sidePanel.getByText('run_workflow completed')).toBeVisible();
      const dryRunDetails = sidePanel.locator('details').filter({ hasText: 'run_workflow' });
      await dryRunDetails.locator('summary').click();
      // Dry-run records the click and fill actions without executing them.
      const dryRunText = await dryRunDetails.textContent();
      expect(dryRunText).toContain('#fixture-button');
      expect(dryRunText).toContain('#fixture-input');

      // Mutation proof: the button and input must be in their original state.
      const buttonText = await page.evaluate(
        () => document.querySelector('#fixture-button')?.textContent ?? ''
      );
      expect(buttonText).toBe('Click me');
      const inputValue = await page.evaluate(() => {
        const input = document.querySelector('#fixture-input');
        return input instanceof HTMLInputElement ? input.value : '';
      });
      expect(inputValue).toBe('');

      // The created workflow must appear in settings.
      await openSettings(sidePanel);
      const workflowRegion = sidePanel.getByRole('region', { name: 'Workflows' });
      await expect(workflowRegion).toBeVisible();
      await expect(workflowRegion.getByText('Interactive workflow')).toHaveCount(1);
      await closeSettings(sidePanel);
    } finally {
      await interactiveFixture.close();
    }
  });
});

// ── Scenario 2: run multi-page (toggle ON in safe mode) ─────────────────────

test('run multi-page workflow from list with safe-mode toggle', async () => {
  await withTestContext(async ({ context: { context, extensionId } }) => {
    // Serve distinct pages on the same origin for multi-page navigation.
    const multiFixture = await startFixtureServer({
      pathHtml: {
        '/': '<!doctype html><html><head><title>Multi fixture</title></head><body><main><h1>Page A</h1><p>First page.</p></main></body></html>',
        '/page-b':
          '<!doctype html><html><head><title>Page B</title></head><body><main><h1>Page B</h1><p>Second page.</p></main></body></html>',
      },
      title: 'Multi fixture',
    });
    try {
      const multiPageScript = `
        const heading = await page.text('h1');
        if (!state.visitedB) {
          return { navigate: '${multiFixture.url}/page-b', state: { visitedB: true, headingA: heading } };
        }
        return { done: true, result: { headingA: state.headingA, headingB: heading } };
      `;

      await mockKiloApi(context, {
        firstCompletionEvents: contentOnlyCompletion('Auto-turn: pages A and B read successfully.'),
        toolNames: [...safeToolNames, 'run_workflow'],
      });

      const pageA = await context.newPage();
      await pageA.goto(multiFixture.url);

      const sidePanel = await openAuthenticatedSidePanel(context, extensionId);

      await seedApprovedWorkflow(sidePanel, {
        description: 'Navigate both pages.',
        name: 'Multi-page nav',
        scopeOrigin: new URL(multiFixture.url).origin,
        script: multiPageScript,
      });

      await enableWorkflowsInSafeMode(sidePanel);

      await expect(sidePanel.getByLabel('Target tab')).toContainText('Multi fixture');

      // Run from the workflow list in settings.
      await openSettings(sidePanel);
      const workflowRegion = sidePanel.getByRole('region', { name: 'Workflows' });
      await expect(workflowRegion).toBeVisible();
      const runButton = workflowRegion.getByRole('button', {
        name: 'Run workflow "Multi-page nav"',
      });
      await expect(runButton).toBeEnabled();
      await runButton.click();

      // Assert the combined multi-page result in the tool exchange.
      await expect(sidePanel.getByText('run_workflow completed')).toBeVisible();
      const wfDetails = sidePanel.locator('details').filter({ hasText: 'run_workflow' });
      await wfDetails.locator('summary').click();
      await expect(wfDetails.getByText('"headingA"')).toBeVisible();
      await expect(wfDetails.getByText('"Page A"')).toBeVisible();
      await expect(wfDetails.getByText('"headingB"')).toBeVisible();
      await expect(wfDetails.getByText('"Page B"')).toBeVisible();

      // Auto turn fires after workflow completion.
      await expect(
        sidePanel.getByText('Auto-turn: pages A and B read successfully.')
      ).toBeVisible();
    } finally {
      await multiFixture.close();
    }
  });
});

// ── Scenario 3: failure path (dangerous mode) ───────────────────────────────

test('workflow failure shows error without fabricated result', async () => {
  await withTestContext(async ({ context: { context, extensionId }, fixture }) => {
    // Mock API: after workflow failure, auto-turn fires.
    await mockKiloApi(context, {
      firstCompletionEvents: contentOnlyCompletion('The selector was not found on the page.'),
      toolNames: dangerousToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await openAuthenticatedSidePanel(context, extensionId);

    await seedApprovedWorkflow(sidePanel, {
      description: 'This will fail.',
      name: 'Missing selector',
      scopeOrigin: new URL(fixture.url).origin,
      script: SELECTOR_MISSING_SCRIPT,
    });

    await switchToDangerousMode(sidePanel);

    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo extension fixture');

    // Run from the list.
    await openSettings(sidePanel);
    const workflowRegion = sidePanel.getByRole('region', { name: 'Workflows' });
    await expect(workflowRegion).toBeVisible();
    await workflowRegion.getByRole('button', { name: 'Run workflow "Missing selector"' }).click();

    // The product shows a failed tool exchange.
    await expect(sidePanel.getByText('run_workflow failed')).toBeVisible();
    // No fabricated "result" appears.
    await expect(sidePanel.getByText(/^found$/u)).toHaveCount(0);
  });
});

// ── Scenario 4: scope (dangerous mode) ──────────────────────────────────────

test('workflow refused when tab origin does not match scope', async () => {
  await withTestContext(async ({ context: { context, extensionId }, fixture }) => {
    const otherServer = await startFixtureServer({ title: 'Other origin' });
    try {
      // Mock API: auto-turn after scope error is posted.
      await mockKiloApi(context, {
        firstCompletionEvents: contentOnlyCompletion('The workflow cannot run on this page.'),
        toolNames: dangerousToolNames,
      });

      const otherPage = await context.newPage();
      await otherPage.goto(otherServer.url);

      const sidePanel = await openAuthenticatedSidePanel(context, extensionId);

      await seedApprovedWorkflow(sidePanel, {
        description: 'Only for fixture origin.',
        name: 'Fixture-only',
        scopeOrigin: new URL(fixture.url).origin,
      });

      await switchToDangerousMode(sidePanel);

      // Select the other-origin tab.
      await expect(sidePanel.getByLabel('Target tab')).toContainText('Other origin');

      // Run from the list.
      await openSettings(sidePanel);
      const workflowRegion = sidePanel.getByRole('region', { name: 'Workflows' });
      await expect(workflowRegion).toBeVisible();
      await workflowRegion.getByRole('button', { name: 'Run workflow "Fixture-only"' }).click();

      // The product shows a scope error in the failed tool exchange.
      await expect(sidePanel.getByText('run_workflow failed')).toBeVisible();
      const scopeDetails = sidePanel.locator('details').filter({ hasText: 'run_workflow' });
      await scopeDetails.locator('summary').click();
      await expect(scopeDetails.getByText(/but this workflow only runs on/u)).toBeVisible();
    } finally {
      await otherServer.close();
    }
  });
});

// ── Scenario 5: token / round comparison (dangerous mode) ───────────────────

test('workflow uses fewer requests and fewer body bytes than eval rounds', async () => {
  await withTestContext(async ({ context: { context, extensionId }, fixture }) => {
    const evalBodies: unknown[] = [];
    const workflowBodies: unknown[] = [];

    // Run 1: eval rounds. Fixture captures bodies.
    await mockKiloApi(context, {
      firstCompletionEvents: [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    function: {
                      arguments: JSON.stringify({
                        code: 'return document.querySelector("h1")?.textContent ?? "";',
                      }),
                      name: 'eval',
                    },
                    id: 'call_eval_a1',
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
                      arguments: JSON.stringify({
                        code: 'return document.querySelector("p")?.textContent ?? "";',
                      }),
                      name: 'eval',
                    },
                    id: 'call_eval_a2',
                    index: 0,
                    type: 'function',
                  },
                ],
              },
            },
          ],
        },
      ],
      seenChatBodies: evalBodies,
      thirdCompletionEvents: contentOnlyCompletion('Final answer after two eval rounds.'),
      toolNames: dangerousToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await openAuthenticatedSidePanel(context, extensionId);

    await switchToDangerousMode(sidePanel);

    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo extension fixture');

    await sidePanel.getByLabel('Message agent').fill('Inspect the page');
    await sidePanel.getByLabel('Message agent').press('Enter');

    await expect(sidePanel.getByText('Final answer after two eval rounds.')).toBeVisible();

    // Collect eval round metrics from captured bodies.
    const evalRequestCount = evalBodies.length;
    const evalBodyBytes = evalBodies.reduce<number>(
      (sum, body) => sum + new TextEncoder().encode(JSON.stringify(body)).length,
      0
    );

    // Close and reopen the extension context for a clean workflow phase.
    await context.close();

    const launched2 = await launchExtensionContext();
    try {
      // Seed the same workflow in a fresh context.
      // Route the same fixture URL in the new context BEFORE openAuthenticatedSidePanel
      // So that the page reload inside openAuthenticatedSidePanel has mocked auth routes.
      await mockKiloApi(launched2.context, {
        firstCompletionEvents: contentOnlyCompletion('Summary after workflow run.'),
        seenChatBodies: workflowBodies,
        toolNames: dangerousToolNames,
      });

      const sidePanel2 = await openAuthenticatedSidePanel(launched2.context, launched2.extensionId);

      await seedApprovedWorkflow(sidePanel2, {
        description: 'Read h1 and p in one script.',
        name: 'Inspect page',
        scopeOrigin: new URL(fixture.url).origin,
        script: `
          const h1 = await page.text('h1');
          const p = await page.text('p');
          return { done: true, result: { h1, p } };
        `,
      });

      const page2 = await launched2.context.newPage();
      await page2.goto(fixture.url);

      await expect(sidePanel2.getByLabel('Target tab')).toContainText('Kilo extension fixture');

      await switchToDangerousMode(sidePanel2);

      // Run from the list. Auto-turn fires after result.
      await openSettings(sidePanel2);
      const workflowRegion2 = sidePanel2.getByRole('region', { name: 'Workflows' });
      await expect(workflowRegion2).toBeVisible();
      await workflowRegion2.getByRole('button', { name: 'Run workflow "Inspect page"' }).click();

      // Wait for the auto-turn to fire and be captured.
      await expect.poll(() => workflowBodies.length, { timeout: 10_000 }).toBeGreaterThan(0);

      const wfRequestCount = workflowBodies.length;
      const wfBodyBytes = workflowBodies.reduce<number>(
        (sum, body) => sum + new TextEncoder().encode(JSON.stringify(body)).length,
        0
      );

      console.log(
        'evalRequestCount:',
        evalRequestCount,
        'evalBodyBytes:',
        evalBodyBytes,
        'wfRequestCount:',
        wfRequestCount,
        'wfBodyBytes:',
        wfBodyBytes
      );

      // Assert: workflow run uses strictly fewer gateway requests and fewer body bytes.
      expect(wfRequestCount).toBeLessThan(evalRequestCount);
      expect(wfBodyBytes).toBeLessThan(evalBodyBytes);
    } finally {
      await launched2.context.close();
      await rm(launched2.userDataDir, { force: true, recursive: true });
    }
  });
});

// ── Scenario 6: memory + workflow together (dangerous mode) ─────────────────

test('memory and workflow can be used together', async () => {
  await withTestContext(async ({ context: { context, extensionId } }) => {
    // Serve a price fixture with a .price element.
    const priceFixture = await startFixtureServer({
      bodyHtml: '<span class="price">$42</span>',
      title: 'Price fixture',
    });
    try {
      const priceScript = `
        const price = await page.text('.price');
        return { done: true, result: { price } };
      `;

      await mockKiloApi(context, {
        // Auto-turn after workflow result: save_memory tool call triggers approval card.
        firstCompletionEvents: [
          {
            choices: [
              {
                delta: {
                  content: 'Price found.',
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      function: {
                        arguments: JSON.stringify({
                          note: 'New lowest price',
                          pageTitle: 'Price fixture',
                          pageUrl: priceFixture.url,
                          text: '$42',
                        }),
                        name: 'save_memory',
                      },
                      id: 'call_save_memory_1',
                      index: 0,
                      type: 'function',
                    },
                  ],
                },
              },
            ],
          },
        ],
        secondCompletionEvents: contentOnlyCompletion('Memory saved for the new price.'),
        toolNames: dangerousToolNames,
      });

      const sidePanel = await openAuthenticatedSidePanel(context, extensionId);

      const page = await context.newPage();
      await page.goto(priceFixture.url);

      await expect(sidePanel.getByLabel('Target tab')).toContainText('Price fixture');

      // Seed an old memory with a higher price.
      const oldMemory = {
        createdAt: 1_700_000_000_000,
        id: 'memory-price-old',
        pageTitle: 'Price fixture',
        pageUrl: priceFixture.url,
        text: '$58',
      };
      await setExtensionStorage(sidePanel, { [AGENT_MEMORIES_KEY]: [oldMemory] });

      await seedApprovedWorkflow(sidePanel, {
        description: 'Get the current price.',
        name: 'Price check',
        scopeOrigin: new URL(priceFixture.url).origin,
        script: priceScript,
      });

      await switchToDangerousMode(sidePanel);

      // Run the workflow.
      await openSettings(sidePanel);
      const workflowRegion = sidePanel.getByRole('region', { name: 'Workflows' });
      await expect(workflowRegion).toBeVisible();
      await workflowRegion.getByRole('button', { name: 'Run workflow "Price check"' }).click();

      // Assert the workflow tool result shows the price.
      await expect(sidePanel.getByText('run_workflow completed')).toBeVisible();

      // The auto-turn fires and the save_memory tool call triggers the approval card.
      await expect(sidePanel.getByText('Price found.')).toBeVisible();

      const memoryCard = sidePanel.getByRole('dialog', { name: 'Add to memory' });
      await expect(memoryCard).toBeVisible();
      await expect(memoryCard.getByText('$42')).toBeVisible();

      // Approve the memory card.
      await memoryCard.getByRole('button', { name: 'Save memory' }).click();
      await expect(memoryCard.getByText('Saved to memory')).toBeVisible();
      await memoryCard.getByRole('button', { name: 'Done' }).click();
      await expect(memoryCard).toBeHidden();

      await expect(sidePanel.getByText('Memory saved for the new price.')).toBeVisible();

      // Inspect the workflow details after the approval modal is gone.
      const workflowDetails = sidePanel.locator('details').filter({ hasText: 'run_workflow' });
      await workflowDetails.locator('summary').click();
      await expect(workflowDetails.getByText('"$42"')).toBeVisible();

      // Assert the new memory row exists in settings with the current price.
      await openSettings(sidePanel);
      const memoriesRegion = sidePanel.getByRole('region', { name: 'Memories' });
      await expect(memoriesRegion).toBeVisible();

      // Verify the new memory in storage has the $42 price.
      const memories = (await readExtensionLocalStorage(sidePanel, AGENT_MEMORIES_KEY)) as
        | { text: string }[]
        | undefined;
      const newMemory = memories?.find(m => m.text === '$42');
      expect(newMemory).toBeDefined();
    } finally {
      await priceFixture.close();
    }
  });
});
