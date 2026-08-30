/* eslint-disable no-await-in-loop -- Device authorization retries only the existing sign-in initiation. */
import { expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

export const signInWithLocalDeviceAuth = async ({
  context,
  extensionId,
  localBackendUrl,
  localUserEmail,
  sidePanel,
}: {
  context: BrowserContext;
  extensionId: string;
  localBackendUrl: string;
  localUserEmail: string;
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
  // Shared stacks can redirect to a LAN origin. Sign in there so the callback retains its cookie.
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
    // Fall back to localBackendUrl on a request error or an invalid redirect.
  }

  await authPage.goto(
    `${authOrigin}/users/sign_in?fakeUser=${encodeURIComponent(localUserEmail)}&callbackPath=${encodeURIComponent(callbackPath)}`
  );
  await authPage.getByRole('button', { name: 'Authorize' }).click({ timeout: 60_000 });
  await expect(sidePanel.getByLabel('Message agent')).toBeVisible({ timeout: 30_000 });
  await authPage.close();
};
