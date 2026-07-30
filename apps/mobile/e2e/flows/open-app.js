// Standalone cold-launch flow: clears any prompt left on screen, relaunches
// the dev client, waits for it to render a known state, then delegates prompt
// handling to settle-app.js.
const { BUNDLE_ID } = require('../wdio/client');
const settleApp = require('./settle-app');
const S = require('./states');

module.exports = async function openApp(ctx) {
  const { h, when } = ctx;

  // Prompts left over from a previous run block the relaunch; answer them.
  await when(ctx, S.TRACKING_BUTTON, () => h.tapOn(S.TRACKING_BUTTON));
  await when(ctx, S.DEVMENU_INTRO, () => h.tapOn('Continue'));
  await when(ctx, S.DEVMENU_OPEN, () => h.tapOn('Close'));

  // Relaunch through the driver. activateApp is a plain bring-to-front via
  // the platform (WDA / activity manager) and does not bounce the dev client
  // to SpringBoard the way the old CLI launch could.
  await h.stopApp(BUNDLE_ID);
  await h.launchApp(BUNDLE_ID);

  // Cold launch and bundling are slow; wait for any known state before settling.
  await h.waitVisible(S.ANY_STATE, { timeout: 30000 });
  await settleApp(ctx);
};
