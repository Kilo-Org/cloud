/* eslint-disable import/no-nodejs-modules, jest/no-conditional-in-test, max-lines, no-await-in-loop, promise/avoid-new */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page, Request } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import { launchExtensionContext, startFixtureServer } from './extension-context-fixture';

const localBackendUrl = 'http://localhost:3000';
const localUserEmail = 'fl@fl.fl';
const frontierModel = 'kilo-auto/frontier';

interface ChatRequestSummary {
  readonly lastUserContent: string | undefined;
  readonly messageCount: number | undefined;
  readonly model: string | undefined;
  readonly toolNames: string[];
}

interface ChatRequestOutcome {
  readonly errorText: string | undefined;
  readonly status: 'failed' | 'finished';
}

interface ChatRequestTiming {
  finishedAt?: number;
  lastUserContent: string | undefined;
  startedAt: number;
}

interface ConversationSample {
  readonly activeTab: string;
  readonly lastRowBottom: number | null;
  readonly scrollTop: number;
}

const startConversationGapSampler = (page: Page): Promise<void> =>
  page.evaluate(() => {
    Reflect.set(globalThis, '__kiloMinConversationGap', 0);
    requestAnimationFrame(function sampleConversationGaps(): void {
      const rows = [...document.querySelectorAll('[aria-label="Agent conversation"] [data-index]')]
        .map(element => {
          const rect = element.getBoundingClientRect();

          return { bottom: rect.bottom, top: rect.top };
        })
        .toSorted((first, second) => first.top - second.top);
      let previousBottom = 0;

      const gaps = rows
        .map(row => {
          const gap = row.top - previousBottom;

          previousBottom = row.bottom;

          return gap;
        })
        .slice(1);

      Reflect.set(
        globalThis,
        '__kiloMinConversationGap',
        Math.min(Number(Reflect.get(globalThis, '__kiloMinConversationGap')), ...gaps, 0)
      );
      requestAnimationFrame(sampleConversationGaps);
    });
  });

const getMinConversationGap = (page: Page): Promise<number> =>
  page.evaluate(() => Number(Reflect.get(globalThis, '__kiloMinConversationGap')));

const chatRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        content: z.unknown().optional(),
        role: z.string().optional(),
      })
    )
    .optional(),
  model: z.string().optional(),
  tools: z
    .array(
      z.object({
        function: z
          .object({
            name: z.string().optional(),
          })
          .optional(),
      })
    )
    .optional(),
});

const getLastUserContent = (
  messages: z.infer<typeof chatRequestSchema>['messages']
): string | undefined =>
  messages
    ?.flatMap(message =>
      message.role === 'user' && typeof message.content === 'string' ? [message.content] : []
    )
    .at(-1);

test.skip(
  process.env['EXTENSION_LOCAL_BACKEND_E2E'] !== '1',
  'requires localhost backend, fl@fl.fl, and a build with VITE_KILO_API_BASE_URL=http://localhost:3000'
);
test.setTimeout(150_000);

const recordChatRequests = (context: BrowserContext, requests: ChatRequestSummary[]): void => {
  context.on('request', request => {
    if (!request.url().includes('/api/gateway/v1/chat/completions')) {
      return;
    }

    const parsedBody = chatRequestSchema.safeParse(request.postDataJSON());
    const body = parsedBody.success ? parsedBody.data : undefined;

    requests.push({
      lastUserContent: getLastUserContent(body?.messages),
      messageCount: body?.messages?.length,
      model: body?.model,
      toolNames: body?.tools?.map(tool => tool.function?.name ?? '').filter(Boolean) ?? [],
    });
  });
};

const recordChatRequestTimings = (context: BrowserContext, timings: ChatRequestTiming[]): void => {
  const activeTimings = new Map<Request, ChatRequestTiming>();
  const finishTiming = (request: Request): void => {
    const timing = activeTimings.get(request);

    if (timing === undefined) {
      return;
    }

    timing.finishedAt = Date.now();
  };

  context.on('request', request => {
    if (!request.url().includes('/api/gateway/v1/chat/completions')) {
      return;
    }

    const parsedBody = chatRequestSchema.safeParse(request.postDataJSON());
    const body = parsedBody.success ? parsedBody.data : undefined;
    const timing = {
      lastUserContent: getLastUserContent(body?.messages),
      startedAt: Date.now(),
    };

    activeTimings.set(request, timing);
    timings.push(timing);
  });
  context.on('requestfailed', request => {
    finishTiming(request);
  });
  context.on('requestfinished', request => {
    finishTiming(request);
  });
};

const recordChatRequestOutcomes = (
  context: BrowserContext,
  outcomes: ChatRequestOutcome[]
): void => {
  context.on('requestfailed', request => {
    if (request.url().includes('/api/gateway/v1/chat/completions')) {
      outcomes.push({ errorText: request.failure()?.errorText, status: 'failed' });
    }
  });
  context.on('requestfinished', request => {
    if (request.url().includes('/api/gateway/v1/chat/completions')) {
      outcomes.push({ errorText: undefined, status: 'finished' });
    }
  });
};

const signInWithLocalDeviceAuth = async ({
  context,
  extensionId,
  sidePanel,
}: {
  context: BrowserContext;
  extensionId: string;
  sidePanel: Page;
}): Promise<void> => {
  await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const codeLocator = sidePanel.getByText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u).first();
  let codeText: string | null = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sidePanel.getByRole('button', { name: 'Sign in' }).click();

    const didShowCode = await codeLocator
      .waitFor({ state: 'visible', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);

    if (didShowCode) {
      codeText = await codeLocator.textContent();
      break;
    }

    await expect(sidePanel.getByText('Failed to start sign in. Try again.')).toBeVisible();
  }

  const code = codeText?.trim();

  if (code === undefined || code === '') {
    throw new Error('Device auth code was not visible.');
  }

  const authPage = await context.newPage();
  const callbackPath = `/device-auth?code=${encodeURIComponent(code)}&app=1`;

  await authPage.goto(
    `${localBackendUrl}/users/sign_in?fakeUser=${encodeURIComponent(localUserEmail)}&callbackPath=${encodeURIComponent(callbackPath)}`
  );
  await authPage.getByRole('button', { name: 'Authorize' }).click({ timeout: 60_000 });
  await expect(sidePanel.getByLabel('Message agent')).toBeVisible({ timeout: 30_000 });
  await authPage.close();
};

const selectFrontierModel = async (sidePanel: Page): Promise<void> => {
  await expect
    .poll(
      () =>
        sidePanel
          .getByLabel('Model')
          .locator('option')
          .evaluateAll(options =>
            options.map(option => (option instanceof HTMLOptionElement ? option.value : ''))
          ),
      { timeout: 30_000 }
    )
    .toContain(frontierModel);

  await sidePanel.getByLabel('Model').selectOption(frontierModel);

  const thinkingValues = await sidePanel
    .getByLabel('Thinking effort')
    .locator('option')
    .evaluateAll(options =>
      options.map(option => (option instanceof HTMLOptionElement ? option.value : ''))
    );

  if (thinkingValues.includes('medium')) {
    await sidePanel.getByLabel('Thinking effort').selectOption('medium');
  }
};

const sampleConversation = (page: Page, durationMs: number): Promise<ConversationSample[]> =>
  page.evaluate(async duration => {
    const samples: ConversationSample[] = [];
    const stopAt = performance.now() + duration;

    while (performance.now() < stopAt) {
      const pane = document.querySelector('[aria-label="Agent conversation"]');

      if (!(pane instanceof HTMLElement)) {
        throw new Error('Conversation pane was not found.');
      }

      const rows = [...pane.querySelectorAll('[data-index]')].filter(
        (row): row is HTMLElement => row instanceof HTMLElement
      );
      const selectedTab = document.querySelector('[role="tab"][aria-selected="true"]');

      samples.push({
        activeTab: selectedTab?.textContent?.trim() ?? '',
        lastRowBottom: rows.at(-1)?.getBoundingClientRect().bottom ?? null,
        scrollTop: pane.scrollTop,
      });
      await new Promise<void>(resolve => {
        setTimeout(resolve, 100);
      });
    }

    return samples;
  }, durationMs);

const getStabilitySummary = (
  samples: ConversationSample[]
): { activeTabChanges: number; largePositionJumps: number; negativeScrollJumps: number } => {
  let activeTabChanges = 0;
  let largePositionJumps = 0;
  let negativeScrollJumps = 0;

  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];

    if (
      previous !== undefined &&
      current !== undefined &&
      current.activeTab !== previous.activeTab
    ) {
      activeTabChanges += 1;
    }

    if (
      previous !== undefined &&
      current !== undefined &&
      current.scrollTop + 8 < previous.scrollTop
    ) {
      negativeScrollJumps += 1;
    }

    if (
      previous !== undefined &&
      current !== undefined &&
      previous.lastRowBottom !== null &&
      current.lastRowBottom !== null &&
      Math.abs(current.lastRowBottom - previous.lastRowBottom) > 180
    ) {
      largePositionJumps += 1;
    }
  }

  return { activeTabChanges, largePositionJumps, negativeScrollJumps };
};

const getExtensionStorage = (page: Page, keys: string[]): Promise<Record<string, unknown>> =>
  page.evaluate(storageKeys => {
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
      throw new Error('Extension storage is unavailable.');
    }

    return storage.get(storageKeys);
  }, keys);

const getStoredConversationSnapshot = async (page: Page): Promise<string> => {
  const storage = await getExtensionStorage(page, ['kiloAgentConversations']);

  return JSON.stringify(storage['kiloAgentConversations'] ?? null);
};

const waitForStoredConversationSnapshot = async (
  page: Page,
  predicate: (snapshot: string) => boolean
): Promise<void> => {
  await expect
    .poll(async () => predicate(await getStoredConversationSnapshot(page)), { timeout: 30_000 })
    .toBe(true);
};

test('live local backend keeps frontier conversations stable across modes, reload, and logout', async ({
  page: _page,
}, testInfo) => {
  const fixture = await startFixtureServer({ title: 'Kilo live backend E2E target' });
  const requests: ChatRequestSummary[] = [];
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  recordChatRequests(context, requests);

  try {
    const targetPage = await context.newPage();
    await targetPage.goto(fixture.url);

    const sidePanel = await context.newPage();
    await signInWithLocalDeviceAuth({ context, extensionId, sidePanel });
    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo live backend E2E target');
    await selectFrontierModel(sidePanel);

    await sidePanel
      .getByLabel('Message agent')
      .fill('What do you see? Answer in two short sentences.');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByRole('button', { name: 'Stop' })).toBeVisible();

    const firstSamples = await sampleConversation(sidePanel, 2500);
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeVisible({
      timeout: 120_000,
    });
    const firstSummary = getStabilitySummary(firstSamples);

    expect(firstSummary).toMatchObject({
      activeTabChanges: 0,
      largePositionJumps: 0,
      negativeScrollJumps: 0,
    });

    await sidePanel.getByLabel(/Safe mode/u).click();
    await sidePanel.getByRole('button', { name: /Dangerous/u }).click();
    await sidePanel
      .getByLabel('Message agent')
      .fill('Use eval if useful to inspect the page title. Reply with one short sentence.');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeVisible({
      timeout: 120_000,
    });

    await sidePanel.getByLabel('New conversation').click();
    await expect(sidePanel.getByLabel(/Danger mode/u)).toBeVisible();
    await expect(sidePanel.getByLabel('Model')).toHaveValue(frontierModel);
    await sidePanel.getByLabel(/Danger mode/u).click();
    await sidePanel.getByRole('button', { name: /^Safe/u }).click();
    await sidePanel.getByRole('tab').nth(0).click();
    await expect(sidePanel.getByLabel(/Danger mode/u)).toBeVisible();
    await waitForStoredConversationSnapshot(
      sidePanel,
      snapshot =>
        snapshot.includes(frontierModel) &&
        snapshot.includes('"mode":"dangerous"') &&
        snapshot.includes('Use eval if useful')
    );

    await sidePanel.reload();
    await expect(sidePanel.getByLabel('Message agent')).toBeVisible({ timeout: 30_000 });
    await expect(sidePanel.getByLabel('Model')).toHaveValue(frontierModel);
    await expect(sidePanel.getByLabel(/Danger mode/u)).toBeVisible();
    await expect(
      getExtensionStorage(sidePanel, ['kiloAuth', 'kiloAgentConversations'])
    ).resolves.toHaveProperty('kiloAuth');

    await sidePanel.screenshot({
      fullPage: true,
      path: testInfo.outputPath('local-backend-live-before-logout.png'),
    });
    await sidePanel.getByLabel('Settings').click();
    await expect(sidePanel.getByText(localUserEmail)).toBeVisible();
    await sidePanel.getByRole('button', { name: 'Sign out' }).click();
    await expect(sidePanel.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(
      getExtensionStorage(sidePanel, ['kiloAuth', 'kiloAgentConversations'])
    ).resolves.toStrictEqual({});

    expect(requests.some(request => request.model === frontierModel)).toBe(true);
    expect(requests.some(request => request.toolNames.includes('eval'))).toBe(true);
    expect(requests.some(request => request.toolNames.includes('get_page_snapshot'))).toBe(true);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('live local backend snapshots the selected target tab per send', async () => {
  const firstFixture = await startFixtureServer({ title: 'Kilo live target alpha' });
  const secondFixture = await startFixtureServer({ title: 'Kilo live target beta' });
  const requests: ChatRequestSummary[] = [];
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  recordChatRequests(context, requests);

  try {
    const firstTarget = await context.newPage();
    await firstTarget.goto(`${firstFixture.url}/alpha?token=SECRET_ALPHA#secret-alpha`);
    const secondTarget = await context.newPage();
    await secondTarget.goto(`${secondFixture.url}/beta?token=SECRET_BETA#secret-beta`);
    await firstTarget.bringToFront();

    const sidePanel = await context.newPage();
    await signInWithLocalDeviceAuth({ context, extensionId, sidePanel });
    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo live target alpha');
    await selectFrontierModel(sidePanel);
    await sidePanel.getByLabel('Target tab').selectOption({ label: 'Kilo live target alpha' });
    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo live target alpha');

    const messageInput = sidePanel.getByLabel('Message agent');

    await messageInput.fill('LOCAL_CONTEXT_ALPHA: answer with the selected tab title only.');
    await messageInput.press('Enter');
    await expect(sidePanel.getByRole('button', { name: 'Stop' })).toBeVisible();
    await sidePanel.getByLabel('Target tab').selectOption({ label: 'Kilo live target beta' });
    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo live target beta');
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeVisible({
      timeout: 120_000,
    });

    await messageInput.fill('LOCAL_CONTEXT_BETA: answer with the selected tab title only.');
    await messageInput.press('Enter');
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeVisible({
      timeout: 120_000,
    });

    const alphaRequest = requests.find(
      request => request.lastUserContent?.includes('LOCAL_CONTEXT_ALPHA') === true
    );
    const betaRequest = requests.find(
      request => request.lastUserContent?.includes('LOCAL_CONTEXT_BETA') === true
    );

    expect(alphaRequest?.model).toBe(frontierModel);
    expect(alphaRequest?.lastUserContent).toContain('Kilo live target alpha');
    expect(alphaRequest?.lastUserContent).not.toContain('Kilo live target beta');
    expect(alphaRequest?.lastUserContent).not.toContain('SECRET_ALPHA');
    expect(alphaRequest?.lastUserContent).not.toContain('secret-alpha');

    expect(betaRequest?.model).toBe(frontierModel);
    expect(betaRequest?.lastUserContent).toContain('Kilo live target beta');
    expect(betaRequest?.lastUserContent).not.toContain('SECRET_BETA');
    expect(betaRequest?.lastUserContent).not.toContain('secret-beta');
  } finally {
    await context.close();
    await firstFixture.close();
    await secondFixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('live local backend runs parallel frontier conversations without switching tabs', async () => {
  const fixture = await startFixtureServer({ title: 'Kilo live parallel target' });
  const timings: ChatRequestTiming[] = [];
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  recordChatRequestTimings(context, timings);

  try {
    const targetPage = await context.newPage();
    await targetPage.goto(fixture.url);

    const sidePanel = await context.newPage();
    await signInWithLocalDeviceAuth({ context, extensionId, sidePanel });
    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo live parallel target');
    await selectFrontierModel(sidePanel);

    const messageInput = sidePanel.getByLabel('Message agent');

    await messageInput.fill('LOCAL_PARALLEL_FIRST: write a detailed answer of at least 700 words.');
    await messageInput.press('Enter');
    await expect(sidePanel.getByRole('button', { exact: true, name: 'Stop' })).toBeVisible();

    await sidePanel.getByLabel('New conversation').click();
    await messageInput.fill('LOCAL_PARALLEL_SECOND: reply in one short sentence.');
    await messageInput.press('Enter');

    await expect
      .poll(
        () => {
          const first = timings.find(
            timing => timing.lastUserContent?.includes('LOCAL_PARALLEL_FIRST') === true
          );
          const second = timings.find(
            timing => timing.lastUserContent?.includes('LOCAL_PARALLEL_SECOND') === true
          );

          return (
            first !== undefined &&
            second !== undefined &&
            (first.finishedAt === undefined || second.startedAt < first.finishedAt)
          );
        },
        { timeout: 30_000 }
      )
      .toBe(true);

    // The second request stays on its own tab (the running first request never steals focus).
    await expect(sidePanel.getByRole('tab', { selected: true })).toContainText(
      'LOCAL_PARALLEL_SECOND'
    );

    // Switch to the still-running first conversation and stop it, promptly after the overlap poll: a backgrounded run is also aborted if its selected tab leaves the inspectable list, so we don't wait out the second request before exercising the first.
    await sidePanel.getByRole('tab', { name: /LOCAL_PARALLEL_FIRST/u }).click();
    // Match the user message exactly: the live model's thinking can quote the prompt token, which would make a substring match resolve to multiple elements.
    await expect(
      sidePanel
        .getByLabel('Agent conversation')
        .getByText('LOCAL_PARALLEL_FIRST: write a detailed answer of at least 700 words.', {
          exact: true,
        })
    ).toBeVisible();
    const firstStopButton = sidePanel.getByRole('button', { exact: true, name: 'Stop' });

    await expect(firstStopButton).toBeVisible();
    await firstStopButton.click();
    await expect(sidePanel.getByText('Stopped.')).toBeVisible({ timeout: 30_000 });

    // The second conversation runs to completion on its own tab.
    await sidePanel.getByRole('tab', { name: /LOCAL_PARALLEL_SECOND/u }).click();
    await expect(sidePanel.getByRole('tab', { selected: true })).toContainText(
      'LOCAL_PARALLEL_SECOND'
    );
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeVisible({
      timeout: 120_000,
    });
    await expect(
      sidePanel
        .getByLabel('Agent conversation')
        .getByText('LOCAL_PARALLEL_SECOND: reply in one short sentence.', { exact: true })
    ).toBeVisible();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('live local backend aborts an active frontier request on logout', async () => {
  const fixture = await startFixtureServer({ title: 'Kilo live logout abort target' });
  const outcomes: ChatRequestOutcome[] = [];
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  recordChatRequestOutcomes(context, outcomes);

  try {
    const targetPage = await context.newPage();
    await targetPage.goto(fixture.url);

    const sidePanel = await context.newPage();
    await signInWithLocalDeviceAuth({ context, extensionId, sidePanel });
    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo live logout abort target');
    await selectFrontierModel(sidePanel);

    await sidePanel
      .getByLabel('Message agent')
      .fill('LOCAL_LOGOUT_ABORT: write a very long answer with at least 1500 words.');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByRole('button', { name: 'Stop' })).toBeVisible();
    await sidePanel.getByLabel('Settings').click();
    await expect(sidePanel.getByText(localUserEmail)).toBeVisible();
    await sidePanel.getByRole('button', { name: 'Sign out' }).click();
    await expect(sidePanel.getByRole('button', { name: 'Sign in' })).toBeVisible();

    await expect.poll(() => outcomes.length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(outcomes.some(outcome => outcome.status === 'failed')).toBe(true);
    expect(outcomes.some(outcome => outcome.status === 'finished')).toBe(false);
    await expect(
      getExtensionStorage(sidePanel, ['kiloAuth', 'kiloAgentConversations'])
    ).resolves.toStrictEqual({});
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('live local backend can stop a frontier response and continue chatting', async () => {
  const fixture = await startFixtureServer({ title: 'Kilo live manual stop target' });
  const outcomes: ChatRequestOutcome[] = [];
  const requests: ChatRequestSummary[] = [];
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  recordChatRequestOutcomes(context, outcomes);
  recordChatRequests(context, requests);

  try {
    const targetPage = await context.newPage();
    await targetPage.goto(fixture.url);

    const sidePanel = await context.newPage();
    await signInWithLocalDeviceAuth({ context, extensionId, sidePanel });
    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo live manual stop target');
    await selectFrontierModel(sidePanel);

    await sidePanel
      .getByLabel('Message agent')
      .fill('LOCAL_MANUAL_STOP: write a very long answer with at least 1500 words.');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByRole('button', { exact: true, name: 'Stop' })).toBeVisible();
    await sidePanel.getByRole('button', { exact: true, name: 'Stop' }).click();
    await expect(sidePanel.getByText('Stopped.')).toBeVisible({ timeout: 30_000 });
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeVisible();

    await expect.poll(() => outcomes.length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(outcomes.some(outcome => outcome.status === 'failed')).toBe(true);

    await sidePanel.getByLabel('Message agent').fill('LOCAL_MANUAL_STOP_FOLLOWUP: reply briefly.');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeVisible({
      timeout: 120_000,
    });

    expect(
      requests.some(
        request =>
          request.model === frontierModel &&
          request.lastUserContent?.includes('LOCAL_MANUAL_STOP_FOLLOWUP') === true
      )
    ).toBe(true);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('live local backend recovers after side panel reload during an active request', async () => {
  const fixture = await startFixtureServer({ title: 'Kilo live reload recovery target' });
  const outcomes: ChatRequestOutcome[] = [];
  const requests: ChatRequestSummary[] = [];
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  recordChatRequestOutcomes(context, outcomes);
  recordChatRequests(context, requests);

  try {
    const targetPage = await context.newPage();
    await targetPage.goto(fixture.url);

    const sidePanel = await context.newPage();
    await signInWithLocalDeviceAuth({ context, extensionId, sidePanel });
    await expect(sidePanel.getByLabel('Target tab')).toContainText(
      'Kilo live reload recovery target'
    );
    await selectFrontierModel(sidePanel);

    await sidePanel
      .getByLabel('Message agent')
      .fill('LOCAL_RELOAD_ABORT: write a very long answer with at least 1500 words.');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByRole('button', { name: 'Stop' })).toBeVisible();
    await waitForStoredConversationSnapshot(sidePanel, snapshot =>
      snapshot.includes('LOCAL_RELOAD_ABORT')
    );

    await sidePanel.reload();
    await expect(sidePanel.getByLabel('Message agent')).toBeVisible({ timeout: 30_000 });
    await expect(
      sidePanel.getByLabel('Agent conversation').getByText('LOCAL_RELOAD_ABORT')
    ).toBeVisible();
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeVisible();
    await expect(sidePanel.getByLabel('Model')).toHaveValue(frontierModel);
    await expect(
      getExtensionStorage(sidePanel, ['kiloAuth', 'kiloAgentConversations'])
    ).resolves.toHaveProperty('kiloAuth');

    await expect.poll(() => outcomes.length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(outcomes.some(outcome => outcome.status === 'failed')).toBe(true);

    await sidePanel.getByLabel('Message agent').fill('LOCAL_RELOAD_FOLLOWUP: reply briefly.');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeVisible({
      timeout: 120_000,
    });

    expect(
      requests.some(
        request =>
          request.model === frontierModel &&
          request.lastUserContent?.includes('LOCAL_RELOAD_FOLLOWUP') === true
      )
    ).toBe(true);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('live local backend keeps real tool rows from overlapping', async () => {
  const fixture = await startFixtureServer({ title: 'Kilo live tool spacing target' });
  const requests: ChatRequestSummary[] = [];
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  recordChatRequests(context, requests);

  try {
    const targetPage = await context.newPage();
    await targetPage.goto(fixture.url);

    const sidePanel = await context.newPage();
    await signInWithLocalDeviceAuth({ context, extensionId, sidePanel });
    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo live tool spacing target');
    await selectFrontierModel(sidePanel);
    await startConversationGapSampler(sidePanel);

    await sidePanel
      .getByLabel('Message agent')
      .fill(
        'LOCAL_TOOL_SPACING: use get_page_snapshot and get_viewport_screenshot before answering. Keep the final answer short.'
      );
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeVisible({
      timeout: 120_000,
    });

    expect(requests.some(request => request.model === frontierModel)).toBe(true);
    expect(requests.some(request => request.toolNames.includes('get_viewport_screenshot'))).toBe(
      true
    );
    expect(await getMinConversationGap(sidePanel)).toBeGreaterThanOrEqual(0);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('live local backend preserves and deletes frontier conversations through history', async () => {
  const fixture = await startFixtureServer({ title: 'Kilo live history target' });
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    const targetPage = await context.newPage();
    await targetPage.goto(fixture.url);

    const sidePanel = await context.newPage();
    await signInWithLocalDeviceAuth({ context, extensionId, sidePanel });
    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo live history target');
    await selectFrontierModel(sidePanel);

    await sidePanel.getByLabel('Message agent').fill('LOCAL_HISTORY_REOPEN: reply briefly.');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeVisible({
      timeout: 120_000,
    });
    await waitForStoredConversationSnapshot(sidePanel, snapshot =>
      snapshot.includes('LOCAL_HISTORY_REOPEN')
    );

    await sidePanel.getByLabel('New conversation').click();
    await sidePanel.getByLabel('Message agent').fill('LOCAL_HISTORY_DELETE: reply briefly.');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeVisible({
      timeout: 120_000,
    });
    await waitForStoredConversationSnapshot(sidePanel, snapshot =>
      snapshot.includes('LOCAL_HISTORY_DELETE')
    );

    sidePanel.once('dialog', dialog => {
      expect(dialog.message()).toContain('Close this conversation tab?');
      void dialog.accept();
    });
    await sidePanel.getByLabel(/Close LOCAL_HISTORY_DELETE/u).click();
    await expect(sidePanel.getByRole('tab', { name: /LOCAL_HISTORY_DELETE/u })).toBeHidden();

    await sidePanel.getByRole('button', { exact: true, name: 'History' }).click();
    await sidePanel.getByLabel(/Delete LOCAL_HISTORY_DELETE/u).click();
    await expect(sidePanel.getByLabel(/Open LOCAL_HISTORY_DELETE/u)).toBeHidden();
    await sidePanel.getByLabel('Close history').click();

    sidePanel.once('dialog', dialog => {
      expect(dialog.message()).toContain('Close this conversation tab?');
      void dialog.accept();
    });
    await sidePanel.getByLabel(/Close LOCAL_HISTORY_REOPEN/u).click();
    await expect(sidePanel.getByRole('tab', { name: /LOCAL_HISTORY_REOPEN/u })).toBeHidden();

    await sidePanel.getByRole('button', { exact: true, name: 'History' }).click();
    await sidePanel.getByLabel(/Open LOCAL_HISTORY_REOPEN/u).click();
    await expect(sidePanel.getByRole('tab', { name: /LOCAL_HISTORY_REOPEN/u })).toBeVisible();
    await expect(
      sidePanel.getByLabel('Agent conversation').getByText('LOCAL_HISTORY_REOPEN')
    ).toBeVisible();
    await waitForStoredConversationSnapshot(
      sidePanel,
      snapshot =>
        snapshot.includes('LOCAL_HISTORY_REOPEN') && !snapshot.includes('LOCAL_HISTORY_DELETE')
    );

    const storageSnapshot = JSON.stringify(
      await getExtensionStorage(sidePanel, ['kiloAgentConversations'])
    );

    expect(storageSnapshot).toContain('LOCAL_HISTORY_REOPEN');
    expect(storageSnapshot).not.toContain('LOCAL_HISTORY_DELETE');
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('live local backend dangerous mode eval can update the selected page', async () => {
  const fixture = await startFixtureServer({ title: 'Kilo live eval target' });
  const requests: ChatRequestSummary[] = [];
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  recordChatRequests(context, requests);

  try {
    const targetPage = await context.newPage();
    await targetPage.goto(fixture.url);

    const sidePanel = await context.newPage();
    await signInWithLocalDeviceAuth({ context, extensionId, sidePanel });
    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo live eval target');
    await selectFrontierModel(sidePanel);
    await sidePanel.getByLabel('Target tab').selectOption({ label: 'Kilo live eval target' });
    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo live eval target');
    await sidePanel.getByLabel(/Safe mode/u).click();
    await sidePanel.getByRole('button', { name: /Dangerous/u }).click();

    await sidePanel
      .getByLabel('Message agent')
      .fill(
        'LOCAL_DANGEROUS_EVAL: use eval to run exactly this JavaScript in the selected page, then reply briefly with the resulting value: document.body.dataset.kiloLiveEval = "done"; return document.body.dataset.kiloLiveEval;'
      );
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByText('eval completed')).toBeVisible({ timeout: 120_000 });
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeVisible({
      timeout: 120_000,
    });

    await expect
      .poll(() => targetPage.evaluate(() => document.body.dataset['kiloLiveEval']))
      .toBe('done');
    expect(
      requests.some(
        request =>
          request.model === frontierModel &&
          request.lastUserContent?.includes('LOCAL_DANGEROUS_EVAL') === true &&
          request.toolNames.includes('eval')
      )
    ).toBe(true);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('live local backend manual Compact now compacts a frontier conversation', async () => {
  const fixture = await startFixtureServer({ title: 'Kilo live compaction target' });
  const requests: ChatRequestSummary[] = [];
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  recordChatRequests(context, requests);

  try {
    const targetPage = await context.newPage();
    await targetPage.goto(fixture.url);

    const sidePanel = await context.newPage();
    await signInWithLocalDeviceAuth({ context, extensionId, sidePanel });
    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo live compaction target');
    await selectFrontierModel(sidePanel);

    const messageInput = sidePanel.getByLabel('Message agent');

    /*
     * A short two-exchange conversation: manual "Compact now" summarizes the whole conversation, so
     * it still compacts. (With the auto threshold this little history would be inert.)
     */
    for (const text of [
      'COMPACT_ONE: reply with one short sentence.',
      'COMPACT_TWO: reply with one short sentence.',
    ]) {
      await messageInput.fill(text);
      await messageInput.press('Enter');
      await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeVisible({
        timeout: 120_000,
      });
    }

    const donut = sidePanel.getByLabel(/^Context usage:/u);
    await expect(donut).toBeVisible();
    await donut.click();
    const compactButton = sidePanel.getByRole('button', { name: 'Compact now' });

    await expect(compactButton).toBeEnabled();
    await compactButton.click();

    await waitForStoredConversationSnapshot(sidePanel, snapshot =>
      snapshot.includes('Compacted earlier context')
    );

    // The summarization request goes out with no tools (tool_choice: 'none').
    expect(
      requests.some(request => request.model === frontierModel && request.toolNames.length === 0)
    ).toBe(true);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
