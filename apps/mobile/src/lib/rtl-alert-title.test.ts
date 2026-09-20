// eslint-disable-next-line import/no-nodejs-modules -- vitest-only contract check, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only contract check, runs in node, never bundled into the app
import { createRequire } from 'node:module';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only contract check, runs in node, never bundled into the app
import { dirname, join } from 'node:path';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only contract check, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The Android alert title override is a contract between three files that must
// not drift: react-native's own alert title layout (the layout the app replaces),
// the app's override (plugins/alert, copied in by plugins/withRtlAlertTitle.js at
// prebuild), and the app config that registers the plugin. None of them is
// bundled here, so the suite reads the sources it ships — same shape as the App
// Intent contract test in modules/kilo-app-actions.

const mobileDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const reactNativeDir = dirname(createRequire(import.meta.url).resolve('react-native/package.json'));

const ALERT_TITLE_LAYOUT = 'alert_title_layout.xml';
const readLayout = (directory: string) => readFileSync(join(directory, ALERT_TITLE_LAYOUT), 'utf8');

// react-native's native alert title view: AlertFragment.getAccessibleTitle
// inflates R.layout.alert_title_layout and reads R.id.alert_title out of it.
const reactNativeLayout = readLayout(
  join(reactNativeDir, 'ReactAndroid', 'src', 'main', 'res', 'views', 'alert', 'layout')
);
const overrideLayout = readLayout(join(mobileDir, 'plugins', 'alert'));

const VIEW_START_ALIGNMENT = 'android:textAlignment="viewStart"';
const TEXT_START_ALIGNMENT = 'android:textAlignment="textStart"';

describe('rtl alert title layout', () => {
  it('aligns the title to the text direction instead of the window direction', () => {
    expect(overrideLayout).toContain(TEXT_START_ALIGNMENT);
    expect(overrideLayout).not.toContain(VIEW_START_ALIGNMENT);
  });

  it("is react-native's layout with only the title alignment changed", () => {
    // The whole point of an app-level override: it stays react-native's title
    // view (padding, DialogTitle styling, id) so a react-native change cannot
    // silently keep this copy stale.
    expect(reactNativeLayout).toContain(VIEW_START_ALIGNMENT);
    expect(overrideLayout).toBe(
      reactNativeLayout.replace(VIEW_START_ALIGNMENT, TEXT_START_ALIGNMENT)
    );
  });

  it('keeps the title view react-native inflates and styles', () => {
    // AlertFragment reads both of these out of the layout it inflates.
    expect(overrideLayout).toContain('com.facebook.react.modules.dialog.DialogTitle');
    expect(overrideLayout).toContain('android:id="@+id/alert_title"');
  });

  it('is registered on the app config, so prebuild applies it', () => {
    const appConfig = readFileSync(join(mobileDir, 'app.config.ts'), 'utf8');
    expect(appConfig).toContain("'./plugins/withRtlAlertTitle'");
  });
});
