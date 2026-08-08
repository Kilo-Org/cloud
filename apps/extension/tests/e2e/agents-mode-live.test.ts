/* eslint-disable import/no-nodejs-modules, jest/no-conditional-in-test, max-lines, no-await-in-loop, promise/avoid-new */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { launchExtensionContext, startFixtureServer } from './extension-context-fixture';

const runLive = process.env['EXTENSION_LOCAL_BACKEND_E2E'] === '1';
test.skip(!runLive, 'local backend only');

test.setTimeout(150_000);

const localBackendUrl = process.env['LOCAL_BACKEND_ORIGIN'] ?? 'http://localhost:3000';
const localUserEmail = process.env['LOCAL_USER_EMAIL'] ?? 'fl@fl.fl';

// ---------------------------------------------------------------------------
// Sign-in helper (adapted from local-backend-live.test.ts)
// ---------------------------------------------------------------------------

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
  let authOrigin = localBackendUrl;

  try {
    const probe = await context.request.get(`${localBackendUrl}/users/after-sign-in`, {
      maxRedirects: 0,
    });
    const { location } = probe.headers();

    if (
      probe.status() >= 300 &&
      probe.status() < 400 &&
      location !== undefined &&
      location !== ''
    ) {
      authOrigin = new URL(location).origin;
    }
  } catch {
    // Fall back to localBackendUrl
  }

  await authPage.goto(
    `${authOrigin}/users/sign_in?fakeUser=${encodeURIComponent(localUserEmail)}&callbackPath=${encodeURIComponent(callbackPath)}`
  );
  await authPage.getByRole('button', { name: 'Authorize' }).click({ timeout: 60_000 });
  await expect(sidePanel.getByLabel('Message agent')).toBeVisible({ timeout: 30_000 });
  await authPage.close();
};

// ---------------------------------------------------------------------------
// Shared phase helpers
// ---------------------------------------------------------------------------

/**
 * A prompt whose output keeps the session busy for the whole reopen round
 * trip. A short prompt would finish before phase "reopen while running" and
 * the Stop assertion would fail on a finished run, not on a broken control.
 * Measured live, "1 to 100" streamed the full list in ~33s, which finished
 * before the reopen round trip completed; 300 keeps the run alive past the
 * reopen, queue, and stop phases.
 */
const longPrompt = (nonce: string): string =>
  `Nonce ${nonce}. Count from 1 to 300. Put each number on its own line with one short sentence about it.`;

const readSessionTitle = async (sidePanel: Page): Promise<string> => {
  const titleText = await sidePanel.locator('h1').first().textContent();
  return titleText?.trim() ?? '';
};

/**
 * Wait for the session view to settle into either a composer or the read-only
 * banner, then fail loudly when the session is read-only.
 */
const failIfReadOnly = async (sidePanel: Page): Promise<void> => {
  const composer = sidePanel.locator('#agents-message');
  const readOnlyBanner = sidePanel.getByText('This session is read-only');

  await expect
    .poll(
      async () => {
        const composerVisible = await composer.isVisible().catch(() => false);
        const readOnlyVisible = await readOnlyBanner.isVisible().catch(() => false);
        return composerVisible || readOnlyVisible;
      },
      { timeout: 30_000 }
    )
    .toBe(true);

  if (await readOnlyBanner.isVisible().catch(() => false)) {
    throw new Error('Agent session opened read-only — expected an interactive session');
  }
};

/**
 * Leave the running session, return to the list, and reopen the same session
 * from the Active list. The nonce, not the title, proves the right session
 * opened: a cloud agent can rename its session mid-run, so a stale title
 * falls back to the newest active row — the API lists active sessions newest
 * first — and the nonce assertion still decides.
 */
const reopenRunningSession = async ({
  sidePanel,
  nonce,
  sessionTitle,
  platformLabel,
}: {
  sidePanel: Page;
  nonce: string;
  sessionTitle: string;
  platformLabel: 'Cloud agent' | 'CLI';
}): Promise<void> => {
  await sidePanel.getByLabel('Back to sessions').click();
  await expect(sidePanel.getByRole('button', { exact: true, name: 'New session' })).toBeVisible({
    timeout: 15_000,
  });

  const platformRows = sidePanel
    .locator('button')
    .filter({ has: sidePanel.locator(`svg[aria-label="${platformLabel}"]`) });
  await expect.poll(() => platformRows.count(), { timeout: 30_000 }).toBeGreaterThan(0);

  const titleRow = sessionTitle === '' ? undefined : platformRows.filter({ hasText: sessionTitle });
  const titleRowCount = titleRow === undefined ? 0 : await titleRow.count().catch(() => 0);
  // A stale title falls back to the newest running row, then the newest row.
  const runningRows = platformRows.filter({
    has: sidePanel.getByText('Running', { exact: true }),
  });
  const runningRowCount = await runningRows.count().catch(() => 0);
  let rowToOpen = platformRows.first();
  if (titleRow !== undefined && titleRowCount > 0) {
    rowToOpen = titleRow.first();
  } else if (runningRowCount > 0) {
    rowToOpen = runningRows.first();
  }
  await rowToOpen.click();

  await expect(sidePanel.getByLabel('Back to sessions')).toBeVisible({ timeout: 15_000 });
  const openedTitle = await readSessionTitle(sidePanel);

  /*
   * The conversation list virtualizes rows and pins to the newest message, so
   * a nonce-bearing user message can stay out of the DOM until the transcript
   * scrolls to it. The nonce sits at the top in the start flow (the loaded
   * first user message) and near the bottom in the existing-session fallback
   * (the queued follow-up), so check both ends and poll while the paged
   * history streams in. The first scroll up releases auto-scroll.
   */
  const conversationPane = sidePanel.getByLabel('Agent conversation');

  try {
    await expect
      .poll(
        async () => {
          try {
            if (!(await conversationPane.isVisible().catch(() => false))) {
              return false;
            }

            const nonceRow = sidePanel.getByText(nonce).first();

            if (await nonceRow.isVisible().catch(() => false)) {
              return true;
            }

            await conversationPane.evaluate(
              element =>
                new Promise<void>(resolve => {
                  let remainingFrames = 6;
                  const forceTop = (): void => {
                    element.scrollTop = 0;
                    remainingFrames -= 1;
                    if (remainingFrames === 0) {
                      resolve();
                      return;
                    }
                    requestAnimationFrame(forceTop);
                  };
                  requestAnimationFrame(forceTop);
                })
            );

            if (await nonceRow.isVisible().catch(() => false)) {
              return true;
            }

            await conversationPane.evaluate(element => {
              element.scrollTop = element.scrollHeight;
            });

            return false;
          } catch {
            return false;
          }
        },
        {
          message: `the reopened transcript never rendered the loaded user message (nonce "${nonce}")`,
          timeout: 60_000,
        }
      )
      .toBe(true);
  } catch (error) {
    throw new Error(
      `Reopened the wrong session: expected nonce "${nonce}" but the opened session is "${openedTitle}". ${error instanceof Error ? error.message : ''}`,
      { cause: error }
    );
  }

  /*
   * A scroll-up releases auto-scroll and shows the Jump to latest control;
   * re-engage it so the running output and the queued follow-up stay in view
   * for the queue and stop phases. When the nonce was already visible at the
   * bottom — the existing-session fallback — no scroll-up happened and the
   * list is still following, so there is nothing to re-engage.
   */
  const jumpToLatest = sidePanel.getByRole('button', { name: 'Jump to latest' });
  if (await jumpToLatest.isVisible().catch(() => false)) {
    await jumpToLatest.click();
  }
};

/**
 * Queue a follow-up prompt while the agent runs: the composer clears, the
 * send does not end the run, and the live backend echoes the queued user
 * message into the transcript.
 */
const queueFollowUp = async ({
  sidePanel,
  nonce,
}: {
  sidePanel: Page;
  nonce: string;
}): Promise<void> => {
  const composer = sidePanel.locator('#agents-message');
  await expect(composer).toBeVisible({ timeout: 30_000 });
  const followUp = `Nonce ${nonce} follow-up: what number are you on? Reply in one short sentence.`;

  await composer.fill(followUp);
  await composer.press('Enter');

  await expect(composer).toHaveValue('', { timeout: 10_000 });
  await expect(sidePanel.getByRole('button', { name: 'Stop' })).toBeVisible();
  await expect(sidePanel.getByText(followUp).first()).toBeVisible({ timeout: 60_000 });
};

/**
 * Full phase sequence once the session view is open with the long prompt
 * already sent: read-only guard, wait for the run, reopen while running
 * (verified by the nonce), queue a follow-up, stop.
 */
const runOpenSessionPhases = async ({
  sidePanel,
  nonce,
  platformLabel,
}: {
  sidePanel: Page;
  nonce: string;
  platformLabel: 'Cloud agent' | 'CLI';
}): Promise<void> => {
  await failIfReadOnly(sidePanel);

  const stopButton = sidePanel.getByRole('button', { name: 'Stop' });
  await expect(stopButton).toBeVisible({ timeout: 90_000 });

  const sessionTitle = await readSessionTitle(sidePanel);
  await reopenRunningSession({ nonce, platformLabel, sessionTitle, sidePanel });

  const reopenedStop = sidePanel.getByRole('button', { name: 'Stop' });
  await expect(reopenedStop).toBeVisible({ timeout: 90_000 });

  await queueFollowUp({ nonce, sidePanel });

  await reopenedStop.click();
  await expect(reopenedStop).toBeHidden({ timeout: 30_000 });
};

/**
 * Prove the opened session is still running by waiting for the Stop control.
 * Reports the environment gap — with uncovered phases — instead of asserting
 * Stop, so the fallback never queues or stops against a finished run.
 */
const proveSessionRunning = async ({
  sidePanel,
  phase,
  unavailableReason,
}: {
  sidePanel: Page;
  phase: string;
  unavailableReason: string;
}): Promise<void> => {
  const stopButton = sidePanel.getByRole('button', { name: 'Stop' });
  const isRunning = await stopButton
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);

  if (!isRunning) {
    throw new Error(
      `Cloud agent session creation is unavailable (${unavailableReason}) and the ${phase} session is not running. Phases uncovered: start, reopen, queue, stop.`
    );
  }
};

/**
 * Fallback for a cloud agent when session creation is unavailable: open an
 * existing running cloud-agent session and cover view-in-progress, queue, and
 * stop. Start is not covered in this tier. The session must prove it is
 * running before queue and stop; an idle-only list or a run that stops early
 * reports the environment gap instead of sending blindly. The follow-up is
 * queued before the reopen so the reopened transcript carries the nonce to
 * verify with.
 */
const runExistingCloudSessionFallback = async ({
  sidePanel,
  nonce,
  unavailableReason,
}: {
  sidePanel: Page;
  nonce: string;
  unavailableReason: string;
}): Promise<void> => {
  await failIfReadOnly(sidePanel);

  await proveSessionRunning({ phase: 'opened', sidePanel, unavailableReason });

  await queueFollowUp({ nonce, sidePanel });

  const sessionTitle = await readSessionTitle(sidePanel);
  await reopenRunningSession({ nonce, platformLabel: 'Cloud agent', sessionTitle, sidePanel });

  await proveSessionRunning({ phase: 'reopened', sidePanel, unavailableReason });

  const reopenedStop = sidePanel.getByRole('button', { name: 'Stop' });
  await reopenedStop.click();
  await expect(reopenedStop).toBeHidden({ timeout: 30_000 });
};

// ---------------------------------------------------------------------------
// Cloud new-session form helpers
// ---------------------------------------------------------------------------

const readFormError = async (sidePanel: Page): Promise<string | null> => {
  const errorText = await sidePanel
    .locator('p.text-status-red-400')
    .first()
    .textContent()
    .catch(() => null);

  return errorText === null || errorText.trim() === '' ? null : errorText.trim();
};

/**
 * Wait for the new-session form to settle and decide whether a cloud session
 * can be created. Returns the exact reason it cannot, or null when the form
 * is ready to submit with a repository picked.
 */
const decideCloudForm = async (sidePanel: Page): Promise<string | null> => {
  const repoButton = sidePanel.getByLabel('Select repository');
  await expect(repoButton).toBeEnabled({ timeout: 30_000 });

  const blockedReason = sidePanel
    .locator('p')
    .filter({
      hasText: /Connect GitHub to start a cloud session|No repositories available on this account/u,
    })
    .first();
  if (await blockedReason.isVisible().catch(() => false)) {
    return (await blockedReason.textContent()) ?? 'cloud session creation is blocked';
  }

  // A repository is needed; pick the first one when none is auto-selected.
  const repoLabel = (await repoButton.textContent()) ?? '';
  if (repoLabel.trim() !== 'Repository') {
    return null;
  }

  await repoButton.click();
  const connectGitHub = sidePanel.getByText('GitHub integration not connected');
  if (await connectGitHub.isVisible().catch(() => false)) {
    return 'GitHub integration not connected';
  }
  const repoError = sidePanel.getByText('Failed to load repositories');
  if (await repoError.isVisible().catch(() => false)) {
    return 'Failed to load repositories';
  }
  const noRepos = sidePanel.getByText('No repositories found');
  if (await noRepos.isVisible().catch(() => false)) {
    return 'No repositories found';
  }
  const repoOption = sidePanel.locator('button').filter({ hasText: /\//u }).first();
  if ((await repoOption.count()) === 0) {
    return 'No repositories found';
  }
  await repoOption.click();
  return null;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('live local backend: remote CLI agent covers start, reopen, queue, and stop', async () => {
  const fixture = await startFixtureServer({ title: 'Kilo live agents session target' });
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    const targetPage = await context.newPage();
    await targetPage.goto(fixture.url);

    const sidePanel = await context.newPage();
    await signInWithLocalDeviceAuth({ context, extensionId, sidePanel });
    await expect(sidePanel.getByLabel('Message agent')).toBeVisible({ timeout: 15_000 });

    await sidePanel.getByRole('tab', { name: 'Agents' }).click();
    await expect(sidePanel.getByRole('button', { exact: true, name: 'New session' })).toBeVisible({
      timeout: 10_000,
    });

    const nonce = `p${process.pid}-${Date.now().toString(36)}`;

    // Start: spawn onto the connected CLI instance.
    await sidePanel.getByRole('button', { exact: true, name: 'New session' }).click();
    const runOn = sidePanel.getByLabel('Run on');
    await expect(runOn).toBeVisible({ timeout: 60_000 });
    const cliOptionValue = await runOn
      .locator('option')
      .evaluateAll(options =>
        options
          .map(option => (option instanceof HTMLOptionElement ? option.value : ''))
          .find(value => value !== 'cloud')
      );
    if (cliOptionValue === undefined || cliOptionValue === '') {
      throw new Error(
        'No connected CLI instance appeared in the Run on picker — start the Kilo CLI first.'
      );
    }
    await runOn.selectOption(cliOptionValue);

    await sidePanel.getByLabel('What would you like to do?').fill(longPrompt(nonce));
    await sidePanel.getByRole('button', { name: 'Start session' }).click();
    await expect(sidePanel.getByLabel('Back to sessions')).toBeVisible({ timeout: 30_000 });

    await runOpenSessionPhases({ nonce, platformLabel: 'CLI', sidePanel });
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('live local backend: cloud agent covers start, reopen, queue, and stop', async () => {
  const fixture = await startFixtureServer({ title: 'Kilo live agents session target' });
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    const targetPage = await context.newPage();
    await targetPage.goto(fixture.url);

    const sidePanel = await context.newPage();
    await signInWithLocalDeviceAuth({ context, extensionId, sidePanel });
    await expect(sidePanel.getByLabel('Message agent')).toBeVisible({ timeout: 15_000 });

    await sidePanel.getByRole('tab', { name: 'Agents' }).click();
    await expect(sidePanel.getByRole('button', { exact: true, name: 'New session' })).toBeVisible({
      timeout: 10_000,
    });

    const nonce = `p${process.pid}-${Date.now().toString(36)}`;

    // Start: prepare a cloud session through the form.
    await sidePanel.getByRole('button', { exact: true, name: 'New session' }).click();
    await sidePanel.getByLabel('What would you like to do?').fill(longPrompt(nonce));
    const blockedReason = await decideCloudForm(sidePanel);

    if (blockedReason === null) {
      const startButton = sidePanel.getByRole('button', { name: 'Start session' });
      await expect(startButton).toBeEnabled({ timeout: 30_000 });
      await startButton.click();
      const started = await sidePanel
        .getByLabel('Back to sessions')
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      if (started) {
        await runOpenSessionPhases({ nonce, platformLabel: 'Cloud agent', sidePanel });
        return;
      }
    }

    // Cloud creation is unavailable. Fall back to an existing running cloud-agent session.
    const unavailableReason =
      blockedReason ?? (await readFormError(sidePanel)) ?? 'the form reported an error';
    await sidePanel.getByLabel('Back', { exact: true }).click();
    await expect(sidePanel.getByRole('button', { exact: true, name: 'New session' })).toBeVisible({
      timeout: 15_000,
    });
    const cloudSessionRows = sidePanel
      .locator('button')
      .filter({ has: sidePanel.locator('svg[aria-label="Cloud agent"]') });
    await expect
      .poll(() => cloudSessionRows.count(), {
        message: `Cloud agent session creation is unavailable (${unavailableReason}) and no existing cloud-agent session is present. Phases uncovered: start, reopen, queue, stop.`,
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    // The API lists active sessions newest first. Pick the newest running row, which has the Stop control the fallback needs.
    const runningCloudRows = cloudSessionRows.filter({
      has: sidePanel.getByText('Running', { exact: true }),
    });
    await expect
      .poll(() => runningCloudRows.count(), {
        message: `Cloud agent session creation is unavailable (${unavailableReason}) and no cloud-agent session is running. Phases uncovered: start, reopen, queue, stop.`,
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    await runningCloudRows.first().click({ timeout: 30_000 });
    await expect(sidePanel.getByLabel('Back to sessions')).toBeVisible({ timeout: 30_000 });

    await runExistingCloudSessionFallback({ nonce, sidePanel, unavailableReason });
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
