/* eslint-disable import/no-nodejs-modules, max-lines */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { mockKiloApi } from './kilo-api-fixture';
import type { Page } from '@playwright/test';
import {
  launchExtensionContext,
  seedExtensionAuth,
  setExtensionStorage,
  startFixtureServer,
  waitForStoredConversationText,
} from './extension-context-fixture';

const safeToolNames = ['get_page_snapshot', 'get_element_details', 'find_in_page'];

/*
 * Read the persisted conversation store as a JSON string. Storage is the source of truth and is
 * immune to the virtualized conversation list's render/scroll timing, so assertions against it are
 * not racy while auto-compaction rewrites events.
 */
const readStoredConversationsJson = (page: Page): Promise<string> =>
  page.evaluate(async () => {
    const storage = (
      globalThis as typeof globalThis & {
        chrome?: {
          storage?: {
            local?: { get: (keys: string[]) => Promise<Record<string, unknown>> };
          };
        };
      }
    ).chrome?.storage?.local;

    if (storage === undefined) {
      throw new Error('Extension runtime storage is unavailable.');
    }

    const items = await storage.get(['kiloAgentConversations']);

    return JSON.stringify(items['kiloAgentConversations'] ?? null);
  });

const modelWithContextLength = [
  {
    contextLength: 1000,
    id: 'anthropic/claude-sonnet-4',
    name: 'Anthropic: Claude Sonnet 4',
    variants: { high: {}, low: {}, medium: {} },
  },
];

// Three-user-message conversation for compaction (splitEventsForCompaction needs >KEEP_RECENT_EXCHANGES=2 user messages)
const seededConversationStore = {
  activeConversationId: 'conv-1',
  conversations: [
    {
      events: [
        { id: 'e1', role: 'user', text: 'First message', type: 'message' },
        { id: 'e2', role: 'assistant', text: 'First reply', type: 'message' },
        { id: 'e3', role: 'user', text: 'Second message', type: 'message' },
        { id: 'e4', role: 'assistant', text: 'Second reply', type: 'message' },
        { id: 'e5', role: 'user', text: 'Third message', type: 'message' },
        { id: 'e6', role: 'assistant', text: 'Third reply', type: 'message' },
      ],
      id: 'conv-1',
      title: 'Seeded conversation',
      updatedAt: '2026-06-26T10:00:00.000Z',
    },
  ],
  openConversationIds: ['conv-1'],
};

test('context donut shows usage after a reply', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      firstCompletionEvents: [
        { choices: [{ delta: { content: 'Donut reply.' } }] },
        { choices: [], usage: { completion_tokens: 10, prompt_tokens: 850, total_tokens: 860 } },
      ],
      models: modelWithContextLength,
      toolNames: safeToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await sidePanel.getByLabel('Message agent').fill('Show me usage');
    // Wait for send to be enabled (model + target tab ready)
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeEnabled();
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByText('Donut reply.')).toBeVisible();

    // The donut <summary> aria-label is "Context usage: <summary>"
    const donut = sidePanel.getByLabel(/^Context usage:/u);
    await expect(donut).toBeVisible();
    await expect(donut).toHaveAttribute('aria-label', 'Context usage: 850 / 1,000 tokens (85%)');
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('auto-compaction fires when usage exceeds 85% threshold', async () => {
  const fixture = await startFixtureServer();
  const seenChatBodies: unknown[] = [];
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      // First call: the user's turn — returns usage ≥85% which triggers auto-compact
      firstCompletionEvents: [
        { choices: [{ delta: { content: 'Threshold reply.' } }] },
        { choices: [], usage: { completion_tokens: 10, prompt_tokens: 900, total_tokens: 910 } },
      ],
      models: modelWithContextLength,
      // Second call: the summarization request (tool_choice: 'none')
      secondCompletionEvents: [
        { choices: [{ delta: { content: 'SUMMARY: user inspected the page.' } }] },
      ],
      seenChatBodies,
      toolNames: safeToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    // Seed a conversation with 3 user messages so splitEventsForCompaction has something to compact
    await setExtensionStorage(sidePanel, { kiloAgentConversations: seededConversationStore });
    await sidePanel.reload();

    await sidePanel.getByLabel('Message agent').fill('Trigger compact');
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeEnabled();
    await sidePanel.getByLabel('Message agent').press('Enter');

    /*
     * Auto-compaction fires in the run's finally. Assert against persisted storage rather than the
     * virtualized list, which can momentarily unmount rows while compaction rewrites events.
     */
    await waitForStoredConversationText(sidePanel, 'Compacted earlier context');

    /*
     * The summary replaced the earliest seeded messages in the same atomic write, so once the
     * prefix is stored the old messages are already gone.
     */
    const conversationsJson = await readStoredConversationsJson(sidePanel);
    expect(conversationsJson).toContain('SUMMARY: user inspected the page.');
    expect(conversationsJson).not.toContain('First message');
    expect(conversationsJson).not.toContain('Second message');

    // The summarization call must have tool_choice: 'none' (sent with tools: [])
    const [, summarizationBody] = seenChatBodies;
    expect(summarizationBody).toMatchObject({ tool_choice: 'none' });
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('manual "Compact now" compacts the conversation', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      /*
       * First call: normal user turn. Sub-threshold usage (300/1000 = 30%) leaves auto-compaction
       * untriggered and gives the donut a non-zero token count. "Compact now" is enabled by having
       * summarizable history (the seeded conversation), not by this usage value.
       */
      firstCompletionEvents: [
        { choices: [{ delta: { content: 'Normal reply.' } }] },
        { choices: [], usage: { completion_tokens: 10, prompt_tokens: 300, total_tokens: 310 } },
      ],
      models: modelWithContextLength,
      // Second call: summarization triggered by "Compact now"
      secondCompletionEvents: [
        { choices: [{ delta: { content: 'SUMMARY: manually compacted.' } }] },
      ],
      toolNames: safeToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await setExtensionStorage(sidePanel, { kiloAgentConversations: seededConversationStore });
    await sidePanel.reload();

    await sidePanel.getByLabel('Message agent').fill('Manual compact trigger');
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeEnabled();
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByText('Normal reply.')).toBeVisible();

    // Open the donut popover and click Compact now
    await sidePanel.getByLabel(/^Context usage:/u).click();
    await sidePanel.getByRole('button', { name: 'Compact now' }).click();

    await expect(sidePanel.getByText(/Compacted earlier context/u)).toBeVisible({
      timeout: 10_000,
    });
    /*
     * Compaction released the input lock: with a fresh draft, Send is enabled again. It stays
     * disabled on an empty draft, which is unrelated to compaction.
     */
    await sidePanel.getByLabel('Message agent').fill('After compaction');
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeEnabled();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
