/* eslint-disable id-length, import/no-nodejs-modules, jest/no-conditional-in-test, max-lines, promise/avoid-new, promise/prefer-await-to-callbacks */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { dangerousToolNames, mockKiloApi, safeToolNames } from './kilo-api-fixture';
import {
  extensionPath,
  launchExtensionContext,
  seedExtensionAuth,
  setExtensionStorage,
  startFixtureServer,
} from './extension-context-fixture';

const PENDING_DRAFT_KEY = 'kiloPendingAgentMemoryDraft';
const AGENT_MEMORIES_KEY = 'kiloAgentMemories';
const MEMORY_SETTINGS_KEY = 'kiloMemorySettings';

const memorySettingsSchema = z.object({ autoApproveMemorySaves: z.boolean() });

const EMPTY_MEMORIES_MESSAGE =
  'No memories yet. Highlight text on any page, right-click, and choose Add to memory.';
const FULL_MESSAGE = 'Memory is full. Delete memories to save new ones.';
const CONFIRMATION_MESSAGE = 'Saved to memory';

const extensionManifestSchema = z.object({
  permissions: z.array(z.string()).optional(),
});

const userMessageSchema = z.object({
  content: z.string(),
  role: z.literal('user'),
});

const chatBodySchema = z.object({
  messages: z.array(z.unknown()).optional(),
});

const storedMemorySchema = z
  .object({
    createdAt: z.number(),
    id: z.string(),
    note: z.string().optional(),
    pageTitle: z.string(),
    pageUrl: z.string(),
    text: z.string(),
    truncated: z.boolean().optional(),
  })
  .strip();

const contentOnlyCompletion = (text: string): unknown[] => [
  { choices: [{ delta: { content: text } }] },
];

const toolCallCompletion = (name: string, args: Record<string, unknown>, id: string): unknown[] => [
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              function: {
                arguments: JSON.stringify(args),
                name,
              },
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

const readOutputManifest = async (): Promise<z.infer<typeof extensionManifestSchema>> => {
  const manifestText = await readFile(join(extensionPath, 'manifest.json'), 'utf8');
  const manifest = extensionManifestSchema.safeParse(JSON.parse(manifestText));

  if (!manifest.success) {
    throw new TypeError('Extension manifest was not an object.');
  }

  return manifest.data;
};

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

/** List/delete labels use the first 40 chars of note-or-text. */
const memoryListPreview = (text: string): string =>
  text.trim().replaceAll(/\s+/g, ' ').slice(0, 40);

const readExtensionStorage = (
  page: Page,
  keys: readonly string[]
): Promise<Record<string, unknown>> =>
  page.evaluate(
    storageKeys =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
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

        storage.get([...storageKeys], items => {
          const message = runtime.lastError?.message;

          if (message !== undefined && message !== '') {
            reject(new Error(message));
            return;
          }

          resolve(items);
        });
      }),
    keys
  );

const makeDraft = ({
  text = 'Selected text about the API key rotation policy.',
  pageTitle = 'Docs page',
  pageUrl = 'https://docs.example.com/guide',
  createdAt = 1_700_000_000_000,
}: {
  text?: string;
  pageTitle?: string;
  pageUrl?: string;
  createdAt?: number;
} = {}): {
  createdAt: number;
  pageTitle: string;
  pageUrl: string;
  text: string;
} => ({
  createdAt,
  pageTitle,
  pageUrl,
  text,
});

const makeMemory = ({
  id,
  text,
  pageTitle = 'Source page',
  pageUrl = 'https://example.com/page',
  createdAt,
  note,
}: {
  id: string;
  text: string;
  pageTitle?: string;
  pageUrl?: string;
  createdAt: number;
  note?: string;
}): {
  createdAt: number;
  id: string;
  note?: string;
  pageTitle: string;
  pageUrl: string;
  text: string;
} => ({
  createdAt,
  id,
  pageTitle,
  pageUrl,
  text,
  ...(note === undefined ? {} : { note }),
});

const lastUserMessageContent = (body: unknown): string => {
  const parsedBody = chatBodySchema.safeParse(body);
  if (!parsedBody.success || parsedBody.data.messages === undefined) {
    return '';
  }

  const { messages } = parsedBody.data;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const parsedMessage = userMessageSchema.safeParse(messages[index]);
    if (parsedMessage.success) {
      return parsedMessage.data.content;
    }
  }

  return '';
};

const findStoredMemoryByText = (
  value: unknown,
  text: string
): z.infer<typeof storedMemorySchema> | undefined => {
  const memories = z.array(z.unknown()).safeParse(value);
  if (!memories.success) {
    return undefined;
  }

  return memories.data
    .map(entry => storedMemorySchema.safeParse(entry))
    .find(entry => entry.success && entry.data.text === text)?.data;
};

const expandToolExchange = async (sidePanel: Page, toolName: string, index = 0): Promise<void> => {
  const summary = sidePanel.getByText(`${toolName} completed`).nth(index);
  await expect(summary).toBeVisible();
  const details = summary.locator('xpath=ancestor::details[1]');
  await summary.click();
  await expect(details).toHaveAttribute('open', '');
};

const openSettingsMemories = async (sidePanel: Page): Promise<void> => {
  await sidePanel.getByLabel('Settings').click();
  await expect(sidePanel.getByRole('region', { name: 'Memories' })).toBeVisible();
  await expect(sidePanel.getByRole('heading', { name: 'Memories' })).toBeVisible();
};

const closeSettings = async (sidePanel: Page): Promise<void> => {
  await sidePanel.getByLabel('Close settings').click();
};

const hydrateMemoriesViaSettings = async (
  sidePanel: Page,
  waitFor: () => Promise<void>
): Promise<void> => {
  await openSettingsMemories(sidePanel);
  await waitFor();
  await closeSettings(sidePanel);
};

test('context menu registration and manifest include Add to memory', async () => {
  const manifest = await readOutputManifest();
  expect(manifest.permissions).toContain('contextMenus');

  const { context, userDataDir } = await launchExtensionContext();

  try {
    const [existingServiceWorker] = context.serviceWorkers();
    const serviceWorker = existingServiceWorker ?? (await context.waitForEvent('serviceworker'));
    const hasListeners = await serviceWorker.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            chrome?: { contextMenus?: { onClicked?: { hasListeners: () => boolean } } };
          }
        ).chrome?.contextMenus?.onClicked?.hasListeners() === true
    );
    expect(hasListeners).toBe(true);
  } finally {
    await context.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('memories can be saved from a pending draft and listed in settings', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);
    const sidePanel = await openAuthenticatedSidePanel(context, extensionId);
    // Draft builder sanitizes query/hash before storage; seed the post-capture shape.
    const draft = makeDraft({
      pageUrl: 'https://docs.example.com/guide',
      text: 'Remember to rotate the staging API key monthly.',
    });

    await setExtensionStorage(sidePanel, { [PENDING_DRAFT_KEY]: draft });

    const card = sidePanel.getByRole('dialog', { name: 'Add to memory' });
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('aria-modal', 'true');
    await expect(card.getByText(draft.text)).toBeVisible();

    const noteField = card.getByLabel('Memory note (optional)');
    await expect
      .poll(() => noteField.evaluate(element => document.activeElement === element))
      .toBe(true);

    await noteField.fill('Ops note');
    await card.getByRole('button', { name: 'Save memory' }).click();
    await expect(card.getByText(CONFIRMATION_MESSAGE)).toBeVisible();
    await card.getByRole('button', { name: 'Done' }).click();
    await expect(card).toBeHidden();

    const stored = await readExtensionStorage(sidePanel, [AGENT_MEMORIES_KEY, PENDING_DRAFT_KEY]);
    expect(stored[PENDING_DRAFT_KEY]).toBeUndefined();

    const saved = findStoredMemoryByText(stored[AGENT_MEMORIES_KEY], draft.text);
    expect(saved).toMatchObject({
      note: 'Ops note',
      pageTitle: draft.pageTitle,
      pageUrl: 'https://docs.example.com/guide',
      text: draft.text,
    });
    expect(saved?.pageUrl ?? '').not.toMatch(/[?#]/u);
    expect(saved?.truncated).toBeUndefined();

    await openSettingsMemories(sidePanel);
    const memoriesRegion = sidePanel.getByRole('region', { name: 'Memories' });
    await expect(memoriesRegion.getByText('Ops note')).toBeVisible();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('memories save card cancel discards the draft', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);
    const sidePanel = await openAuthenticatedSidePanel(context, extensionId);
    const draft = makeDraft({ text: 'Draft that should be discarded on cancel.' });

    await setExtensionStorage(sidePanel, { [PENDING_DRAFT_KEY]: draft });

    const card = sidePanel.getByRole('dialog', { name: 'Add to memory' });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Cancel' }).click();
    await expect(card).toBeHidden();

    await expect
      .poll(async () => {
        const stored = await readExtensionStorage(sidePanel, [
          AGENT_MEMORIES_KEY,
          PENDING_DRAFT_KEY,
        ]);
        return {
          draft: stored[PENDING_DRAFT_KEY] ?? null,
          memories: stored[AGENT_MEMORIES_KEY] ?? null,
        };
      })
      .toStrictEqual({ draft: null, memories: null });
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('memory index is included in the chat request context', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();
  const seenChatBodies: unknown[] = [];

  try {
    await mockKiloApi(context, {
      firstCompletionEvents: contentOnlyCompletion('First reply with memory index.'),
      secondCompletionEvents: contentOnlyCompletion('Second reply without memory index.'),
      seenChatBodies,
      toolNames: [...safeToolNames],
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await openAuthenticatedSidePanel(context, extensionId);
    const memories = [
      makeMemory({
        createdAt: 1_700_000_000_100,
        id: 'memory-alpha',
        text: 'Alpha memory unique preview text',
      }),
      makeMemory({
        createdAt: 1_700_000_000_200,
        id: 'memory-beta',
        text: 'Beta memory unique preview text',
      }),
    ];

    await setExtensionStorage(sidePanel, { [AGENT_MEMORIES_KEY]: memories });
    await hydrateMemoriesViaSettings(sidePanel, async () => {
      const region = sidePanel.getByRole('region', { name: 'Memories' });
      await expect(
        region.getByText(memoryListPreview('Alpha memory unique preview text'))
      ).toBeVisible();
      await expect(
        region.getByText(memoryListPreview('Beta memory unique preview text'))
      ).toBeVisible();
    });

    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo extension fixture');
    await sidePanel.getByLabel('Message agent').fill('Use my memories');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByText('First reply with memory index.')).toBeVisible();

    await expect.poll(() => seenChatBodies.length).toBe(1);
    const firstUserContent = lastUserMessageContent(seenChatBodies[0]);
    expect(firstUserContent).toContain('<system_environment>');
    expect(firstUserContent).toContain('<memories');
    expect(firstUserContent).toContain('Alpha memory unique preview text');
    expect(firstUserContent).toContain('Beta memory unique preview text');

    await setExtensionStorage(sidePanel, { [AGENT_MEMORIES_KEY]: [] });
    await hydrateMemoriesViaSettings(sidePanel, async () => {
      await expect(
        sidePanel.getByRole('region', { name: 'Memories' }).getByText(EMPTY_MEMORIES_MESSAGE)
      ).toBeVisible();
    });

    await sidePanel.getByLabel('Message agent').fill('Memories should be gone');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByText('Second reply without memory index.')).toBeVisible();

    await expect.poll(() => seenChatBodies.length).toBe(2);
    const secondUserContent = lastUserMessageContent(seenChatBodies[1]);
    expect(secondUserContent).toContain('<system_environment>');
    expect(secondUserContent).not.toContain('<memories');
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('memory tools search and read saved memories', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    const memories = [
      makeMemory({
        createdAt: 1_700_000_000_300,
        id: 'memory-search-1',
        text: 'UniqueApple memory full body about orchards.',
      }),
      makeMemory({
        createdAt: 1_700_000_000_200,
        id: 'memory-search-2',
        text: 'UniqueBanana memory full body about tropics.',
      }),
      makeMemory({
        createdAt: 1_700_000_000_100,
        id: 'memory-search-3',
        text: 'UniqueCherry memory full body about pies.',
      }),
    ];

    await mockKiloApi(context, {
      firstCompletionEvents: toolCallCompletion(
        'search_memories',
        { query: 'UniqueApple' },
        'call_search_1'
      ),
      secondCompletionEvents: toolCallCompletion(
        'get_memory',
        { memoryId: 'memory-search-1' },
        'call_get_1'
      ),
      thirdCompletionEvents: toolCallCompletion(
        'search_memories',
        { query: 'zzzz-no-match-token' },
        'call_search_2'
      ),
      toolNames: [...safeToolNames],
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await openAuthenticatedSidePanel(context, extensionId);
    await setExtensionStorage(sidePanel, { [AGENT_MEMORIES_KEY]: memories });
    await hydrateMemoriesViaSettings(sidePanel, async () => {
      const region = sidePanel.getByRole('region', { name: 'Memories' });
      await expect(
        region.getByText(memoryListPreview('UniqueApple memory full body about orchards.'))
      ).toBeVisible();
      await expect(
        region.getByText(memoryListPreview('UniqueBanana memory full body about tropics.'))
      ).toBeVisible();
      await expect(
        region.getByText(memoryListPreview('UniqueCherry memory full body about pies.'))
      ).toBeVisible();
    });

    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo extension fixture');
    await sidePanel.getByLabel('Message agent').fill('Search and read memories');
    await sidePanel.getByLabel('Message agent').press('Enter');

    await expect(sidePanel.getByText('search_memories completed').first()).toBeVisible();
    await expect(sidePanel.getByText('get_memory completed')).toBeVisible();
    await expect(sidePanel.getByText('search_memories completed').nth(1)).toBeVisible();

    await expandToolExchange(sidePanel, 'search_memories', 0);
    const firstSearch = sidePanel
      .getByText('search_memories completed')
      .nth(0)
      .locator('xpath=ancestor::details[1]');
    await expect(
      firstSearch.getByText('UniqueApple memory full body about orchards.')
    ).toBeVisible();
    await expect(firstSearch.getByText('memory-search-1')).toBeVisible();

    await expandToolExchange(sidePanel, 'get_memory', 0);
    const getMemory = sidePanel
      .getByText('get_memory completed')
      .locator('xpath=ancestor::details[1]');
    await expect(getMemory.getByText('UniqueApple memory full body about orchards.')).toBeVisible();
    await expect(getMemory.getByText('memory-search-1')).toBeVisible();

    await expandToolExchange(sidePanel, 'search_memories', 1);
    const secondSearch = sidePanel
      .getByText('search_memories completed')
      .nth(1)
      .locator('xpath=ancestor::details[1]');
    await expect(secondSearch.getByText('No memories matched.')).toBeVisible();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('memory full state blocks saving, recovers after delete', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);
    const sidePanel = await openAuthenticatedSidePanel(context, extensionId);
    const fullMemories = Array.from({ length: 200 }, (_, index) =>
      makeMemory({
        createdAt: 1_700_000_000_000 + index,
        id: `memory-full-${String(index).padStart(3, '0')}`,
        // Keep previews unique and within the 40-char delete-label budget.
        text: `Full seed mem ${String(index).padStart(3, '0')}`,
      })
    );
    const draft = makeDraft({
      text: 'Draft waiting while memory store is full.',
    });

    await setExtensionStorage(sidePanel, {
      [AGENT_MEMORIES_KEY]: fullMemories,
      [PENDING_DRAFT_KEY]: draft,
    });

    const card = sidePanel.getByRole('dialog', { name: 'Add to memory' });
    await expect(card.getByText(FULL_MESSAGE)).toBeVisible();
    await expect(card.getByRole('button', { name: 'Manage memories' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Retry' })).toHaveCount(0);

    // Settings (z-30) must open visibly above the floating card (z-[25]).
    await card.getByRole('button', { name: 'Manage memories' }).click();
    const settingsPanel = sidePanel.getByRole('dialog', { name: 'Settings panel' });
    await expect(settingsPanel).toBeVisible();
    const memoriesRegion = sidePanel.getByRole('region', { name: 'Memories' });
    await expect(memoriesRegion).toBeVisible();

    const stacking = await sidePanel.evaluate(() => {
      const settings = document.querySelector('[aria-label="Settings panel"]');
      const memoryCard = document.querySelector('[aria-label="Add to memory"]');
      if (!(settings instanceof HTMLElement) || !(memoryCard instanceof HTMLElement)) {
        return null;
      }

      const settingsZ = Number.parseFloat(getComputedStyle(settings).zIndex);
      const cardZ = Number.parseFloat(getComputedStyle(memoryCard).zIndex);
      return { cardZ, settingsAboveCard: settingsZ > cardZ, settingsZ };
    });
    expect(stacking).not.toBeNull();
    expect(stacking?.settingsAboveCard).toBe(true);

    const deletePreview = memoryListPreview('Full seed mem 199');
    const deleteLabel = `Delete memory "${deletePreview}"`;
    await sidePanel.getByRole('button', { name: deleteLabel }).click();
    await expect(sidePanel.getByRole('button', { name: deleteLabel })).toHaveCount(0);
    await closeSettings(sidePanel);

    // Pending draft remains intact after Settings closes.
    await expect(card).toBeVisible();
    await expect(card.getByText(FULL_MESSAGE)).toBeHidden();
    await expect(card.getByText(draft.text)).toBeVisible();
    await card.getByRole('button', { name: 'Save memory' }).click();
    await expect(card.getByText(CONFIRMATION_MESSAGE)).toBeVisible();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('add-to-memory card floats over the conversation without shifting layout', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);
    const sidePanel = await openAuthenticatedSidePanel(context, extensionId);
    await sidePanel.setViewportSize({ height: 520, width: 320 });

    const conversation = sidePanel.getByLabel('Agent conversation');
    await expect(conversation).toBeVisible();

    const before = await conversation.evaluate(element => {
      const box = element.getBoundingClientRect();
      return { height: box.height, top: box.top };
    });

    const draft = makeDraft({ text: 'Overlay layout should not shrink conversation.' });
    await setExtensionStorage(sidePanel, { [PENDING_DRAFT_KEY]: draft });

    const card = sidePanel.getByRole('dialog', { name: 'Add to memory' });
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('aria-modal', 'true');

    const after = await conversation.evaluate(element => {
      const box = element.getBoundingClientRect();
      return { height: box.height, top: box.top };
    });

    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);

    const intersects = await sidePanel.evaluate(() => {
      const cardEl = document.querySelector('[aria-label="Add to memory"]');
      const conversationEl = document.querySelector('[aria-label="Agent conversation"]');
      if (!(cardEl instanceof HTMLElement) || !(conversationEl instanceof HTMLElement)) {
        return false;
      }

      // Prefer the inner raised card if present; otherwise the dialog root.
      const surface =
        cardEl.querySelector('.rounded-xl') instanceof HTMLElement
          ? cardEl.querySelector('.rounded-xl')
          : cardEl;
      if (!(surface instanceof HTMLElement)) {
        return false;
      }

      const cardBox = surface.getBoundingClientRect();
      const conversationBox = conversationEl.getBoundingClientRect();
      return !(
        cardBox.right < conversationBox.left ||
        cardBox.left > conversationBox.right ||
        cardBox.bottom < conversationBox.top ||
        cardBox.top > conversationBox.bottom
      );
    });
    expect(intersects).toBe(true);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('settings memories list supports delete and shows the empty state', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);
    const sidePanel = await openAuthenticatedSidePanel(context, extensionId);
    const alphaText = 'ListAlpha unique settings preview';
    const betaText = 'ListBeta unique settings preview';
    const memories = [
      makeMemory({
        createdAt: 1_700_000_000_200,
        id: 'memory-list-1',
        text: alphaText,
      }),
      makeMemory({
        createdAt: 1_700_000_000_100,
        id: 'memory-list-2',
        text: betaText,
      }),
    ];

    await setExtensionStorage(sidePanel, { [AGENT_MEMORIES_KEY]: memories });
    await openSettingsMemories(sidePanel);

    const region = sidePanel.getByRole('region', { name: 'Memories' });
    const alphaPreview = memoryListPreview(alphaText);
    const betaPreview = memoryListPreview(betaText);
    await expect(region.getByText(alphaPreview)).toBeVisible();
    await expect(region.getByText(betaPreview)).toBeVisible();

    await sidePanel.getByRole('button', { name: `Delete memory "${alphaPreview}"` }).click();
    await expect(region.getByText(alphaPreview)).toHaveCount(0);
    await expect(region.getByText(betaPreview)).toBeVisible();

    await sidePanel.getByRole('button', { name: `Delete memory "${betaPreview}"` }).click();
    await expect(region.getByText(EMPTY_MEMORIES_MESSAGE)).toBeVisible();
    await expect(region.getByRole('button')).toHaveCount(0);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('memory tools are available in dangerous mode', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    const memories = [
      makeMemory({
        createdAt: 1_700_000_000_100,
        id: 'memory-danger-1',
        text: 'DangerMode unique memory preview text',
      }),
    ];

    await mockKiloApi(context, {
      firstCompletionEvents: toolCallCompletion(
        'search_memories',
        { query: 'DangerMode' },
        'call_search_danger'
      ),
      secondCompletionEvents: contentOnlyCompletion('Dangerous mode used search_memories.'),
      toolNames: [...dangerousToolNames],
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await openAuthenticatedSidePanel(context, extensionId);
    await setExtensionStorage(sidePanel, { [AGENT_MEMORIES_KEY]: memories });
    await hydrateMemoriesViaSettings(sidePanel, async () => {
      await expect(
        sidePanel
          .getByRole('region', { name: 'Memories' })
          .getByText(memoryListPreview('DangerMode unique memory preview text'))
      ).toBeVisible();
    });

    await sidePanel.getByRole('button', { name: /Safe mode/u }).click();
    await sidePanel.getByRole('button', { name: 'Dangerous' }).click();
    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo extension fixture');

    await sidePanel.getByLabel('Message agent').fill('Search memories in dangerous mode');
    await sidePanel.getByLabel('Message agent').press('Enter');

    await expect(sidePanel.getByText('search_memories completed')).toBeVisible();
    await expandToolExchange(sidePanel, 'search_memories', 0);
    const searchDetails = sidePanel
      .getByText('search_memories completed')
      .locator('xpath=ancestor::details[1]');
    await expect(searchDetails.getByText('DangerMode unique memory preview text')).toBeVisible();
    await expect(sidePanel.getByText('Dangerous mode used search_memories.')).toBeVisible();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('memories settings auto-approve toggle starts off and persists', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);
    const sidePanel = await openAuthenticatedSidePanel(context, extensionId);
    await openSettingsMemories(sidePanel);

    const toggle = sidePanel.getByRole('switch', { name: 'Auto-approve memory saves' });

    // Default is the confirmation card: the setting ships off.
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    // Confirm through storage, not the DOM, that the setting was written.
    await expect
      .poll(async () => {
        const stored = await readExtensionStorage(sidePanel, [MEMORY_SETTINGS_KEY]);
        const settings = memorySettingsSchema.safeParse(stored[MEMORY_SETTINGS_KEY]);

        return settings.success && settings.data.autoApproveMemorySaves;
      })
      .toBe(true);

    // The choice survives a side panel reload.
    await sidePanel.reload();
    await openSettingsMemories(sidePanel);
    await expect(
      sidePanel.getByRole('switch', { name: 'Auto-approve memory saves' })
    ).toHaveAttribute('aria-checked', 'true');
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
