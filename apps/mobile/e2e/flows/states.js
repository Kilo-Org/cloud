// Shared on-screen state patterns for the launch/login flows. Text matching
// is full-string regex against the element label/text (see helpers.js), so
// alternations and literals live here once instead of drifting between flows.

// SpringBoard / Safari external-app confirmation when a deep link reopens the
// dev client (both wordings, straight or curly quotes).
const OPEN_IN_KILO = /Open this page in "Kilo"\?|Open in ["“”]Kilo["“”]\?/;

// iOS App Tracking Transparency.
const TRACKING_PROMPT =
  /Allow “Kilo” to track your activity across other companies’ apps and websites\?/;
const TRACKING_BUTTON = /Ask App Not to Track/;

// Expo dev client: developer-menu introduction, then the opened menu itself.
const DEVMENU_INTRO = /This is the developer menu.*/;
const DEVMENU_OPEN = /Fast Refresh|Element Inspector/;

// iOS notification permission (system sheet rendered inside the app).
const NOTIF_PROMPT = /“Kilo” Would Like to Send You Notifications/;

// App states.
const HOME = /HOME|Home, tab, 1 of 4/;
const LOGIN = /Welcome to Kilo Code/;
const CONSENT = /Accept and continue/;

// Any state a launch can land on — used to know the app rendered something
// known before settling. Keep in sync with the prompts above.
const ANY_STATE = new RegExp(
  [
    OPEN_IN_KILO.source,
    TRACKING_PROMPT.source,
    TRACKING_BUTTON.source,
    DEVMENU_INTRO.source,
    DEVMENU_OPEN.source,
    NOTIF_PROMPT.source,
    HOME.source,
    LOGIN.source,
    CONSENT.source,
  ].join('|')
);

module.exports = {
  ANY_STATE,
  CONSENT,
  DEVMENU_INTRO,
  DEVMENU_OPEN,
  HOME,
  LOGIN,
  NOTIF_PROMPT,
  OPEN_IN_KILO,
  TRACKING_BUTTON,
  TRACKING_PROMPT,
};
