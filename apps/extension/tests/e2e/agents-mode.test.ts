/* eslint-disable import/no-nodejs-modules, jest/no-conditional-in-test, max-lines */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import {
  launchExtensionContext,
  seedExtensionAuth,
  startFixtureServer,
} from './extension-context-fixture';
import {
  buildPermissionCloudAgentStream,
  buildQuestionCloudAgentStream,
  buildRunningCloudAgentStream,
  DEFAULT_CLOUD_SESSION,
  DEFAULT_INSTANCE,
  DEFAULT_REMOTE_SESSION,
  mockAgentsApi,
  navigateToAgentsMode,
} from './agents-fixture';
import type { AgentsFixtureOptions } from './agents-fixture';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const setupAgentsTest = async (mockOptions?: AgentsFixtureOptions) => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  // Install default mock before page creation so Settings always appears.
  const mockResult = await mockAgentsApi(context, mockOptions);

  // eslint-disable-next-line init-declarations
  let sidePanel: Awaited<ReturnType<(typeof context)['newPage']>>;

  return {
    cleanup: async () => {
      await context.close();
      await fixture.close();
      await rm(userDataDir, { force: true, recursive: true });
    },
    context,
    extensionId,
    fixture,
    getSidePanel: async () => {
      sidePanel = await context.newPage();
      await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      await seedExtensionAuth(sidePanel);
      await sidePanel.reload();
      await expect(sidePanel.getByLabel('Settings')).toBeVisible({ timeout: 15_000 });
      return sidePanel;
    },
    mockResult,
    userDataDir,
  };
};

// ---------------------------------------------------------------------------
// 1. Mode switch is visible, Agents persists through reload, Browser usable
// ---------------------------------------------------------------------------

test('Agents mode tab is visible and can switch between modes', async () => {
  const { cleanup, getSidePanel } = await setupAgentsTest();
  try {
    const sidePanel = await getSidePanel();

    // Default is Browser mode
    await expect(sidePanel.getByRole('tab', { name: 'Browser', selected: true })).toBeVisible();
    await expect(sidePanel.getByRole('tab', { name: 'Agents' })).toBeVisible();
    await expect(sidePanel.getByLabel('Message agent')).toBeVisible();

    // Switch to Agents mode
    await navigateToAgentsMode(sidePanel);
    await expect(sidePanel.getByRole('button', { exact: true, name: 'New session' })).toBeVisible();
    await expect(sidePanel.getByLabel('Message agent')).toBeHidden();

    // Switch back to Browser
    await sidePanel.getByRole('tab', { name: 'Browser' }).click();
    await expect(sidePanel.getByLabel('Message agent')).toBeVisible({ timeout: 10_000 });
  } finally {
    await cleanup();
  }
});

test('Agents mode persists active state through side panel reload', async () => {
  const { cleanup, getSidePanel } = await setupAgentsTest();
  try {
    const sidePanel = await getSidePanel();

    await navigateToAgentsMode(sidePanel);
    await expect(sidePanel.getByRole('button', { exact: true, name: 'New session' })).toBeVisible();

    // Reload — Agents mode must persist
    await sidePanel.reload();
    await expect(sidePanel.getByRole('tab', { name: 'Agents', selected: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(sidePanel.getByRole('button', { exact: true, name: 'New session' })).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. List: empty, populated, and retryable error
// ---------------------------------------------------------------------------

test('Agents list shows empty state when no sessions exist', async () => {
  const { cleanup, getSidePanel } = await setupAgentsTest({
    activeSessions: [],
    historySessions: [],
  });
  try {
    const sidePanel = await getSidePanel();
    await navigateToAgentsMode(sidePanel);

    await expect(sidePanel.getByText('No active sessions')).toBeVisible();
    await expect(
      sidePanel.getByText('No sessions yet. Start your first session above.')
    ).toBeVisible();
    // With zero sessions and no query there is nothing to search.
    await expect(sidePanel.getByLabel('Search sessions')).toBeHidden();
  } finally {
    await cleanup();
  }
});

test('Agents list shows populated active and history sessions', async () => {
  const { cleanup, getSidePanel } = await setupAgentsTest();
  try {
    const sidePanel = await getSidePanel();
    await navigateToAgentsMode(sidePanel);

    // Active section
    await expect(sidePanel.getByText('Fix login bug')).toBeVisible();
    await expect(sidePanel.getByText('Running')).toBeVisible();
    // Platform markers: cloud icon on the cloud row, terminal icon on the CLI row.
    await expect(sidePanel.getByLabel('Cloud agent')).toBeVisible();
    await expect(sidePanel.getByLabel('CLI')).toBeVisible();
    // The CLI row's raw status renders capitalized.
    await expect(sidePanel.getByText('Idle')).toBeVisible();
    // Repo and branch join with a separator, host prefix stripped.
    await expect(sidePanel.getByText('org/repo · fix/login')).toBeVisible();

    // History section
    await expect(sidePanel.getByText('Refactor auth module')).toBeVisible();
    // The null-title history session renders a muted "Untitled session" title.
    await expect(
      sidePanel.getByRole('button', { name: /Untitled session \d+d ago/ })
    ).toBeVisible();
  } finally {
    await cleanup();
  }
});

test('Agents active list shows retryable error and recovers', async () => {
  const { cleanup, getSidePanel } = await setupAgentsTest({
    activeListFailuresBeforeSuccess: 1,
  });
  try {
    const sidePanel = await getSidePanel();
    await navigateToAgentsMode(sidePanel);

    // Error state visible
    await expect(sidePanel.getByText('Failed to load active sessions')).toBeVisible();
    const retryButton = sidePanel.getByRole('button', { name: 'Retry' });
    await expect(retryButton).toBeVisible();

    // Retry → recovers
    await retryButton.click();
    await expect(sidePanel.getByText('Fix login bug')).toBeVisible({ timeout: 10_000 });
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. Open cloud session: transcript/stream; send; interrupt; permission & question
// ---------------------------------------------------------------------------

test('Agents opens a cloud session and streams the transcript', async () => {
  const { cleanup, getSidePanel } = await setupAgentsTest();
  try {
    const sidePanel = await getSidePanel();
    await navigateToAgentsMode(sidePanel);

    // Open cloud session
    await sidePanel.getByText('Fix login bug').click();
    await expect(sidePanel.getByLabel('Back to sessions')).toBeVisible({ timeout: 10_000 });

    // Title in header
    await expect(sidePanel.getByRole('heading', { name: 'Fix login bug' })).toBeVisible();

    // Transcript messages appear from the WebSocket stream
    await expect(sidePanel.getByText('Fix the login bug')).toBeVisible({ timeout: 10_000 });
    await expect(sidePanel.getByText('I found the issue.')).toBeVisible({ timeout: 10_000 });
  } finally {
    await cleanup();
  }
});

test('Agents can send a message on a cloud session', async () => {
  const { cleanup, getSidePanel } = await setupAgentsTest();
  try {
    const sidePanel = await getSidePanel();
    await navigateToAgentsMode(sidePanel);
    await sidePanel.getByText('Fix login bug').click();
    await expect(sidePanel.getByLabel('Back to sessions')).toBeVisible({ timeout: 10_000 });

    // Send a message
    const composer = sidePanel.locator('#agents-message');
    await composer.fill('Check the tests');
    await composer.press('Enter');
    await expect(composer).toHaveValue('');

    // After stream completes, composer reverts to Send
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await cleanup();
  }
});

test('Agents can interrupt a running cloud session', async () => {
  const { cleanup, getSidePanel, mockResult } = await setupAgentsTest({
    cloudAgentWsEvents: buildRunningCloudAgentStream(DEFAULT_CLOUD_SESSION.kiloSessionId),
  });
  try {
    const sidePanel = await getSidePanel();
    await navigateToAgentsMode(sidePanel);
    await sidePanel.getByText('Fix login bug').click();
    await expect(sidePanel.getByLabel('Back to sessions')).toBeVisible({ timeout: 10_000 });

    // Session is running — Stop button is visible
    const stopButton = sidePanel.getByRole('button', { name: 'Stop' });
    await expect(stopButton).toBeVisible({ timeout: 10_000 });

    // Click Stop
    await stopButton.click();

    // After interrupt, composer reverts to Send message
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeVisible({
      timeout: 10_000,
    });

    // Prove interruptSession mutation fired
    const interruptCalls = mockResult.calledProcedures.filter(
      call =>
        call.proc === 'cloudAgentNext.interruptSession' ||
        call.proc === 'organizations.cloudAgentNext.interruptSession'
    );
    expect(interruptCalls.length).toBe(1);
    expect(interruptCalls[0]?.input).toMatchObject({
      sessionId: 'agent_11111111-1111-4111-8111-111111111111',
    });
  } finally {
    await cleanup();
  }
});

test('Agents cloud session shows question card and can answer', async () => {
  const { cleanup, getSidePanel, mockResult } = await setupAgentsTest({
    cloudAgentWsEvents: buildQuestionCloudAgentStream(DEFAULT_CLOUD_SESSION.kiloSessionId),
  });
  try {
    const sidePanel = await getSidePanel();
    await navigateToAgentsMode(sidePanel);
    await sidePanel.getByText('Fix login bug').click();
    await expect(sidePanel.getByLabel('Back to sessions')).toBeVisible({ timeout: 10_000 });

    // Question card appears
    await expect(sidePanel.getByText('Deployment target')).toBeVisible({ timeout: 10_000 });
    await expect(sidePanel.getByText('Which environment?')).toBeVisible();

    // Pick an option
    await sidePanel.getByRole('button', { name: /Staging/ }).click();
    await expect(sidePanel.getByText('Selected: Staging')).toBeVisible();

    // Answer
    await sidePanel.getByRole('button', { name: 'Answer' }).click();

    // Prove answerQuestion mutation fired
    const answerCalls = mockResult.calledProcedures.filter(
      call =>
        call.proc === 'cloudAgentNext.answerQuestion' ||
        call.proc === 'organizations.cloudAgentNext.answerQuestion'
    );
    expect(answerCalls.length).toBe(1);
    expect(answerCalls[0]?.input).toMatchObject({
      questionId: 'q-1',
      sessionId: 'agent_11111111-1111-4111-8111-111111111111',
    });
  } finally {
    await cleanup();
  }
});

test('Agents cloud session shows permission card and can respond', async () => {
  const { cleanup, getSidePanel, mockResult } = await setupAgentsTest({
    cloudAgentWsEvents: buildPermissionCloudAgentStream(DEFAULT_CLOUD_SESSION.kiloSessionId),
  });
  try {
    const sidePanel = await getSidePanel();
    await navigateToAgentsMode(sidePanel);
    await sidePanel.getByText('Fix login bug').click();
    await expect(sidePanel.getByLabel('Back to sessions')).toBeVisible({ timeout: 10_000 });

    // Permission card appears
    await expect(sidePanel.getByText('Permission required')).toBeVisible({ timeout: 10_000 });
    await expect(sidePanel.getByText('read /app/.env.production')).toBeVisible();

    // Respond: "Yes, once"
    const yesOnce = sidePanel.getByRole('button', { name: 'Yes, once' });
    await expect(yesOnce).toBeVisible();
    await yesOnce.click();

    // Prove answerPermission mutation fired
    const permCalls = mockResult.calledProcedures.filter(
      call =>
        call.proc === 'cloudAgentNext.answerPermission' ||
        call.proc === 'organizations.cloudAgentNext.answerPermission'
    );
    expect(permCalls.length).toBe(1);
    expect(permCalls[0]?.input).toMatchObject({
      permissionId: 'perm-1',
      response: 'once',
      sessionId: 'agent_11111111-1111-4111-8111-111111111111',
    });
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. Open remote CLI session (interactive) and history session (read-only)
// ---------------------------------------------------------------------------

test('Agents opens an active remote CLI session and shows interactive controls', async () => {
  const { cleanup, getSidePanel } = await setupAgentsTest({
    activeSessions: [DEFAULT_REMOTE_SESSION],
    // No null-title history row to cause strict mode in navigateToAgentsMode.
    historySessions: [],
  });
  try {
    const sidePanel = await getSidePanel();
    await navigateToAgentsMode(sidePanel);

    // Active section shows the remote session
    await expect(sidePanel.getByText('Deploy to staging')).toBeVisible();

    // Open the remote session
    await sidePanel.getByText('Deploy to staging').click();
    await expect(sidePanel.getByLabel('Back to sessions')).toBeVisible({ timeout: 10_000 });

    // Active remote session is NOT read-only — composer is interactive.
    await expect(sidePanel.getByText('This session is read-only')).toBeHidden();
    await expect(sidePanel.locator('#agents-message')).toBeVisible({ timeout: 10_000 });
  } finally {
    await cleanup();
  }
});

test('Agents opens a historical-only session and shows read-only state', async () => {
  const { cleanup, getSidePanel } = await setupAgentsTest();
  try {
    const sidePanel = await getSidePanel();
    await navigateToAgentsMode(sidePanel);

    // Open a history session that is not in active sessions.
    // DEFAULT_HISTORY_SESSION_1 ("Refactor auth module") is only in historySessions.
    await sidePanel.getByText('Refactor auth module').click();
    await expect(sidePanel.getByLabel('Back to sessions')).toBeVisible({ timeout: 10_000 });

    // Historical session resolves as read-only (no live transport).
    await expect(sidePanel.getByText('This session is read-only')).toBeVisible({ timeout: 10_000 });
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. Create session: happy path and 402/insufficient credits
// ---------------------------------------------------------------------------

test('Agents new session shows the create form and navigates to the new session on success', async () => {
  const { cleanup, getSidePanel } = await setupAgentsTest();
  try {
    const sidePanel = await getSidePanel();
    await navigateToAgentsMode(sidePanel);

    // Click "New session"
    await sidePanel.getByRole('button', { exact: true, name: 'New session' }).click();
    await expect(sidePanel.getByText('New session', { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    // Fill the form
    const promptArea = sidePanel.getByLabel('What would you like to do?');
    await promptArea.fill('Fix the login page');
    await expect(promptArea).toHaveValue('Fix the login page');

    // Select model (already auto-selected)
    // Select repo (already auto-selected if only one)
    await sidePanel.waitForTimeout(500);

    // Submit
    const startButton = sidePanel.getByRole('button', { name: 'Start session' });
    await expect(startButton).toBeEnabled();
    await startButton.click();

    // After creation, navigated to the session view
    await expect(sidePanel.getByLabel('Back to sessions')).toBeVisible({ timeout: 15_000 });
    // The created session's title is shown in the header
    await expect(sidePanel.getByRole('heading', { name: 'Test Session' })).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await cleanup();
  }
});

test('Agents new session shows credits error (402) with Add credits CTA', async () => {
  const { cleanup, getSidePanel, mockResult } = await setupAgentsTest({
    prepareSessionError: {
      error: {
        code: -32_000,
        data: { code: 'PAYMENT_REQUIRED', httpStatus: 402 },
        message: 'Insufficient credits',
      },
    },
    prepareSessionStatusCode: 402,
  });
  try {
    const sidePanel = await getSidePanel();
    await navigateToAgentsMode(sidePanel);

    await sidePanel.getByRole('button', { exact: true, name: 'New session' }).click();
    await expect(sidePanel.getByText('New session', { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    const promptArea = sidePanel.getByLabel('What would you like to do?');
    await promptArea.fill('Fix the login page');
    await sidePanel.waitForTimeout(500);

    const startButton = sidePanel.getByRole('button', { name: 'Start session' });
    await expect(startButton).toBeEnabled();
    await startButton.click();

    // Error appears with Add credits CTA
    // Try to determine if we navigate to session view or stay on form.
    const backButton = sidePanel.getByLabel('Back to sessions');
    const errorText = sidePanel.getByText(/insufficient credits/i);
    const genericError = sidePanel.getByText('Session creation failed');
    try {
      await errorText.waitFor({ timeout: 5000 });
    } catch {
      // If error text not found, check what IS visible
      const foundBack = await backButton.isVisible().catch(() => false);
      const foundGeneric = await genericError.isVisible().catch(() => false);
      const prepareCalls = mockResult.calledProcedures.filter(
        call =>
          call.proc === 'cloudAgentNext.prepareSession' ||
          call.proc === 'organizations.cloudAgentNext.prepareSession'
      );
      throw new Error(
        `Credits error text not found. Back button visible: ${String(foundBack)}. Generic error visible: ${String(foundGeneric)}. prepareSession calls: ${JSON.stringify(prepareCalls)}. All calls: ${mockResult.calledProcedures.length}`
      );
    }
    await expect(sidePanel.getByRole('link', { name: 'Add credits' })).toBeVisible({
      timeout: 5000,
    });
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6. Feature matrix — history errors, session-load retry, prepare retry, CLI
//    Spawn, PR link, working indicator, queued send, auto-scroll, offline
//    Grace, GitHub not connected
// ---------------------------------------------------------------------------

test('Agents history list shows retryable error and recovers', async () => {
  const { cleanup, getSidePanel } = await setupAgentsTest({
    historyListFailuresBeforeSuccess: 1,
  });
  try {
    const sidePanel = await getSidePanel();
    await navigateToAgentsMode(sidePanel);

    await expect(sidePanel.getByText('Failed to load sessions')).toBeVisible({ timeout: 10_000 });
    await sidePanel.getByRole('button', { name: 'Retry' }).click();
    await expect(sidePanel.getByText('Refactor auth module')).toBeVisible({ timeout: 10_000 });
  } finally {
    await cleanup();
  }
});

test('Agents session view load failure shows Retry and recovers', async () => {
  const { cleanup, getSidePanel } = await setupAgentsTest({
    getSessionFailuresBeforeSuccess: 1,
  });
  try {
    const sidePanel = await getSidePanel();
    await navigateToAgentsMode(sidePanel);
    await sidePanel.getByText('Fix login bug').click();

    const retryButton = sidePanel.getByRole('button', { name: 'Retry' });
    await expect(retryButton).toBeVisible({ timeout: 15_000 });
    await retryButton.click();

    // Recovered: transcript streams from the mocked cloud-agent socket.
    await expect(sidePanel.getByText('I found the issue.')).toBeVisible({ timeout: 15_000 });
  } finally {
    await cleanup();
  }
});

test('Agents new session retries a failed prepare and succeeds', async () => {
  const { cleanup, getSidePanel } = await setupAgentsTest({
    prepareSessionFailuresBeforeSuccess: 1,
  });
  try {
    const sidePanel = await getSidePanel();
    await navigateToAgentsMode(sidePanel);

    await sidePanel.getByRole('button', { exact: true, name: 'New session' }).click();
    await sidePanel.getByLabel('What would you like to do?').fill('Fix the login page');
    await sidePanel.waitForTimeout(500);
    await sidePanel.getByRole('button', { name: 'Start session' }).click();

    // Retryable failure shows the banner with a Retry CTA.
    const retryButton = sidePanel.getByRole('button', { name: 'Retry' });
    await expect(retryButton).toBeVisible({ timeout: 10_000 });
    await retryButton.click();

    // Second attempt succeeds and navigates into the session.
    await expect(sidePanel.getByLabel('Back to sessions')).toBeVisible({ timeout: 15_000 });
  } finally {
    await cleanup();
  }
});

test('Agents new session spawns onto a connected CLI instance', async () => {
  const { cleanup, getSidePanel, mockResult } = await setupAgentsTest({
    instances: [DEFAULT_INSTANCE],
  });
  try {
    const sidePanel = await getSidePanel();
    await navigateToAgentsMode(sidePanel);

    await sidePanel.getByRole('button', { exact: true, name: 'New session' }).click();
    await sidePanel.getByLabel('What would you like to do?').fill('Run the test suite');

    // Pick the CLI instance as the run target.
    const runOn = sidePanel.getByLabel('Run on');
    await expect(runOn).toBeVisible({ timeout: 10_000 });
    await runOn.selectOption(DEFAULT_INSTANCE.connectionId);

    // Cloud-only pickers leave the form; the CLI hint appears.
    await expect(sidePanel.getByLabel('Model', { exact: true })).toBeHidden();
    await expect(sidePanel.getByLabel('Select repository')).toBeHidden();
    await expect(sidePanel.getByText(/Runs in cloud/)).toBeVisible();

    await sidePanel.getByRole('button', { name: 'Start session' }).click();

    // The spawn command goes out on the user-web socket and the view
    // Navigates to the spawned session.
    await expect(sidePanel.getByLabel('Back to sessions')).toBeVisible({ timeout: 15_000 });
    const spawnCommands = mockResult.ingestClientMessages.filter(
      message =>
        typeof message === 'object' &&
        message !== null &&
        (message as { command?: string }).command === 'create_session'
    );
    expect(spawnCommands.length).toBeGreaterThan(0);
    await expect(sidePanel.getByRole('heading', { name: 'Spawned session' })).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await cleanup();
  }
});

test('Agents session header links the associated PR', async () => {
  const { cleanup, getSidePanel } = await setupAgentsTest({
    cloudSessionAssociatedPr: {
      headSha: 'abc123',
      lastSyncedAt: new Date().toISOString(),
      number: 512,
      state: 'open',
      title: 'Fix login bug',
      url: 'https://github.com/org/repo/pull/512',
    },
  });
  try {
    const sidePanel = await getSidePanel();
    await navigateToAgentsMode(sidePanel);
    await sidePanel.getByText('Fix login bug').click();

    const prLink = sidePanel.getByLabel('Open pull request #512');
    await expect(prLink).toBeVisible({ timeout: 15_000 });
    await expect(prLink).toHaveAttribute('href', 'https://github.com/org/repo/pull/512');
  } finally {
    await cleanup();
  }
});

test('Agents session shows a working indicator while the agent runs without output', async () => {
  const { cleanup, getSidePanel } = await setupAgentsTest({
    cloudAgentWsEvents: buildRunningCloudAgentStream(),
  });
  try {
    const sidePanel = await getSidePanel();
    await navigateToAgentsMode(sidePanel);
    await sidePanel.getByText('Fix login bug').click();

    await expect(sidePanel.getByText('Working…')).toBeVisible({ timeout: 15_000 });
  } finally {
    await cleanup();
  }
});

test('Agents composer queues a send while the agent runs', async () => {
  const { cleanup, getSidePanel, mockResult } = await setupAgentsTest({
    cloudAgentWsEvents: buildRunningCloudAgentStream(),
  });
  try {
    const sidePanel = await getSidePanel();
    await navigateToAgentsMode(sidePanel);
    await sidePanel.getByText('Fix login bug').click();

    const composer = sidePanel.getByLabel('Message agent');
    await expect(composer).toBeVisible({ timeout: 15_000 });
    // The run is live: the Stop control is present while we queue a send.
    await expect(sidePanel.getByRole('button', { name: 'Stop' })).toBeVisible({
      timeout: 15_000,
    });
    await composer.fill('Also update the changelog');
    await composer.press('Enter');

    // The draft clears and the send reaches the API despite the run.
    await expect(composer).toHaveValue('', { timeout: 10_000 });
    await expect
      .poll(
        () => mockResult.calledProcedures.filter(call => call.proc.includes('sendMessage')).length,
        { timeout: 10_000 }
      )
      .toBeGreaterThan(0);
  } finally {
    await cleanup();
  }
});

test('Agents session transcript opens pinned to the bottom', async () => {
  const sessionId = 'ses_cloudsession00000000001';
  let eventCounter = 0;
  const ev = (streamEventType: string, data: unknown): Record<string, unknown> => ({
    data,
    eventId: ++eventCounter,
    executionId: 'exec-scroll',
    sessionId,
    streamEventType,
    timestamp: new Date().toISOString(),
  });
  const kilocode = (type: string, properties: unknown): Record<string, unknown> =>
    ev('kilocode', { properties, type });
  const events: Record<string, unknown>[] = [
    kilocode('session.created', { info: { id: sessionId } }),
  ];
  for (let index = 1; index <= 12; index++) {
    events.push(
      kilocode('message.updated', {
        info: {
          agent: 'build',
          cost: 0,
          id: `msg-${String(index).padStart(3, '0')}`,
          mode: 'code',
          modelID: 'm',
          path: { cwd: '/', root: '/' },
          providerID: 'p',
          role: 'assistant',
          sessionID: sessionId,
          time: { completed: Date.now(), created: Date.now() },
          tokens: { cache: { read: 0, write: 0 }, input: 0, output: 0, reasoning: 0 },
        },
      }),
      kilocode('message.part.updated', {
        part: {
          id: `part-${String(index).padStart(3, '0')}`,
          messageID: `msg-${String(index).padStart(3, '0')}`,
          sessionID: sessionId,
          text: `Long transcript row ${index}: this line wraps across the panel and consumes vertical space so the list must scroll.`,
          type: 'text',
        },
      })
    );
  }
  events.push(ev('complete', { currentBranch: 'main' }));

  const { cleanup, getSidePanel } = await setupAgentsTest({ cloudAgentWsEvents: events });
  try {
    const sidePanel = await getSidePanel();
    await navigateToAgentsMode(sidePanel);
    await sidePanel.getByText('Fix login bug').click();
    await expect(sidePanel.getByText('Long transcript row 12', { exact: false })).toBeVisible({
      timeout: 15_000,
    });

    const scrollState = await sidePanel.evaluate(() => {
      const panes = document.querySelectorAll('.agent-conversation-scrollbar');
      const pane = [...panes].at(-1);
      if (!(pane instanceof HTMLElement)) {
        return null;
      }
      return {
        atBottom: pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 48,
        scrollable: pane.scrollHeight > pane.clientHeight,
      };
    });
    expect(scrollState).not.toBeNull();
    expect(scrollState!.scrollable).toBe(true);
    expect(scrollState!.atBottom).toBe(true);
  } finally {
    await cleanup();
  }
});

test('Agents offline pill waits out the connect grace period', async () => {
  const { cleanup, getSidePanel } = await setupAgentsTest({ ingestSilent: true });
  try {
    const sidePanel = await getSidePanel();
    await navigateToAgentsMode(sidePanel);

    // The mocked ingest socket never completes the connected handshake, so
    // The pill must stay hidden through the grace period and appear after.
    await expect(sidePanel.getByText('Offline')).toBeHidden();
    await expect(sidePanel.getByText('Offline')).toBeVisible({ timeout: 10_000 });
  } finally {
    await cleanup();
  }
});

test('Agents new session repo picker shows Connect GitHub when not installed', async () => {
  const { cleanup, getSidePanel } = await setupAgentsTest({ integrationInstalled: false });
  try {
    const sidePanel = await getSidePanel();
    await navigateToAgentsMode(sidePanel);

    await sidePanel.getByRole('button', { exact: true, name: 'New session' }).click();
    await sidePanel.getByLabel('Select repository').click();

    await expect(sidePanel.getByText('GitHub integration not connected')).toBeVisible({
      timeout: 10_000,
    });
    await expect(sidePanel.getByRole('link', { name: 'Connect GitHub' })).toBeVisible();
  } finally {
    await cleanup();
  }
});
