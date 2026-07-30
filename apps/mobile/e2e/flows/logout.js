// Logout helper — ends on the login page ("Welcome to Kilo Code").
//
// Idempotent: if the app is already signed out, it just lands on the login
// page. Run via `apps/mobile/e2e/logout.sh <device>`; see e2e/AGENTS.md.
const settleApp = require('./settle-app');
const S = require('./states');

module.exports = async function logout(ctx) {
  const { h, when, whenNot } = ctx;

  // An open code-verification screen backs out to the email form.
  await when(ctx, 'Verify code', () => h.tapOn('Back'));

  // Signed out already? Land on the login page. Anything else that is not
  // Home gets settled first (prompts, developer menu, consent gate).
  await whenNot(ctx, S.LOGIN, async () => {
    await whenNot(ctx, S.HOME, () => settleApp(ctx));
  });

  // Booted into the consent gate (signed in, not consented) -> accept it to
  // reach Home, then sign out below.
  await when(ctx, S.CONSENT, async () => {
    await h.tapOn(S.CONSENT);
    await h.waitVisible(/Home, tab, 1 of 4/, { timeout: 15000 });
  });

  // Signed in: Profile tab -> Sign Out -> confirm the native alert.
  await whenNot(ctx, S.LOGIN, async () => {
    await h.tapOn('Profile, tab, 4 of 4');
    await h.scrollUntilVisible('Sign Out', { direction: 'DOWN' });
    await h.tapOn('Sign Out');
    await h.assertVisible('Sign out?');
    // The alert's confirm ("Sign out") and the screen button ("Sign Out")
    // collide under a case-insensitive match; index 0 is topmost by position,
    // which is the alert button.
    await h.tapOn('Sign out', { index: 0, ci: true });
  });

  // Signing out is an API call plus navigation back to the login page.
  await h.waitVisible('you@example.com', { timeout: 15000 });
};
