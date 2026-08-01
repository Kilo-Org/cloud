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
      sidePanel.getByText('No sessions yet. Create your first cloud session!')
    ).toBeVisible();
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
    await expect(sidePanel.getByText('Cloud')).toBeVisible();

    // History section
    await expect(sidePanel.getByText('Refactor auth module')).toBeVisible();
    // The null-title history session renders "New session" as the row title.
    // Use the button accessible name which includes the relative time.
    await expect(sidePanel.getByRole('button', { name: /New session \d+d ago/ })).toBeVisible();
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
  const { cleanup, getSidePanel, mockResult } = await setupAgentsTest();
  try {
    const sidePanel = await getSidePanel();
    await navigateToAgentsMode(sidePanel);
    await sidePanel.getByText('Fix login bug').click();
    await expect(sidePanel.getByLabel('Back to sessions')).toBeVisible({ timeout: 10_000 });

    // Send a message
    const composer = sidePanel.locator('#agents-message');
    await composer.fill('Check the tests');
    await composer.press('Enter');

    // After stream completes, composer reverts to Send
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeVisible({
      timeout: 10_000,
    });

    // Prove the sendMessage mutation fired with the expected payload shape.
    // Poll to avoid a race: the composer reverts to "Send message" before the
    // Async sendMessage mutation reaches the mock's calledProcedures array.
    const sendProcNames = [
      'cloudAgentNext.sendMessage',
      'organizations.cloudAgentNext.sendMessage',
    ] as const;
    await expect
      .poll(
        () =>
          mockResult.calledProcedures.filter(call =>
            (sendProcNames as readonly string[]).includes(call.proc)
          ).length,
        { timeout: 10_000 }
      )
      .toBe(1);
    const sendCall = mockResult.calledProcedures.find(
      call =>
        call.proc === 'cloudAgentNext.sendMessage' ||
        call.proc === 'organizations.cloudAgentNext.sendMessage'
    );
    expect(sendCall?.input).toMatchObject({
      autoCommit: true,
      cloudAgentSessionId: 'agent_11111111-1111-4111-8111-111111111111',
      messageId: expect.any(String),
      payload: {
        mode: expect.any(String),
        model: expect.any(String),
        prompt: 'Check the tests',
        type: 'prompt',
      },
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
    await expect(sidePanel.getByText('New Cloud Session')).toBeVisible({ timeout: 10_000 });

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
    await expect(sidePanel.getByText('New Cloud Session')).toBeVisible({ timeout: 10_000 });

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
      await expect(sidePanel.getByRole('link', { name: 'Add credits' })).toBeVisible();
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
        `Error text not found. Back button visible: ${String(foundBack)}. Generic error visible: ${String(foundGeneric)}. prepareSession calls: ${JSON.stringify(prepareCalls)}. All calls: ${mockResult.calledProcedures.length}`
      );
    }
  } finally {
    await cleanup();
  }
});
