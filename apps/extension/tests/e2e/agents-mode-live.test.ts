/* eslint-disable import/no-nodejs-modules, jest/no-conditional-in-test, max-lines, no-await-in-loop, promise/avoid-new */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { launchExtensionContext, startFixtureServer } from './extension-context-fixture';

const runLive = process.env['EXTENSION_LOCAL_BACKEND_E2E'] === '1';
test.skip(!runLive, 'local backend only');

test.setTimeout(150_000);

const localBackendUrl = process.env['LOCAL_BACKEND_ORIGIN'] || 'http://localhost:3000';
const localUserEmail = 'fl@fl.fl';

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
// Tests
// ---------------------------------------------------------------------------

test('live local backend: open remote CLI session, send, assert reply, send long prompt, interrupt', async () => {
  const fixture = await startFixtureServer({ title: 'Kilo live agents session target' });
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    const targetPage = await context.newPage();
    await targetPage.goto(fixture.url);

    const sidePanel = await context.newPage();
    await signInWithLocalDeviceAuth({ context, extensionId, sidePanel });
    await expect(sidePanel.getByLabel('Message agent')).toBeVisible({ timeout: 15_000 });

    // Switch to Agents mode
    await sidePanel.getByRole('tab', { name: 'Agents' }).click();
    await expect(sidePanel.getByRole('button', { name: 'New session' })).toBeVisible({
      timeout: 10_000,
    });

    // Wait for active sessions to load. Sessions poll every ~30s; bound to 60s.
    // Must find at least one non-Cloud active session row.
    const sessionRows = sidePanel.locator('button:has(> div:has(> span.truncate))');
    await expect
      .poll(
        async () => {
          const count = await sessionRows.count();
          for (let i = 0; i < count; i += 1) {
            const hasCloudBadge = await sessionRows
              .nth(i)
              .locator('text=Cloud')
              .isVisible()
              .catch(() => false);
            if (!hasCloudBadge) return true;
          }
          return false;
        },
        { timeout: 60_000, message: 'No non-Cloud active sessions found — expected at least one remote CLI session' }
      )
      .toBe(true);

    // Find a non-Cloud active session. The session buttons are nested <button>
    // Elements with a truncate span showing the title. Cloud sessions have a
    // "Cloud" badge. Filter to rows without the Cloud badge.
    let remoteRow: ReturnType<typeof sessionRows.nth> | null = null;
    const rowCount = await sessionRows.count();
    for (let rowIdx = 0; rowIdx < rowCount; rowIdx++) {
      const row = sessionRows.nth(rowIdx);
      const hasCloudBadge = await row
        .locator('text=Cloud')
        .isVisible()
        .catch(() => false);
      if (!hasCloudBadge) {
        remoteRow = row;
        break;
      }
    }
    if (!remoteRow) {
      throw new Error('No remote CLI sessions found — all active sessions are Cloud sessions');
    }

    await remoteRow.click();
    await expect(sidePanel.getByLabel('Back to sessions')).toBeVisible({ timeout: 15_000 });

    // Wait for transcript to load — at least one message should be visible
    await sidePanel.waitForTimeout(3000);

    // The remote CLI session should be interactive (not read-only)
    const isReadOnly = await sidePanel
      .getByText('This session is read-only')
      .isVisible()
      .catch(() => false);
    if (isReadOnly) {
      throw new Error('Remote CLI session is read-only — expected an interactive session');
    }

    // ---- Phase 1: Send a short prompt and assert the assistant replies "ok" ----
    const composer = sidePanel.locator('#agents-message');
    await composer.fill('Reply with exactly: ok');
    await composer.press('Enter');

    // Wait for the assistant response (up to 120s for live LLM)
    await expect(sidePanel.getByText('ok')).toBeVisible({ timeout: 120_000 });

    // ---- Phase 2: Send a long prompt, interrupt, assert recovery ----
    await composer.fill('Write a very detailed explanation of TypeScript generics with examples.');
    await composer.press('Enter');

    // Stop button appears while streaming
    const stopButton = sidePanel.getByRole('button', { name: 'Stop' });
    await expect(stopButton).toBeVisible({ timeout: 30_000 });

    // Interrupt
    await stopButton.click();

    // After interrupt, the send button reappears
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
