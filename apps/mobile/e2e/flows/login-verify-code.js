// Login step 2/2 — verify the emailed sign-in code.
//
// Enters OTP on the "Enter the code" screen and lands on Home. Assumes
// login-request-code.js already reached that screen.
//
//   apps/mobile/e2e/appium.sh <udid> test -e OTP=123456 e2e/flows/login-verify-code.js
//
// Prefer the one-shot wrapper e2e/login.sh. See e2e/AGENTS.md.
const S = require('./states');

module.exports = async function verifyCode(ctx) {
  const { h, env, when } = ctx;
  const otp = env.OTP;
  if (!otp) throw new Error('OTP is required (pass -e OTP=<code>)');

  await h.assertVisible('Verify code');
  await h.tapOn('Sign-in code');
  await h.eraseText(6);
  await h.inputText(otp);
  // The number pad has no dismiss key; "Verify code" sits above it, so tap directly.
  await h.tapOn('Verify code');

  // A brand-new account's first sign-in shows a consent screen before Home.
  await h.waitVisible(new RegExp([S.CONSENT.source, S.NOTIF_PROMPT.source, S.HOME.source].join('|')), {
    timeout: 20000,
  });
  await when(ctx, S.CONSENT, () => h.tapOn(S.CONSENT));
  await h.waitVisible(new RegExp([S.NOTIF_PROMPT.source, S.HOME.source].join('|')), {
    timeout: 15000,
  });
  await when(ctx, S.NOTIF_PROMPT, () => h.tapOn('Allow'));
  await h.waitVisible(S.HOME, { timeout: 15000 });
};
