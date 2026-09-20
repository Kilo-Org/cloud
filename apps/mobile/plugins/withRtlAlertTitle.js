const fs = require('fs');
const path = require('path');

const { withDangerousMod } = require('expo/config-plugins');

/**
 * Mirrors the Android alert title to the text's own start edge.
 *
 * `Alert.alert` is the app's destructive-confirm primitive (AGENTS.md), and the
 * app raises every alert through it — one implementation for both platforms, no
 * per-platform call-site branch. On Android React Native gives that alert a
 * custom title view: `AlertFragment` inflates its own
 * `R.layout.alert_title_layout` and installs it with
 * `AlertDialog.Builder.setCustomTitle`. That layout pins
 * `android:textAlignment="viewStart"`, which aligns to the *window's* layout
 * direction — the device locale, not the language the app is showing. An app
 * switched to Arabic through the in-app picker forces React Native's own layout
 * direction (`I18nManager.forceRTL`) but leaves the Android window in the device
 * locale, so the dialog body (the framework's message view, which aligns to the
 * paragraph direction) and the button row mirror to the right while the title
 * stays at the left edge — e.g. the new-session discard confirm's "Delete
 * draft?" over its right-aligned body (`useNewSessionDiscardGuard`).
 *
 * Platform gate: Android only — the one platform that lacks the capability.
 * The alignment lives in a resource the platform merges by name, and React
 * Native exposes no JS API to set it, so only a prebuild-time override can
 * reach it. iOS has no counterpart to write: `Alert.alert` goes to
 * `UIAlertController` (RCTAlertManager), which centers the title and its
 * message alike, so the title already shares its body's edge and this plugin
 * stays the single platform-specific piece on the alert path. The same rule
 * (`notification-platform-parity.test.ts`) admits only gates that name a
 * capability the platform lacks.
 *
 * Android merges application resources over library resources by name, so an
 * `alert_title_layout.xml` in the app's own `res/layout` replaces the one
 * react-native ships. `plugins/alert/alert_title_layout.xml` is react-native's
 * layout with that one attribute flipped to `textStart`; the contract and
 * platform-parity checks in `src/lib/rtl-alert-title.test.ts` pin the
 * difference and the gate, so a react-native upgrade that changes the layout
 * fails the check rather than shipping the override stale.
 */
const ALERT_TITLE_LAYOUT = 'alert_title_layout.xml';
/** The gate above, named once: the layout is Android's, so the mod runs for it alone. */
const ALERT_TITLE_PLATFORM = 'android';

function withRtlAlertTitle(config) {
  return withDangerousMod(config, [
    ALERT_TITLE_PLATFORM,
    async config => {
      const layoutDir = path.join(
        config.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
        'layout'
      );
      fs.mkdirSync(layoutDir, { recursive: true });
      fs.copyFileSync(
        path.join(__dirname, 'alert', ALERT_TITLE_LAYOUT),
        path.join(layoutDir, ALERT_TITLE_LAYOUT)
      );
      return config;
    },
  ]);
}

module.exports = withRtlAlertTitle;
