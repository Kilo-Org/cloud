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
      const { csrfToken } = (await (await getRequest(authApiPaths.csrf)).json()) as { csrfToken: string };
      const callback = await postRequest(authApiPaths.fakeLoginCallback, {
        form: { csrfToken, email: user.email, callbackUrl: authApiPaths.afterSignIn, json: 'true' },
      });
      if (!callback.ok()) {
        throw new Error(`Fake login failed with status ${callback.status()}`);
      }
      const session = (await (await getRequest(authApiPaths.session)).json()) as { user?: { email?: string } };
      if (session.user?.email !== user.email) {
        throw new Error(`Fake login did not sign in ${user.email}`);
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
