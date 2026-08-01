// Standalone cold-launch flow: clears any prompt left on screen, relaunches
// the dev client, waits for it to render a known state, then delegates prompt
// handling to settle-app.js.
const { BUNDLE_ID } = require('../wdio/client');
const settleApp = require('./settle-app');
const S = require('./states');

// Under parallel-workflow host load a cold Android launch can sit on a blank
// splash for minutes and the emulator throws `Process system isn't responding`
// ANR dialogs; answer Wait and keep waiting instead of failing the round.
const ANR_DIALOG = /.*isn.t responding.*/;

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

  // Cold launch and bundling are slow; wait for any known state before
  // settling. Both platforms get a long budget under parallel-workflow host
  // load; the wait returns as soon as a state renders, so healthy runs never
  // pay it.
  const launchTimeout = ctx.platform === 'android' ? 420000 : 120000;
  for (let anr = 0; ; anr++) {
    try {
      await h.waitVisible(S.ANY_STATE, { timeout: launchTimeout });
      break;
    } catch (err) {
      if (anr < 3 && (await ctx.h.visible(ANR_DIALOG))) {
        await h.tapOn('Wait');
        continue;
      }
      throw err;
    }
  }
  await when(ctx, ANR_DIALOG, () => h.tapOn('Wait'));
  await settleApp(ctx);
};
