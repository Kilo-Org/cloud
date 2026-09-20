const fs = require('fs');
const path = require('path');

const { withDangerousMod } = require('expo/config-plugins');

/**
 * Mirrors the Android alert title to the text's own start edge.
 *
 * `Alert.alert` is the app's destructive-confirm primitive (AGENTS.md), and on
 * Android React Native gives it a custom title view: `AlertFragment` inflates
 * its own `R.layout.alert_title_layout` and installs it with
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
 * Android merges application resources over library resources by name, so an
 * `alert_title_layout.xml` in the app's own `res/layout` replaces the one
 * react-native ships. `plugins/alert/alert_title_layout.xml` is react-native's
 * layout with that one attribute flipped to `textStart`; the contract check in
 * `src/lib/rtl-alert-title.test.ts` pins the difference, so a react-native
 * upgrade that changes the layout fails the check rather than shipping the
 * override stale.
 */
const ALERT_TITLE_LAYOUT = 'alert_title_layout.xml';

function withRtlAlertTitle(config) {
  return withDangerousMod(config, [
    'android',
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
