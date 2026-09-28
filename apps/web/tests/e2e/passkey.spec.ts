import { test, expect } from '@chromatic-com/playwright';
import type { Page } from '@playwright/test';

/**
 * Passkey sign-in and passkey management, end to end against the repo's own
 * dev server.
 *
 * The authenticator is the browser's own platform authenticator: a CDP virtual
 * authenticator is installed on the page, so the proof needs no phone, no
 * security key, and no committed credential fixture.
 */

const AUTHENTICATE_ROUTE = '/api/auth/passkey/authenticate';
const SIGN_IN_PATH = '/users/sign_in?signup=true';

/** The browser's platform authenticator, provisioned with a resident passkey. */
async function installVirtualAuthenticator(page: Page): Promise<{
  authenticatorId: string;
  clearCredentials: () => Promise<void>;
}> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return {
    authenticatorId,
    clearCredentials: async () => {
      await cdp.send('WebAuthn.clearCredentials', { authenticatorId });
    },
  };
}

async function sessionEmail(page: Page): Promise<string | undefined> {
  const session = (await page.request
    .get('/api/auth/session')
    .then(response => response.json())) as { user?: { email?: string } } | null;
  return session?.user?.email;
}

/**
 * What `signOut({ redirect: false })` from `next-auth/react` does: the
 * CSRF-protected sign-out POST, which clears the session cookie in place.
 */
async function signOut(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const csrf = (await fetch('/api/auth/csrf').then(response => response.json())) as {
      csrfToken: string;
    };
    await fetch('/api/auth/signout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrfToken: csrf.csrfToken, json: 'true' }).toString(),
    });
  });
}

test('sign in with a passkey, and refuse a replayed or wrong challenge', async ({
  page,
}, testInfo) => {
  const authenticator = await installVirtualAuthenticator(page);
  const testEmail = await sessionEmail(page);
  expect(testEmail).toBeTruthy();

  // (2) Add a passkey from Connected Accounts and show the row.
  await page.goto('/connected-accounts');
  await expect(page.getByText('No passkeys yet')).toBeVisible();
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  const rows = page.getByRole('list', { name: 'Your passkeys' }).getByRole('listitem');
  await expect(rows).toHaveCount(1, { timeout: 30_000 });
  await expect(rows.first()).toContainText('Added');
  await page.screenshot({ path: testInfo.outputPath('passkey-row.png'), fullPage: true });

  // (3) Sign out.
  await signOut(page);
  expect(await sessionEmail(page)).toBeFalsy();

  // (4) Sign in with the passkey and land signed in.
  const verifyBodies: { challengeId: string; response: unknown }[] = [];
  page.on('request', request => {
    if (request.method() !== 'POST' || !request.url().includes(AUTHENTICATE_ROUTE)) return;
    const body = request.postDataJSON() as { action?: string } | null;
    if (body?.action === 'verify') {
      verifyBodies.push(body as { challengeId: string; response: unknown });
    }
  });

  await page.goto(SIGN_IN_PATH);
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await page.waitForURL(url => !url.pathname.startsWith('/users/sign_in'), { timeout: 30_000 });
  await expect.poll(() => sessionEmail(page), { timeout: 30_000 }).toBe(testEmail);
  // The callback route redirects once more before the app shell renders; wait
  // for the signed-in layout so the capture is the landing screen, not the
  // intermediate "Continuing" spinner.
  await page.waitForURL(url => !url.pathname.startsWith('/users/'), { timeout: 30_000 });
  await expect(page.getByRole('navigation', { name: 'breadcrumb' })).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({ path: testInfo.outputPath('signed-in.png'), fullPage: true });

  // (5) The same assertion is usable exactly once, and an assertion signed for
  // another challenge is refused.
  expect(verifyBodies).toHaveLength(1);
  const captured = verifyBodies[0];

  const firstReplay = await page.request.post(AUTHENTICATE_ROUTE, { data: captured });
  expect(firstReplay.status()).toBe(401);
  const secondReplay = await page.request.post(AUTHENTICATE_ROUTE, { data: captured });
  expect(secondReplay.status()).toBe(401);

  const optionsResponse = await page.request.post(AUTHENTICATE_ROUTE, {
    data: { action: 'options' },
  });
  expect(optionsResponse.ok()).toBe(true);
  const { challengeId } = (await optionsResponse.json()) as { challengeId: string };

  const wrongChallenge = await page.request.post(AUTHENTICATE_ROUTE, {
    data: { action: 'verify', challengeId, response: captured.response },
  });
  expect(wrongChallenge.status()).toBe(401);

  // (1) A device that holds no passkey at all: the ceremony is refused without
  // a crash, the refusal is retryable, and no provider is lost.
  await signOut(page);
  await authenticator.clearCredentials();
  await page.goto(SIGN_IN_PATH);
  const passkeyButton = page.getByRole('button', { name: 'Sign in with a passkey' });
  await expect(passkeyButton).toBeVisible();
  await passkeyButton.click();
  await expect(page.getByText('Sign-in was cancelled or could not start. Try again.')).toBeVisible({
    timeout: 30_000,
  });
  await expect(passkeyButton).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Continue with Email' })).toBeVisible();
});
