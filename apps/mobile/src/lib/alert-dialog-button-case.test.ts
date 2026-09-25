// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';
// eslint-disable-next-line import/no-nodejs-modules -- runs the CommonJS config plugin with prebuild seams in node
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

// Contract guard for the Android alert-dialog button case.
//
// The defect is native: `Alert.alert()` renders through AppCompat's
// `AlertDialog` on Android, whose button bar inflates the actions with
// `?attr/buttonBarPositiveButtonStyle` / `Negative` / `Neutral`, resolved by
// the AppCompat theme to `Widget.AppCompat.Button.ButtonBar.AlertDialog` —
// whose text appearance sets `android:textAllCaps=true`. So the discard-draft
// confirm draws ALL-CAPS while every other button is sentence case
// (DESIGN.md:350). The prebuild plugin this suite guards re-cases the actions
// from the activity theme, keeping the stock parent so only the case changes.
// AppTheme is the carrier: AppCompat resolves the three `buttonBar*ButtonStyle`
// attrs through `alertDialogTheme`, which is `ThemeOverlay.AppCompat.Dialog.Alert`
// — a ThemeOverlay applied over the activity theme (ContextThemeWrapper copies
// the activity theme, then applies the overlay) that defines none of the three,
// so their lookups fall through to AppTheme.
//
// No host here has an Android device, so the fact the device would show is
// pinned here: the three button bar attrs point at `AppAlertDialogButton`, that
// style keeps the stock parent and flips only `android:textAllCaps`, an absent
// activity theme is left alone, the plugin registers an Android styles mod and
// nothing else, and the confirm stays one shared `Alert.alert` call site with
// no `Platform.OS` fork (iOS renders the same call as `UIAlertController`).

const readMobileFile = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)), 'utf8');

const pluginSource = readMobileFile('plugins/withAndroidAlertDialogButtonCase.js');
const appConfigSource = readMobileFile('app.config.ts');
const discardGuardSource = readMobileFile('src/components/agents/use-new-session-discard-guard.ts');

const PLUGIN_PATH = './plugins/withAndroidAlertDialogButtonCase';
const THEME_NAME = 'AppTheme';
const BUTTON_STYLE_NAME = 'AppAlertDialogButton';
const BUTTON_STYLE_PARENT = 'Widget.AppCompat.Button.ButtonBar.AlertDialog';
const BUTTON_BAR_STYLE_ITEMS = [
  'buttonBarPositiveButtonStyle',
  'buttonBarNegativeButtonStyle',
  'buttonBarNeutralButtonStyle',
];
const TEXT_ALL_CAPS_ITEM = 'android:textAllCaps';
const WINDOW_BACKGROUND_ITEM = 'android:windowBackground';

/**
 * A per-platform branch in shared JS: a `Platform.OS`/`Platform.select` check,
 * or an import of a platform-suffixed module. Narrower than a bare `Platform`
 * token so a comment, a type name, or an unrelated plugin reference does not
 * read as a fork (same shape as alert-dialog-platform-parity.test.ts).
 */
const PLATFORM_BRANCH =
  /\bPlatform\.(?:OS|select|Version)\b|from '[^']+\.(?:ios|android)'|require\('[^']+\.(?:ios|android)'\)/;

type StyleItem = { $?: { name?: string }; _?: string };
type Style = { $?: { name?: string; parent?: string }; item?: StyleItem[] };
type StylesTree = { resources: { style: Style[] } };
type StylesModConfig = { modResults: StylesTree };
type StylesMod = (config: StylesModConfig) => StylesModConfig;

/** The AppTheme tree the evaluated prebuild starts from: the rotation surface
 * plugin's window-background item is already there. */
const appThemeTree = (): StylesTree => ({
  resources: {
    style: [
      {
        $: { name: THEME_NAME },
        item: [{ $: { name: WINDOW_BACKGROUND_ITEM }, _: '@color/app_background' }],
      },
    ],
  },
});

/** Run the plugin source with a `expo/config-plugins` stub that records every
 * API member read and captures the styles mod it registers. */
function captureStylesMod(): { mod: StylesMod; apiAccesses: string[]; requiredIds: string[] } {
  const mods: StylesMod[] = [];
  const apiAccesses: string[] = [];
  const requiredIds: string[] = [];
  const pluginModule = { exports: (input: StylesModConfig) => input };
  const pluginApi = new Proxy(
    {},
    {
      get: (_target, property: string | symbol) => {
        apiAccesses.push(String(property));
        if (property === 'withAndroidStyles') {
          return (input: StylesModConfig, mod: StylesMod) => {
            mods.push(mod);
            return input;
          };
        }
        return undefined;
      },
    }
  );
  runInNewContext(pluginSource, {
    __dirname: '/mobile/plugins',
    module: pluginModule,
    require: (id: string) => {
      requiredIds.push(id);
      return pluginApi;
    },
  });
  pluginModule.exports({ modResults: { resources: { style: [] } } });
  const [mod] = mods;
  if (!mod) {
    throw new Error('the plugin registered no Android styles mod');
  }
  return { mod, apiAccesses, requiredIds };
}

describe('Android alert-dialog button case plugin', () => {
  it('points the three button bar styles at the sentence-case style', () => {
    const { mod } = captureStylesMod();
    const result = mod({ modResults: appThemeTree() });
    const appTheme = result.modResults.resources.style.find(style => style.$?.name === THEME_NAME);
    for (const item of BUTTON_BAR_STYLE_ITEMS) {
      const entry = appTheme?.item?.find(candidate => candidate.$?.name === item);
      expect(entry?._).toBe(`@style/${BUTTON_STYLE_NAME}`);
    }
    // The rotation surface plugin's item survives: setItem rewrites an item in
    // place rather than replacing the theme's items.
    expect(appTheme?.item?.some(candidate => candidate.$?.name === WINDOW_BACKGROUND_ITEM)).toBe(
      true
    );
    // Nothing may write `alertDialogTheme`: AppCompat's value is the
    // ThemeOverlay that supplies the dialog's window properties and defines
    // none of the three button-bar attrs, so the three reach the dialog through
    // AppTheme (the assertion above) and a second carrier would only risk
    // dropping that overlay.
    const allItems = result.modResults.resources.style.flatMap(style => style.item ?? []);
    expect(allItems.some(item => item.$?.name === 'alertDialogTheme')).toBe(false);
    // And they must be the appcompat attrs the dialog's button-bar layout reads
    // (`style="?attr/buttonBarPositiveButtonStyle"`): the framework's
    // `android:buttonBar*ButtonStyle` ids are separate attrs the layout never
    // looks up, so writing those would leave the actions ALL-CAPS.
    for (const item of BUTTON_BAR_STYLE_ITEMS) {
      expect(allItems.some(candidate => candidate.$?.name === `android:${item}`)).toBe(false);
    }
  });

  it('keeps the stock button parent and flips only android:textAllCaps', () => {
    const { mod } = captureStylesMod();
    const result = mod({ modResults: appThemeTree() });
    const buttonStyle = result.modResults.resources.style.find(
      style => style.$?.name === BUTTON_STYLE_NAME
    );
    // The stock parent is what preserves the button bar's metrics and colors
    // (minWidth 64dp, minHeight @dimen/abc_alert_dialog_button_bar_height), so
    // only the case changes and the row's layout is unchanged.
    expect(buttonStyle?.$?.parent).toBe(BUTTON_STYLE_PARENT);
    const caps = buttonStyle?.item?.find(item => item.$?.name === TEXT_ALL_CAPS_ITEM);
    expect(caps?._).toBe('false');
  });

  it('returns the tree unchanged when the activity theme is absent', () => {
    const { mod } = captureStylesMod();
    const tree: StylesTree = {
      resources: { style: [{ $: { name: 'Theme.App.SplashScreen' }, item: [] }] },
    };
    const before = JSON.stringify(tree);
    const result = mod({ modResults: tree });
    expect(JSON.stringify(result.modResults)).toBe(before);
    expect(result.modResults.resources.style).toHaveLength(1);
    expect(
      result.modResults.resources.style.some(style => style.$?.name === BUTTON_STYLE_NAME)
    ).toBe(false);
  });

  it('registers one Android styles mod and nothing else', () => {
    const { apiAccesses, requiredIds } = captureStylesMod();
    // One platform-specific piece: the plugin reads withAndroidStyles only, so
    // there is no iOS mod and no other mod type on this path.
    expect(apiAccesses).toEqual(['withAndroidStyles']);
    expect(requiredIds).toEqual(['expo/config-plugins']);
  });

  it('is registered in the evaluated app config exactly once', () => {
    const occurrences = appConfigSource.split(`'${PLUGIN_PATH}'`).length - 1;
    expect(occurrences).toBe(1);
    // One shared config for both platforms: a platform branch around the
    // registration would be the only way to fork it, and there is none.
    expect(appConfigSource).not.toMatch(PLATFORM_BRANCH);
  });

  it('leaves the discard confirm as one shared Alert.alert call site', () => {
    // Parity guard: Android and iOS share the one call. The fix re-cases the
    // Android render; it does not fork the call site by platform. The guard
    // matches the branch shapes a later edit could reach for (`Platform.OS`,
    // `Platform.select`, a platform-specific import) rather than a bare
    // `Platform` token, so a comment or an unrelated reference is not a fork.
    expect(discardGuardSource.match(/Alert\.alert\(/g)).toHaveLength(1);
    expect(discardGuardSource).toContain("i18n.t('common.keepEditing')");
    expect(discardGuardSource).toContain("i18n.t('common.discard')");
    expect(discardGuardSource).not.toMatch(PLATFORM_BRANCH);
  });

  it('reads a real platform fork but not a bare Platform token', () => {
    // The guard's intent is a per-platform fork, not the word itself: a
    // comment, a type name, or an unrelated module reference must not fail it.
    expect(PLATFORM_BRANCH.test('// Platform-specific plugin, registered once')).toBe(false);
    expect(PLATFORM_BRANCH.test("require('react-native')")).toBe(false);
    // The shapes a later edit could actually fork with still must.
    expect(PLATFORM_BRANCH.test("if (Platform.OS === 'android') return;")).toBe(true);
    expect(PLATFORM_BRANCH.test('Platform.select({ android: 1, default: 2 })')).toBe(true);
    expect(PLATFORM_BRANCH.test("import { button } from './alert-button.android'")).toBe(true);
  });
});
