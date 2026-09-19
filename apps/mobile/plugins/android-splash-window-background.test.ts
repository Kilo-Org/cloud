import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

type StyleItem = { $: { name: string }; _?: string };
type StyleGroup = { $: { name: string; parent?: string }; item?: StyleItem[] };
type StylesXml = { resources: { style: StyleGroup[] } };

const require = createRequire(import.meta.url);
const {
  LAUNCH_SURFACE_HAND_BACK_DELAY_MS,
  ON_CREATE_INJECTION,
  ON_CREATE_SUPER_CALL,
  POST_SPLASH_THEME_ITEM,
  POST_SPLASH_THEME_NAME,
  SPLASH_BACKGROUND_COLOR,
  SPLASH_LOGO_DRAWABLE_REF,
  SPLASH_WINDOW_DRAWABLE_REF,
  THEME_NAME,
  WINDOW_BACKGROUND_ITEM,
  applySplashWindowBackground,
  injectMainActivityLaunchSurface,
  splashWindowDrawable,
} = require('./android-splash-window-background.js') as {
  LAUNCH_SURFACE_HAND_BACK_DELAY_MS: number;
  ON_CREATE_INJECTION: string;
  ON_CREATE_SUPER_CALL: string;
  POST_SPLASH_THEME_ITEM: string;
  POST_SPLASH_THEME_NAME: string;
  SPLASH_BACKGROUND_COLOR: string;
  SPLASH_LOGO_DRAWABLE_REF: string;
  SPLASH_WINDOW_DRAWABLE_REF: string;
  THEME_NAME: string;
  WINDOW_BACKGROUND_ITEM: string;
  applySplashWindowBackground: (styles: StylesXml) => StylesXml;
  injectMainActivityLaunchSurface: (contents: string, language: string) => string;
  splashWindowDrawable: () => string;
};

// The shape expo-splash-screen's style mod writes: the launch theme carries the
// splash attributes only, and AppTheme owns the post-splash window surface.
function splashStyles(): StylesXml {
  return {
    resources: {
      style: [
        {
          $: { name: 'AppTheme', parent: 'Theme.AppCompat.DayNight.NoActionBar' },
          item: [{ $: { name: WINDOW_BACKGROUND_ITEM }, _: '@color/app_background' }],
        },
        {
          $: { name: THEME_NAME, parent: 'Theme.SplashScreen' },
          item: [
            { $: { name: 'windowSplashScreenBackground' }, _: SPLASH_BACKGROUND_COLOR },
            { $: { name: 'windowSplashScreenAnimatedIcon' }, _: '@drawable/splashscreen_logo' },
            { $: { name: POST_SPLASH_THEME_ITEM }, _: '@style/AppTheme' },
          ],
        },
      ],
    },
  };
}

// The onCreate expo-splash-screen's mod writes into the generated MainActivity.
const MAIN_ACTIVITY = `package com.kilocode.kiloapp
import expo.modules.splashscreen.SplashScreenManager

import android.os.Bundle

import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // @generated begin expo-splashscreen - expo prebuild (DO NOT MODIFY) sync-f3ff59a738c56c9a6119210cb55f0b613eb8b6af
    SplashScreenManager.registerOnActivity(this)
    // @generated end expo-splashscreen
    ${ON_CREATE_SUPER_CALL}
  }
}`;

function styleNamed(styles: StylesXml, name: string): StyleGroup {
  const theme = styles.resources.style.find(group => group.$?.name === name);
  if (!theme) {
    throw new Error(`missing ${name}`);
  }
  return theme;
}

function itemsNamed(theme: StyleGroup, name: string): StyleItem[] {
  return (theme.item ?? []).filter(item => item.$?.name === name);
}

describe('applySplashWindowBackground', () => {
  it('pins the launch theme window background to the brand launch surface', () => {
    const styles = applySplashWindowBackground(splashStyles());

    const pinned = itemsNamed(styleNamed(styles, THEME_NAME), WINDOW_BACKGROUND_ITEM);
    expect(pinned).toHaveLength(1);
    expect(pinned[0]?._).toBe(SPLASH_WINDOW_DRAWABLE_REF);
  });

  it('keeps the brand surface after the splash exits', () => {
    const styles = applySplashWindowBackground(splashStyles());

    const postSplash = itemsNamed(styleNamed(styles, THEME_NAME), POST_SPLASH_THEME_ITEM);
    expect(postSplash[0]?._).toBe(`@style/${POST_SPLASH_THEME_NAME}`);
    const launchTheme = styleNamed(styles, POST_SPLASH_THEME_NAME);
    expect(launchTheme.$?.parent).toBe('@style/AppTheme');
    expect(itemsNamed(launchTheme, WINDOW_BACKGROUND_ITEM)[0]?._).toBe(SPLASH_WINDOW_DRAWABLE_REF);
  });

  it('leaves the post-splash AppTheme window background on the app background', () => {
    const styles = applySplashWindowBackground(splashStyles());

    const appTheme = styleNamed(styles, 'AppTheme');
    expect(itemsNamed(appTheme, WINDOW_BACKGROUND_ITEM)[0]?._).toBe('@color/app_background');
  });

  it('is idempotent: re-applying does not duplicate style items', () => {
    const styles = applySplashWindowBackground(applySplashWindowBackground(splashStyles()));

    expect(itemsNamed(styleNamed(styles, THEME_NAME), WINDOW_BACKGROUND_ITEM)).toHaveLength(1);
    expect(
      styles.resources.style.filter(group => group.$?.name === POST_SPLASH_THEME_NAME)
    ).toHaveLength(1);
  });

  it('stays inert when the launch theme is absent', () => {
    const styles: StylesXml = { resources: { style: [] } };

    expect(applySplashWindowBackground(styles)).toEqual(styles);
  });
});

describe('splashWindowDrawable', () => {
  it('draws the splash color with the dark Kilo mark centred on it', () => {
    const drawable = splashWindowDrawable();

    expect(drawable).toContain(`android:drawable="${SPLASH_BACKGROUND_COLOR}"`);
    expect(drawable).toContain(`android:drawable="${SPLASH_LOGO_DRAWABLE_REF}"`);
    expect(drawable).toContain('android:gravity="center"');
  });
});

describe('injectMainActivityLaunchSurface', () => {
  it('hands the window surface back to the app background after the app surfaces paint', () => {
    const contents = injectMainActivityLaunchSurface(MAIN_ACTIVITY, 'kt');

    expect(contents).toContain(`${ON_CREATE_SUPER_CALL}\n${ON_CREATE_INJECTION}`);
    expect(contents).toContain('ReactMarkerConstants.CONTENT_APPEARED');
    expect(contents).toContain('R.color.app_background');
    // The hand-back is delayed past React's marker: the window background shows
    // through the app tree for a beat after `CONTENT_APPEARED`, and restoring it
    // there is exactly the bare frame this plugin exists to remove.
    expect(contents).toContain('window.decorView.postDelayed({');
    expect(contents).toContain(`${LAUNCH_SURFACE_HAND_BACK_DELAY_MS}L`);
    // The window must never be held: the system dismisses its splash ~1 s in.
    expect(contents).not.toContain('addOnPreDrawListener');
  });

  it('is idempotent: re-applying does not duplicate the injection', () => {
    const once = injectMainActivityLaunchSurface(MAIN_ACTIVITY, 'kt');
    const twice = injectMainActivityLaunchSurface(once, 'kt');

    expect(twice).toBe(once);
  });

  it('drops the marker listener when the activity is destroyed', () => {
    const contents = injectMainActivityLaunchSurface(MAIN_ACTIVITY, 'kt');

    // ReactMarker is a process-global registry: a launch that never reaches
    // CONTENT_APPEARED — a bundle load failure, a crash before React mounts, or
    // the activity being destroyed while loading — must not keep the activity
    // and its whole view hierarchy alive, so removal is tied to the activity
    // lifecycle and not only to the marker.
    expect(contents).toContain('lifecycle.addObserver(');
    expect(contents).toContain('override fun onDestroy(');
    expect(contents).toContain('ReactMarker.removeListener(splashMarkerListener)');
    expect(contents.match(/ReactMarker\.addListener\(/g)).toHaveLength(1);
  });

  it('stays inert on a Java activity, where the Kotlin write would not compile', () => {
    expect(injectMainActivityLaunchSurface(MAIN_ACTIVITY, 'java')).toBe(MAIN_ACTIVITY);
  });

  it('stays inert when the onCreate super call is absent', () => {
    const contents = 'class MainActivity : ReactActivity()';

    expect(injectMainActivityLaunchSurface(contents, 'kt')).toBe(contents);
  });
});
