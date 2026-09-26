// One implementation for both platforms on the alert dialog path.
//
// `Alert.alert()` is the app's one confirmation implementation: the same call
// renders the platform's native alert on iOS and Android, and no shared module
// picks a platform to choose behaviour. Each platform only contributes the
// capability the other lacks — Android's AppCompat alert resolves its panel and
// accent from the activity theme, so the prebuild overlay points them at the
// app tokens, while iOS's `UIAlertController` already follows the device's
// light/dark appearance and exposes no app-token override, so there is no iOS
// half to write. This suite runs the plugin's mods in node and holds the path
// to that: the one platform-specific module is the Android plugin, it writes
// the app tokens for day and night, it adds nothing on iOS, and neither the
// delete-account native alert nor the sign-out dialog branches on a platform.

// eslint-disable-next-line import/no-nodejs-modules -- vitest-only parity check, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only parity check, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import plugin from '../../plugins/withAndroidAlertDialogTheme.js';

type StyleItem = { $: { name: string }; _: string };
type Style = { $: { name: string; parent?: string }; item?: StyleItem[] };
type ColorResource = { $: { name: string }; _: string };
type AndroidModResults = { resources: { color?: ColorResource[]; style?: Style[] } };
type AlertThemeConfig = {
  modResults: AndroidModResults;
  mods: { android?: Record<string, AndroidMod>; ios?: unknown };
};
type AndroidMod = (config: AlertThemeConfig) => Promise<unknown>;

const withAlertDialogTheme = plugin as unknown as (config: AlertThemeConfig) => AlertThemeConfig;

const DIRECTORY = fileURLToPath(new URL('./', import.meta.url));
const PLUGIN_PATH = `${DIRECTORY}../../plugins/withAndroidAlertDialogTheme.js`;
const CONFIG_PATH = `${DIRECTORY}../../app.config.ts`;
const PROFILE_PATH = `${DIRECTORY}../components/profile-screen.tsx`;

/**
 * A per-platform branch in shared JS: a `Platform.OS`/`Platform.select` check,
 * or an import of a platform-suffixed module.
 */
const PLATFORM_BRANCH =
  /\bPlatform\.(?:OS|select|Version)\b|from '[^']+\.(?:ios|android)'|require\('[^']+\.(?:ios|android)'\)/;

function loadConfig(): AlertThemeConfig {
  return withAlertDialogTheme({ modResults: { resources: {} }, mods: {} });
}

async function runAndroidMod(
  config: AlertThemeConfig,
  mod: AndroidMod | undefined,
  modResults: AndroidModResults
): Promise<AndroidModResults> {
  if (!mod) {
    throw new Error('the alert dialog plugin registers no such Android mod');
  }
  config.modResults = modResults;
  await mod(config);
  return config.modResults;
}

function colorValue(results: AndroidModResults, name: string): string | undefined {
  return results.resources.color?.find(color => color.$.name === name)?._;
}

function styleValue(results: AndroidModResults, theme: string, name: string): string | undefined {
  return results.resources.style
    ?.find(style => style.$.name === theme)
    ?.item?.find(item => item.$.name === name)?._;
}

describe('one implementation for both platforms on the alert dialog path', () => {
  it('points the Android alert panel and accent at the app tokens, day and night', async () => {
    const config = loadConfig();
    const androidMods = config.mods.android ?? {};

    const day = await runAndroidMod(config, androidMods.colors, { resources: { color: [] } });
    // Mirrors src/global.css `--popover` and `--primary` (light).
    expect(colorValue(day, 'app_dialog_background')).toBe('#FFFFFF');
    expect(colorValue(day, 'app_dialog_action')).toBe('#4F5A10');

    const night = await runAndroidMod(config, androidMods.colorsNight, {
      resources: { color: [] },
    });
    // Mirrors src/global.css `--popover` and `--primary` (dark).
    expect(colorValue(night, 'app_dialog_background')).toBe('#1F1F24');
    expect(colorValue(night, 'app_dialog_action')).toBe('#E8F27A');
  });

  it('overlays only the alert dialog theme on the activity theme', async () => {
    const config = loadConfig();
    const androidMods = config.mods.android ?? {};

    const styles = await runAndroidMod(config, androidMods.styles, {
      resources: { style: [{ $: { name: 'AppTheme' } }] },
    });

    expect(styleValue(styles, 'AppTheme', 'alertDialogTheme')).toBe('@style/AppAlertDialogTheme');
    const dialogTheme = styles.resources.style?.find(
      style => style.$.name === 'AppAlertDialogTheme'
    );
    expect(dialogTheme?.$.parent).toBe('ThemeOverlay.AppCompat.Dialog.Alert');
    // The framework and AppCompat attributes both resolve the panel, so both
    // are pointed at the same color; the accent carries the action labels.
    expect(styleValue(styles, 'AppAlertDialogTheme', 'colorBackgroundFloating')).toBe(
      '@color/app_dialog_background'
    );
    expect(styleValue(styles, 'AppAlertDialogTheme', 'android:colorBackgroundFloating')).toBe(
      '@color/app_dialog_background'
    );
    expect(styleValue(styles, 'AppAlertDialogTheme', 'colorAccent')).toBe(
      '@color/app_dialog_action'
    );
  });

  it('drops the stock ALL-CAPS from the Android dialog action labels', async () => {
    // discard-draft-dialog: AppCompat's alert button style sets
    // `textAllCaps=true`, so the sentence-case catalog copy ("Scarta",
    // "Continua a modificare") rendered as "SCARTA" / "CONTINUA A MODIFICARE"
    // while every button the app draws itself is sentence case. The dialog
    // theme must point both button-bar style attributes at a child style that
    // clears the caps, so no dialog keeps the stock treatment.
    const config = loadConfig();
    const androidMods = config.mods.android ?? {};

    const styles = await runAndroidMod(config, androidMods.styles, {
      resources: { style: [{ $: { name: 'AppTheme' } }] },
    });

    const buttonStyle = styles.resources.style?.find(
      style => style.$.name === 'AppAlertDialogButton'
    );
    expect(buttonStyle?.$.parent).toBe('Widget.AppCompat.Button.ButtonBar.AlertDialog');
    expect(styleValue(styles, 'AppAlertDialogButton', 'android:textAllCaps')).toBe('false');
    // Both spellings, because either alert layout may inflate the button bar.
    for (const item of ['buttonBarButtonStyle', 'android:buttonBarButtonStyle']) {
      expect(styleValue(styles, 'AppAlertDialogTheme', item)).toBe('@style/AppAlertDialogButton');
    }
  });

  it('keeps the alert dialog theme when the styles file has no style yet', async () => {
    // styles.xml can reach the mod without a `<style>` array (the plugin's
    // fallback path). Pushing the overlay into a throwaway array there would
    // silently drop it, so the mod must write the array back to modResults.
    const config = loadConfig();
    const androidMods = config.mods.android ?? {};

    const styles = await runAndroidMod(config, androidMods.styles, { resources: {} });

    expect(styles.resources.style?.map(style => style.$.name)).toEqual([
      'AppAlertDialogButton',
      'AppAlertDialogTheme',
    ]);
    expect(styleValue(styles, 'AppAlertDialogTheme', 'colorAccent')).toBe(
      '@color/app_dialog_action'
    );
  });

  it('keeps the one platform gate where the platform has the capability, and names the platform that lacks it', () => {
    // The plugin is Android-only by capability: it registers no iOS mod, so the
    // iOS prebuild has nothing to write. The doc comment names iOS and the
    // override the platform does not expose, the way the notification channel
    // writers name "No-op on iOS."
    expect(loadConfig().mods.ios).toBeUndefined();
    const source = readFileSync(PLUGIN_PATH, 'utf8');
    expect(source, 'the module must name the iOS alert type it cannot restyle').toMatch(
      /UIAlertController/
    );
    expect(source, 'the module must name the capability the platform lacks').toMatch(
      /no app-token capability to target/
    );
  });

  it('runs the shared native alert on both platforms', () => {
    expect(
      readFileSync(CONFIG_PATH, 'utf8').match(/withAndroidAlertDialogTheme/g) ?? []
    ).toHaveLength(1);
    const profile = readFileSync(PROFILE_PATH, 'utf8');
    // Signing out is the in-app `DestructiveConfirmDialog` (see
    // `use-sign-out-confirmation.ts`), so `Alert.alert` is not on that path;
    // deleting the account still confirms through the shared native alert this
    // plugin restyles, on both platforms.
    expect(profile, 'the delete-account confirmation is the shared native alert').toMatch(
      /Alert\.alert\(t\('profile\.deleteAccountTitle'\)/
    );
    expect(PLATFORM_BRANCH.test(profile), 'profile-screen.tsx carries a per-platform branch').toBe(
      false
    );
  });
});
