import { getRequest, gotoURL, postRequest, wait } from '@anaconda/playwright-utils';
import type { SeededUser } from '@support/core/seed-data';
import { authApiPaths, defaultSignedInPath } from '@testdata/ui/auth/session-test-data';

/** Signs seeded users in through the dev-only fake-login provider. */
export class SessionPage {
  /**
   * Uses the NextAuth API (CSRF token + credentials callback) instead of the sign-in page,
   * whose auto-submit can lose the CSRF cookie race under `next dev`.
   */
  async signInAs(user: SeededUser, path = defaultSignedInPath): Promise<void> {
    await this.withConnectionResetRetry(async () => {
      const csrf = await getRequest(authApiPaths.csrf);
      const { csrfToken } = csrf.ok() ? ((await csrf.json()) as { csrfToken?: string }) : {};
      if (!csrfToken) {
        throw new Error(`CSRF token request failed with status ${csrf.status()}: ${await csrf.text()}`);
      }
      const callback = await postRequest(authApiPaths.fakeLoginCallback, {
        form: { csrfToken, email: user.email, callbackUrl: authApiPaths.afterSignIn, json: 'true' },
      });
      if (!callback.ok()) {
        throw new Error(`Fake login failed with status ${callback.status()}: ${await callback.text()}`);
      }
      const sessionResponse = await getRequest(authApiPaths.session);
      if (!sessionResponse.ok()) {
        throw new Error(`Session request failed with status ${sessionResponse.status()}`);
      }
      const session = (await sessionResponse.json()) as { user?: { email?: string } };
      // Only the email: the session also carries values that must not reach the uploaded report.
      if (session.user?.email !== user.email) {
        throw new Error(`Fake login did not sign in ${user.email}; session user: ${session.user?.email ?? 'none'}`);
      }
    });
    await gotoURL(path);
  }

  /** `next dev` occasionally resets a connection when many workers sign in at once; back off and retry. */
  private async withConnectionResetRetry(action: () => Promise<void>, attempts = 3): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await action();
      } catch (error) {
        if (attempt >= attempts || !String(error).includes('ECONNRESET')) {
          throw error;
        }
        await wait(500 * attempt);
      }
    }
  }
}
