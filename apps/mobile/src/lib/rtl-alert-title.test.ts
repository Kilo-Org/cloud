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
//
// The second half holds the alert path to the same platform rule the needs-input
// notification path follows (`notification-platform-parity.test.ts`): one
// implementation for both platforms, with a platform gate kept only where the
// platform lacks the capability and named in its comment. Here the gate is
// Android's, because Android is the platform whose alert title alignment lives
// in a resource no JS API reaches; iOS's `UIAlertController` needs no override.

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

// One implementation for both platforms on the alert path. The app raises every
// alert through `Alert.alert`; the only platform-specific artifact is Android's
// resource override, and it stays because Android is the platform that lacks a
// JS-level way to align the title — `AlertFragment` inflates the layout and
// nothing exposes its `textAlignment`. iOS has no counterpart to write, so no
// module here may carry a second, per-platform alert implementation.
describe('one alert implementation for both platforms', () => {
  const pluginSource = readFileSync(join(mobileDir, 'plugins', 'withRtlAlertTitle.js'), 'utf8');

  it('gates the override to Android, the platform with no JS-level title alignment', () => {
    // The gate is the single platform the mod runs for, named rather than
    // repeated inline, and there is no iOS half to keep in step with it.
    expect(pluginSource).toMatch(/const ALERT_TITLE_PLATFORM = 'android'/);
    expect(pluginSource).toMatch(/withDangerousMod\(config, \[\s*ALERT_TITLE_PLATFORM\b/);
    expect(pluginSource).not.toMatch(/['"]ios['"]/);
  });

  it('names the gate and the capability Android lacks in its comment', () => {
    expect(pluginSource).toContain('Platform gate: Android only');
    expect(pluginSource).toContain('UIAlertController');
  });

  it('leaves the discard confirm, the flow the finding names, free of a platform branch', () => {
    const guardSource = readFileSync(
      join(mobileDir, 'src', 'components', 'agents', 'use-new-session-discard-guard.ts'),
      'utf8'
    );
    expect(guardSource).toContain('Alert.alert(');
    expect(guardSource).not.toMatch(/\bPlatform\.(?:OS|select|Version)\b/);
  });
});
