// Settles an already-running app: handles the Safari external-app prompt and
// the SpringBoard custom-scheme confirmation (`Open in "Kilo"?`, shown by
// `simctl openurl` since universal links were configured), the tracking
// prompt, the Expo developer-menu introduction and menu, and notification
// permission — ending on Home, the login page, or the consent gate. Never
// restarts the app; open-app.js is the cold-launch wrapper around this flow.
const S = require('./states');

module.exports = async function settleApp(ctx) {
  const { h, when } = ctx;

  // Something known must render before we settle. A preflight reconnect
  // refetches the JS bundle on Android (a minute or more under load); the
  // long budget returns as soon as anything renders, so healthy runs and
  // iOS never pay it.
  await h.waitVisible(S.ANY_STATE, { timeout: ctx.platform === 'android' ? 300000 : 15000 });

  // A deep-link reconnect may raise the external-app confirmation; one
  // bounded optional look, then move on (the only optional wait here).
  await h.waitVisible(
    new RegExp(
      [
        S.OPEN_IN_KILO.source,
        S.TRACKING_PROMPT.source,
        S.TRACKING_BUTTON.source,
        S.DEVMENU_INTRO.source,
        S.DEVMENU_OPEN.source,
        S.NOTIF_PROMPT.source,
      ].join('|')
    ),
    { timeout: 3000, optional: true }
  );
  await when(ctx, S.OPEN_IN_KILO, () => h.tapOn('Open'));

  // Each wait below excludes the state just handled: prompts are answered in
  // order and never reappear, so every barrier either advances or passes.
  await h.waitVisible(
    new RegExp(
      [
        S.TRACKING_PROMPT.source,
        S.TRACKING_BUTTON.source,
        S.DEVMENU_INTRO.source,
        S.DEVMENU_OPEN.source,
        S.NOTIF_PROMPT.source,
        S.HOME.source,
        S.LOGIN.source,
        S.CONSENT.source,
      ].join('|')
    ),
    { timeout: 5000 }
  );
  await when(ctx, S.TRACKING_BUTTON, () => h.tapOn(S.TRACKING_BUTTON));

  await h.waitVisible(
    new RegExp(
      [
        S.DEVMENU_INTRO.source,
        S.DEVMENU_OPEN.source,
        S.NOTIF_PROMPT.source,
        S.HOME.source,
        S.LOGIN.source,
        S.CONSENT.source,
      ].join('|')
    ),
    { timeout: 5000 }
  );
  await when(ctx, S.DEVMENU_INTRO, () => h.tapOn('Continue'));

  await h.waitVisible(
    new RegExp(
      [
        S.DEVMENU_OPEN.source,
        S.NOTIF_PROMPT.source,
        S.HOME.source,
        S.LOGIN.source,
        S.CONSENT.source,
      ].join('|')
    ),
    { timeout: 5000 }
  );
  await when(ctx, S.DEVMENU_OPEN, () => h.tapOn('Close'));

  await h.waitVisible(
    new RegExp([S.NOTIF_PROMPT.source, S.HOME.source, S.LOGIN.source, S.CONSENT.source].join('|')),
    { timeout: 5000 }
  );
  // The only generic Allow tap in the launch flows: reached exclusively from
  // the identified notification prompt above.
  await when(ctx, S.NOTIF_PROMPT, () => h.tapOn('Allow'));

  await h.waitVisible(new RegExp([S.HOME.source, S.LOGIN.source, S.CONSENT.source].join('|')), {
    timeout: 15000,
  });
};
