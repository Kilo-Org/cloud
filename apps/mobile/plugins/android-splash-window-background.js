/**
 * Native backing-surface adapter for the shared branded splash.
 *
 * Android lacks the root-backed storyboard loading view Expo uses on iOS;
 * its window drawable must cover the pre-React gap after the system splash
 * exits. This adapter does not hide the splash: AnimatedSplashOverlay owns
 * that lifecycle on BOTH platforms. The marker/delay below only restores the
 * otherwise-covered Android window background for later rotation.
 *
 * Three platform defaults break the branded launch, and each needs its own edit:
 *
 * 1. `expo-splash-screen` writes `Theme.App.SplashScreen` with the splash-screen
 *    attributes (`windowSplashScreenBackground`, `windowSplashScreenAnimatedIcon`)
 *    but never sets `android:windowBackground`. The theme therefore inherits the
 *    AppCompat DayNight default for the window surface — plain white in day mode —
 *    and any launch frame drawn before the splash window falls back to it: a bare
 *    white screen with no logo, wordmark or progress affordance (the cold-start
 *    finding `app-cold-loading`).
 *
 * 2. `postSplashScreenTheme` points the window at `AppTheme` as soon as the
 *    splash exits, and `AppTheme`'s window background is the app background. On
 *    Android 12+ the system dismisses its splash window about a second after the
 *    activity is created — long before the Metro bundle has loaded and rendered —
 *    so the window surface shows the bare, logo-less app background for the whole
 *    multi-second load. `Theme.App.Launch` keeps the brand drawable as the
 *    post-splash window surface, and `MainActivity` only hands the window back to
 *    the app background once the app's own React content appears.
 *
 * 3. Neither theme carries `android:windowLightStatusBar`, so the AppCompat
 *    DayNight default applies and in night mode the status-bar clock and icons
 *    are drawn light over the light brand drawable — unreadable (the
 *    `settings-account-ar` finding). No JS runs while this surface is up, so the
 *    appearance has to come from the theme: both themes carry the same light
 *    drawable, so dark icons are the readable choice. Once React mounts,
 *    `expo-status-bar` overrides the window appearance and the app theme takes
 *    over, so the app's own status bar is unaffected.
 *
 * The hand-back is keyed on React's `CONTENT_APPEARED` marker rather than the
 * first draw: the window draws at splash dismissal, seconds before React exists,
 * so a first-draw hand-back would restore the bare surface for the load. The
 * brand surface must not outlive the launch either — the rotation-surface plugin
 * pins `AppTheme`'s window background to the app background so a rotation never
 * paints a foreign frame until React draws again — hence the explicit hand-back
 * the moment the app content is up.
 *
 * Pure data in, data out: the config plugin in
 * `withBrandedSplash.js` owns the mod plumbing, and the unit
 * test drives this module directly.
 */

/** The style expo-splash-screen writes for the launch theme. */
const THEME_NAME = 'Theme.App.SplashScreen';
/** The window surface attribute Android falls back to before content draws. */
const WINDOW_BACKGROUND_ITEM = 'android:windowBackground';
/** Status-bar icon appearance; dark icons are readable on the light brand surface. */
const LIGHT_STATUS_BAR_ITEM = 'android:windowLightStatusBar';
const LIGHT_STATUS_BAR_VALUE = 'true';
/**
 * Navigation-bar icon appearance. The 3-button navigation bar is the same
 * light brand surface (AppTheme pins `navigationBarColor` transparent), so its
 * icons need the same dark treatment; the DayNight default draws them light on
 * both phases of the launch (explorer e4-brand-1). Unlike the status bar, no
 * JS overrides the navigation-bar appearance, so the hand-back below restores
 * the app's own DayNight default when React content appears.
 */
const LIGHT_NAVIGATION_BAR_ITEM = 'android:windowLightNavigationBar';
const LIGHT_NAVIGATION_BAR_VALUE = 'true';
/** The style Android hands the window to once the splash exits. */
const POST_SPLASH_THEME_ITEM = 'postSplashScreenTheme';
/** The post-splash theme: the app theme with the brand launch surface. */
const POST_SPLASH_THEME_NAME = 'Theme.App.Launch';
const POST_SPLASH_THEME_PARENT = '@style/AppTheme';
/** The splash color expo-splash-screen writes from `app.config.ts`. */
const SPLASH_BACKGROUND_COLOR = '@color/splashscreen_background';
/** Brand surface: the splash color with the dark Kilo mark centred on it. */
const SPLASH_WINDOW_DRAWABLE_NAME = 'splashscreen_window_background';
const SPLASH_WINDOW_DRAWABLE_REF = `@drawable/${SPLASH_WINDOW_DRAWABLE_NAME}`;
const SPLASH_LOGO_DRAWABLE_REF = '@drawable/splashscreen_logo';
/** The app background the rotation-surface plugin writes (values-night aware). */
const APP_BACKGROUND_COLOR_REF = 'R.color.app_background';
/** The expo `MainActivity` template's super call, the onCreate anchor. */
const ON_CREATE_SUPER_CALL = 'super.onCreate(null)';
/**
 * How long after React's `CONTENT_APPEARED` the window surface is handed back
 * to the app background. The marker fires when the React root gets its first
 * child, but the app's own opaque surfaces (the root provider views) paint a
 * beat later — on the emulator that gap is ~1.5 s, and the window background is
 * what shows through it. A late hand-back is invisible (the splash overlay and
 * then the app tree cover the window), so this only has to clear the paint gap
 * with margin; it is not a deadline.
 */
const LAUNCH_SURFACE_HAND_BACK_DELAY_MS = 3000;
/**
 * Hands the window surface back to the app background once the app's own
 * surfaces have painted, so the brand drawable only covers the launch and a
 * later rotation still paints the app background the rotation-surface plugin
 * pins to `AppTheme`.
 *
 * `ReactMarker` is a process-global registry, so the listener also has to be
 * dropped when the activity dies. A launch that never reaches
 * `CONTENT_APPEARED` — a bundle load failure, a crash before React mounts, or
 * the activity being destroyed while still loading — would otherwise leave the
 * listener registered and hold this activity and its whole view hierarchy for
 * the rest of the process, one leaked activity per recreation. The lifecycle
 * observer removes it on `ON_DESTROY`, which is the activity's own `onDestroy`.
 */
const ON_CREATE_INJECTION = [
  navigationBarRestoreHelperLines(),
  'val splashMarkerListener = object : com.facebook.react.bridge.ReactMarker.MarkerListener {',
  '  override fun logMarker(name: com.facebook.react.bridge.ReactMarkerConstants, tag: String?, instanceKey: Int) {',
  '    if (name != com.facebook.react.bridge.ReactMarkerConstants.CONTENT_APPEARED) return',
  '    com.facebook.react.bridge.ReactMarker.removeListener(this)',
  '    window.decorView.postDelayed({',
  `      if (!isFinishing) window.setBackgroundDrawableResource(${APP_BACKGROUND_COLOR_REF})`,
  '      restoreNavigationBarIconAppearance()',
  `    }, ${LAUNCH_SURFACE_HAND_BACK_DELAY_MS}L)`,
  '  }',
  '}',
  'com.facebook.react.bridge.ReactMarker.addListener(splashMarkerListener)',
  'lifecycle.addObserver(object : androidx.lifecycle.DefaultLifecycleObserver {',
  '  override fun onDestroy(owner: androidx.lifecycle.LifecycleOwner) {',
  '    com.facebook.react.bridge.ReactMarker.removeListener(splashMarkerListener)',
  '  }',
  '})',
]
  .flat()
  .map(line => `    ${line}`)
  .join('\n');

/**
 * Drops the launch theme's forced dark navigation-bar icons and hands the
 * appearance back to the app's own DayNight default. The launch themes carry
 * the brand drawable, but the running app draws its own background under a
 * transparent bar, so a night-mode app must get its light icons back.
 *
 * `AppTheme` inherits `Theme.AppCompat.DayNight`, whose light theme already
 * asks for dark navigation-bar icons and whose night variant does not, so the
 * matching default is the current configuration's night flag.
 *
 * Two APIs, one meaning: from API 30 `WindowInsetsController` carries the
 * appearance bit, and below it the same bit is the
 * `SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR` window flag (the flag the
 * `android:windowLightNavigationBar` theme item is implemented with). The
 * theme item applies from API 27, so the 27–29 range needs the flag cleared
 * for the same reason API 30+ does: the pinned dark icons otherwise stay over
 * the near-black night-mode app background. A local function of `onCreate`, so
 * the injected listener captures it.
 */
function navigationBarRestoreHelperLines() {
  return [
    'fun restoreNavigationBarIconAppearance() {',
    '  val nightMode =',
    '    (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==',
    '      android.content.res.Configuration.UI_MODE_NIGHT_YES',
    '  if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {',
    '    val appearance = android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS',
    '    val lightNavigationBars = if (nightMode) 0 else appearance',
    '    window.insetsController?.setSystemBarsAppearance(lightNavigationBars, appearance)',
    '    return',
    '  }',
    '  val lightNavigationBarFlag = android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR',
    '  val decorView = window.decorView',
    '  val visibility = decorView.systemUiVisibility',
    '  decorView.systemUiVisibility =',
    '    if (nightMode) (visibility and lightNavigationBarFlag.inv())',
    '    else (visibility or lightNavigationBarFlag)',
    '}',
  ];
}

function setItem(theme, name, value) {
  theme.item ??= [];
  const existing = theme.item.find(item => item.$?.name === name);
  if (existing) {
    existing._ = value;
    return;
  }
  theme.item.push({ $: { name }, _: value });
}

/**
 * Pins the launch theme's window surface to the brand splash drawable and hands
 * the post-splash window to `Theme.App.Launch`, which keeps the same drawable
 * until `MainActivity` restores the app background. Both themes also request
 * dark status-bar icons, since they carry the same light drawable and no JS is
 * running to set the appearance. A styles file without the splash theme (an
 * upstream that stopped emitting it, or a different prebuild order) is returned
 * unchanged so the plugin stays inert, matching the rotation-surface plugin.
 */
function applySplashWindowBackground(styles) {
  const themes = styles?.resources?.style ?? [];
  const splashTheme = themes.find(theme => theme.$?.name === THEME_NAME);
  if (!splashTheme) {
    return styles;
  }
  setItem(splashTheme, WINDOW_BACKGROUND_ITEM, SPLASH_WINDOW_DRAWABLE_REF);
  setItem(splashTheme, LIGHT_STATUS_BAR_ITEM, LIGHT_STATUS_BAR_VALUE);
  setItem(splashTheme, LIGHT_NAVIGATION_BAR_ITEM, LIGHT_NAVIGATION_BAR_VALUE);
  setItem(splashTheme, POST_SPLASH_THEME_ITEM, `@style/${POST_SPLASH_THEME_NAME}`);
  let postSplashTheme = themes.find(theme => theme.$?.name === POST_SPLASH_THEME_NAME);
  if (!postSplashTheme) {
    postSplashTheme = { $: { name: POST_SPLASH_THEME_NAME, parent: POST_SPLASH_THEME_PARENT } };
    themes.push(postSplashTheme);
  }
  setItem(postSplashTheme, WINDOW_BACKGROUND_ITEM, SPLASH_WINDOW_DRAWABLE_REF);
  setItem(postSplashTheme, LIGHT_STATUS_BAR_ITEM, LIGHT_STATUS_BAR_VALUE);
  setItem(postSplashTheme, LIGHT_NAVIGATION_BAR_ITEM, LIGHT_NAVIGATION_BAR_VALUE);
  return styles;
}

/**
 * The brand launch surface as a layer-list: the splash color with the dark Kilo
 * mark centred on it, so a launch frame that only draws the window surface still
 * shows the branded splash instead of a bare logo-less color.
 */
function splashWindowDrawable() {
  return `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
  <item android:drawable="${SPLASH_BACKGROUND_COLOR}" />
  <item android:drawable="${SPLASH_LOGO_DRAWABLE_REF}" android:gravity="center" />
</layer-list>
`;
}

/**
 * Hands the post-splash window surface back to the app background when the app's
 * React content appears. Idempotent; a file without the `onCreate` super call —
 * and a Java activity, where the Kotlin object member write would not compile —
 * is returned unchanged, so the plugin stays inert instead of breaking a
 * prebuild.
 */
function injectMainActivityLaunchSurface(contents, language) {
  if (
    language !== 'kt' ||
    contents.includes(ON_CREATE_INJECTION) ||
    !contents.includes(ON_CREATE_SUPER_CALL)
  ) {
    return contents;
  }
  return contents.replace(ON_CREATE_SUPER_CALL, `${ON_CREATE_SUPER_CALL}\n${ON_CREATE_INJECTION}`);
}

module.exports = {
  THEME_NAME,
  WINDOW_BACKGROUND_ITEM,
  LIGHT_STATUS_BAR_ITEM,
  LIGHT_STATUS_BAR_VALUE,
  LIGHT_NAVIGATION_BAR_ITEM,
  LIGHT_NAVIGATION_BAR_VALUE,
  POST_SPLASH_THEME_ITEM,
  POST_SPLASH_THEME_NAME,
  SPLASH_BACKGROUND_COLOR,
  SPLASH_WINDOW_DRAWABLE_NAME,
  SPLASH_WINDOW_DRAWABLE_REF,
  SPLASH_LOGO_DRAWABLE_REF,
  APP_BACKGROUND_COLOR_REF,
  ON_CREATE_SUPER_CALL,
  LAUNCH_SURFACE_HAND_BACK_DELAY_MS,
  ON_CREATE_INJECTION,
  applySplashWindowBackground,
  splashWindowDrawable,
  injectMainActivityLaunchSurface,
};
