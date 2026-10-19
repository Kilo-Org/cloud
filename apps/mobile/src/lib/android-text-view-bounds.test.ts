// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';
// eslint-disable-next-line import/no-nodejs-modules -- runs the CommonJS config plugin with prebuild seams in node
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

// Contract guard for the Android text-bounds alignment.
//
// Android 15 draws and breaks `TextView` text from glyph ink bounds when the app
// targets API 35+, while React Native 0.86 measures it from advances. A fallback
// system font (the script the app does not ship, e.g. Hindi) reports bounds that
// push the last word into a line React Native never measured, and the view
// clips it. The prebuild plugin this suite guards points the activity theme's
// `android:textViewStyle` at the appcompat text style with
// `android:useBoundsForWidth=false`, so drawing and measurement share the
// advances basis again.

const readMobileFile = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)), 'utf8');

const pluginSource = readMobileFile('plugins/withAndroidTextViewBounds.js');
const appConfigSource = readMobileFile('app.config.ts');

const PLUGIN_PATH = './plugins/withAndroidTextViewBounds';
const THEME_NAME = 'AppTheme';
const TEXT_STYLE_NAME = 'AppTextView';
const TEXT_STYLE_PARENT = 'Widget.AppCompat.TextView';
const TEXT_VIEW_STYLE_ITEM = 'android:textViewStyle';
const USE_BOUNDS_ITEM = 'android:useBoundsForWidth';
const EXISTING_ITEM = 'android:windowBackground';

type StyleItem = { $?: { name?: string }; _?: string };
type Style = { $?: { name?: string; parent?: string }; item?: StyleItem[] };
type StylesTree = { resources: { style: Style[] } };
type StylesModConfig = { modResults: StylesTree };
type StylesMod = (config: StylesModConfig) => StylesModConfig;

const appThemeTree = (): StylesTree => ({
  resources: {
    style: [
      {
        $: { name: THEME_NAME },
        item: [{ $: { name: EXISTING_ITEM }, _: '@color/app_background' }],
      },
    ],
  },
});

function captureStylesMod(): {
  mod: StylesMod;
  apiAccesses: string[];
  requiredIds: string[];
} {
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

describe('Android text-view bounds plugin', () => {
  it('points the activity theme at an advance-measured text style', () => {
    const { mod } = captureStylesMod();
    const result = mod({ modResults: appThemeTree() });
    const appTheme = result.modResults.resources.style.find(style => style.$?.name === THEME_NAME);
    const item = appTheme?.item?.find(candidate => candidate.$?.name === TEXT_VIEW_STYLE_ITEM);
    expect(item?._).toBe(`@style/${TEXT_STYLE_NAME}`);
    // Adding the text style must not replace the theme's other items: prebuild
    // mods from other plugins run on the same tree.
    expect(appTheme?.item?.some(candidate => candidate.$?.name === EXISTING_ITEM)).toBe(true);
  });

  it('keeps the appcompat text parent and flips only android:useBoundsForWidth', () => {
    const { mod } = captureStylesMod();
    const result = mod({ modResults: appThemeTree() });
    const textStyle = result.modResults.resources.style.find(
      style => style.$?.name === TEXT_STYLE_NAME
    );
    // Widget.AppCompat.TextView is what AppCompat itself installs as
    // android:textViewStyle; keeping it preserves every other text attribute.
    expect(textStyle?.$?.parent).toBe(TEXT_STYLE_PARENT);
    expect(textStyle?.item).toEqual([{ $: { name: USE_BOUNDS_ITEM }, _: 'false' }]);
  });

  it('rewrites the existing style on a second prebuild instead of duplicating it', () => {
    const { mod } = captureStylesMod();
    const once = mod({ modResults: appThemeTree() });
    const twice = mod(once);
    const textStyles = twice.modResults.resources.style.filter(
      style => style.$?.name === TEXT_STYLE_NAME
    );
    expect(textStyles).toHaveLength(1);
    expect(textStyles[0]?.item).toHaveLength(1);
    const appThemeItems = twice.modResults.resources.style
      .find(style => style.$?.name === THEME_NAME)
      ?.item?.filter(item => item.$?.name === TEXT_VIEW_STYLE_ITEM);
    expect(appThemeItems).toHaveLength(1);
  });

  it('returns the tree unchanged when the activity theme is absent', () => {
    const { mod } = captureStylesMod();
    const tree: StylesTree = {
      resources: { style: [{ $: { name: 'Theme.App.SplashScreen' }, item: [] }] },
    };
    const before = JSON.stringify(tree);
    const result = mod({ modResults: tree });
    expect(JSON.stringify(result.modResults)).toBe(before);
  });

  it('registers one Android styles mod and nothing else', () => {
    const { apiAccesses, requiredIds } = captureStylesMod();
    expect(apiAccesses).toEqual(['withAndroidStyles']);
    expect(requiredIds).toEqual(['expo/config-plugins']);
  });

  it('is registered in the evaluated app config exactly once', () => {
    expect(appConfigSource.split(`'${PLUGIN_PATH}'`).length - 1).toBe(1);
  });
});
