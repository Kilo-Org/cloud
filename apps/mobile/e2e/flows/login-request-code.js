// Login step 1/2 — request an email sign-in code.
//
// Establishes a signed-out baseline, then submits EMAIL to reach the "Enter
// the code" screen. The 6-digit code is emailed to the local outbox
// (dev/logs/emails/); read it there and pass it to login-verify-code.js.
//
//   apps/mobile/e2e/appium.sh <udid> test -e EMAIL=e2e-mobile@example.com \
//     e2e/flows/login-request-code.js
//
// EMAIL is required (-e). Prefer the one-shot wrapper e2e/login.sh, which
// runs both steps and pulls the code for you. See e2e/AGENTS.md.
const logout = require('./logout');

module.exports = async function requestCode(ctx) {
  const { h, env } = ctx;
  const email = env.EMAIL;
  if (!email) throw new Error('EMAIL is required (pass -e EMAIL=<address>)');

  await logout(ctx);

  // Tap the input via its placeholder — the "Email address" label shares the
  // field's accessibility text and would match the (non-focusable) label.
  await h.tapOn('you@example.com');
  // The field is uncontrolled, so a login page left on screen by an earlier
  // run still holds its address, and typing inserts at the caret the tap just
  // dropped mid-string — two attempts interleave into a malformed address.
  await h.eraseText(100);
  await h.inputText(email);
  // Fail here, immediately and legibly, instead of 15s later on a missing
  // "Verify code": a mismatch means typing landed in a field that was not empty.
  // The address is text, not a pattern — escape before it reaches the regex
  // selector (plus-sign and dot aliases never full-match otherwise).
  await h.assertVisible(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  await h.tapOn('Send sign-in code');
  // Sending is a network round-trip.
  await h.waitVisible('Verify code', { timeout: 15000 });
};
