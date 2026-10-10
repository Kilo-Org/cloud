/** NextAuth endpoints used to sign seeded users in and out without the UI. */
export const authApiPaths = {
  csrf: '/api/auth/csrf',
  session: '/api/auth/session',
  /** The dev-only fake-login credentials provider (enabled by `DEBUG_SHOW_DEV_UI`). */
  fakeLoginCallback: '/api/auth/callback/fake-login',
  afterSignIn: '/users/after-sign-in',
};

export const defaultSignedInPath = '/profile';
