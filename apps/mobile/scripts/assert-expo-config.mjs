import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENV_KEYS } from '../src/lib/env-keys.js';

// Contract values mirrored from app.config.ts (bundle id, package, scheme,
// orientation, associated domain, app name, blocked and requested permissions,
// and Sentry plugin). ENV_KEYS is imported live from src/lib/env-keys.js. The
// script runs the full evaluated config, so these must match the resolved
// build-time output, not the raw app.config.ts source.
const BUNDLE_IDENTIFIER = 'com.kilocode.kiloapp';
const ANDROID_PACKAGE = 'com.kilocode.kiloapp';
const SCHEME = 'kiloapp';
const ASSOCIATED_DOMAIN = 'applinks:app.kilo.ai';
// The passkey relying-party claim on iOS. The claim is split by platform: iOS
// carries its half here (the Associated Domains entitlement the platform
// authenticator reads), Android carries its half in the served Digital Asset
// Links file, whose `delegate_permission/common.get_login_creds` relation
// apps/web/src/lib/app-site-association.test.ts pins. Both halves name the one
// relying-party host, app.kilo.ai.
const PASSKEY_ASSOCIATED_DOMAIN = 'webcredentials:app.kilo.ai';
// Expo Head's handoff origin (extra.router.headOrigin). It is the origin of
// ASSOCIATED_DOMAIN above: the session link the app advertises and the
// universal link the app claims have to be the same URL.
const HEAD_ORIGIN = 'https://app.kilo.ai';
// Time Sensitive Notifications capability: the iOS half of the needs-input
// raise's `interruptionLevel: 'timeSensitive'` break-through contract.
const TIME_SENSITIVE_ENTITLEMENT = 'com.apple.developer.usernotifications.time-sensitive';
// The app name (app.config.ts `name`). `$(PRODUCT_NAME)` resolves to this in
// the base Info.plist, but `.lproj/InfoPlist.strings` is compiled verbatim, so
// the localized copy has to spell it out.
const APP_NAME = 'Kilo';
const BLOCKED_PERMISSIONS = [
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_AUDIO',
];
// Permissions the app itself must request. Android only offers the Do Not
// Disturb access grant (Settings > Special app access) to an app declaring this
// normal-protection marker, and without that grant AOSP resets a channel's
// app-requested `bypassDnd` to false. Checked as a subset: plugins add their own
// permissions (RECORD_AUDIO, USE_BIOMETRIC, USE_FINGERPRINT, ACCESS_COARSE/
// FINE_LOCATION, AD_ID), so the evaluated array is never exactly this list.
const REQUESTED_PERMISSIONS = ['android.permission.ACCESS_NOTIFICATION_POLICY'];
const SENTRY_PLUGIN = '@sentry/react-native/expo';
const ROTATION_SURFACE_PLUGIN = './plugins/withAndroidRotationSurface';
// Android-only by capability: AppCompat's stock button-bar text appearance
// forces ALL-CAPS, while iOS's `UIAlertController` draws the same shared
// `Alert.alert` copy as given and exposes no casing transform. The plugin's one
// platform piece is the AppTheme override; it is registered once for both
// prebuilds, so the fix behaves the same on iOS and Android.
const ALERT_DIALOG_BUTTON_CASE_PLUGIN = './plugins/withAndroidAlertDialogButtonCase';
// The alert dialog theme points AppCompat's DayNight defaults
// (`colorBackgroundFloating`, `colorAccent`) at the app's surfaces; without it
// every `Alert.alert()` confirmation renders as a foreign grey/teal panel.
const ALERT_DIALOG_THEME_PLUGIN = './plugins/withAndroidAlertDialogTheme';
// One entry configures Expo's native splash on both platforms. Its internal
// Android backing-surface adapter is a documented native capability exception,
// not a separate launch lifecycle. The wrapper owns the mod ordering.
const BRANDED_SPLASH_PLUGIN = './plugins/withBrandedSplash';
const ARTIFACT_FILE_PROVIDER_PLUGIN = './plugins/withArtifactFileProvider';
// The one writer of the app target's `<tag>.lproj/Localizable.strings`: the App
// Intent copy plus the appended Focus-filter catalog.
const APP_INTENT_LOCALIZATIONS_PLUGIN = './plugins/withAppIntentLocalizations';
// The developer menu is not the product. On iOS `DevMenuManager` auto-shows it
// over the app at launch while onboarding is unfinished or EXDevMenuShowsAtLaunch
// is set, and its SwiftUI icons carry raw SF Symbol names as accessibility labels
// (`chevron.left.chevron.right` on "Open DevTools", `gearshape.fill` on the
// floating tool button), so a scene dump of the product screen under it reads
// them aloud as-is. These options keep it off the product screens; a developer
// still opens it with Ctrl + d or a shake. Mirrored from
// src/lib/dev-client-plugin.js -- asserted on the EVALUATED config, because a
// config that stopped handing the plugin the options would still evaluate to the
// dev-menu defaults (auto-show on, onboarding on).
const DEV_CLIENT_PLUGIN = 'expo-dev-client';
const DEV_CLIENT_PLUGIN_OPTIONS = {
  toolsButton: false,
  showMenuAtLaunch: false,
  skipOnboarding: true,
};
const PERMISSION_PROMPT_PLIST_KEYS = [
  'NSMicrophoneUsageDescription',
  'NSSpeechRecognitionUsageDescription',
  'NSFaceIDUsageDescription',
  'NSLocationWhenInUseUsageDescription',
  'NSUserTrackingUsageDescription',
];

const mobileDir = join(dirname(fileURLToPath(import.meta.url)), '..');

let raw;
try {
  raw = execFileSync('npx', ['expo', 'config', '--json'], {
    cwd: mobileDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
} catch (error) {
  console.error(`Failed to run "npx expo config --json" from ${mobileDir}: ${error.message}`);
  process.exit(1);
}

let config;
try {
  config = JSON.parse(raw);
} catch (error) {
  console.error(`"npx expo config --json" returned invalid JSON: ${error.message}`);
  process.exit(1);
}

const failures = [];

function check(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

check(
  config.ios?.bundleIdentifier === BUNDLE_IDENTIFIER,
  `ios.bundleIdentifier must be "${BUNDLE_IDENTIFIER}"`
);
check(config.android?.package === ANDROID_PACKAGE, `android.package must be "${ANDROID_PACKAGE}"`);
check(config.scheme === SCHEME, `scheme must be "${SCHEME}"`);

// Rotation contract: all device orientations enabled (portrait + both
// landscapes on iOS, all orientations on Android), while iPad multitasking
// stays off — requireFullScreen keeps Split View/Slide Over out of scope.
check(config.orientation === 'default', `orientation must be "default"`);
check(
  config.ios?.requireFullScreen === true,
  'ios.requireFullScreen must be true (iPad Split View/Slide Over stays out of scope)'
);

// Platforms contract: the app is iOS and Android only (apps/mobile/AGENTS.md).
// Expo detects the platform set when the config does not declare one
// (getSupportedPlatforms): `react-native` resolving adds ios and android, and
// `react-dom` resolving adds web. The dev server recorded in
// dev/logs/mobile.log had web in its manifest platforms, so it answered a
// browser request with the web index.html; that page requests a web bundle of
// apps/mobile/index.js, where babel-preset-expo rewrites `react-native` to
// `react-native-web` (not installed), and Metro logs
// `Unable to resolve "react-native-web/dist/exports/AppRegistry"` into the app
// console — a JavaScript error the app never causes. Declaring the two
// platforms makes ManifestMiddleware.checkBrowserRequestAsync false, so a
// browser request falls through to the manifest response instead.
const PLATFORMS = ['ios', 'android'];
check(
  Array.isArray(config.platforms) &&
    config.platforms.length === PLATFORMS.length &&
    PLATFORMS.every(platform => config.platforms.includes(platform)),
  `platforms must be exactly [${PLATFORMS.join(', ')}] (web is not a product target; it bundles an unsupported platform and logs a Metro resolve error into the app console)`
);

const associatedDomains = config.ios?.associatedDomains ?? [];
check(
  associatedDomains.includes(ASSOCIATED_DOMAIN),
  `ios.associatedDomains must contain "${ASSOCIATED_DOMAIN}"`
);
check(
  associatedDomains.includes(PASSKEY_ASSOCIATED_DOMAIN),
  `ios.associatedDomains must contain "${PASSKEY_ASSOCIATED_DOMAIN}"`
);

// Session handoff: expo-router's Head builds the advertised NSUserActivity URL
// from extra.router.headOrigin and throws in development when it is missing
// (expo-router/build/head/url.js), so an empty `router` silently disables every
// session handoff on iOS.
check(
  config.extra?.router?.headOrigin === HEAD_ORIGIN,
  `extra.router.headOrigin must be "${HEAD_ORIGIN}"`
);

// iOS honors `UNNotificationInterruptionLevel.timeSensitive` only when the app
// carries the Time Sensitive Notifications capability; without it the
// needs-input raise is demoted to the platform default and stays quiet in Focus.
check(
  config.ios?.entitlements?.[TIME_SENSITIVE_ENTITLEMENT] === true,
  `ios.entitlements must enable the Time Sensitive Notifications capability (${TIME_SENSITIVE_ENTITLEMENT})`
);

const blockedPermissions = config.android?.blockedPermissions ?? [];
const blockedPermissionsMatch =
  blockedPermissions.length === BLOCKED_PERMISSIONS.length &&
  BLOCKED_PERMISSIONS.every(permission => blockedPermissions.includes(permission));
check(
  blockedPermissionsMatch,
  `android.blockedPermissions must equal exactly [${BLOCKED_PERMISSIONS.join(', ')}]`
);

const requestedPermissions = config.android?.permissions ?? [];
const missingRequestedPermissions = REQUESTED_PERMISSIONS.filter(
  permission => !requestedPermissions.includes(permission)
);
check(
  missingRequestedPermissions.length === 0,
  `android.permissions must include [${missingRequestedPermissions.join(', ')}]`
);

// iOS permission prompts: Expo's built-in `withLocales` reads the top-level
// `locales` field at prebuild and writes one InfoPlist.strings per tag. The
// evaluated config is the integration guard the unit test cannot give: it
// exercises app.config.ts's real module resolution and the JSON import.
const localizations = config.ios?.infoPlist?.CFBundleLocalizations ?? [];
const locales = config.locales ?? {};
check(
  Object.keys(locales).length === localizations.length,
  `top-level locales must cover every CFBundleLocalization (${localizations.length})`
);
for (const tag of localizations) {
  check(
    Boolean(locales[tag]?.ios) && typeof locales[tag].ios === 'object',
    `locales["${tag}"].ios must be an object`
  );
  // The app target's `<tag>.lproj/Localizable.strings` has exactly one writer:
  // `withAppIntentLocalizations`, which also carries the Focus-filter catalog.
  // Expo's `withLocales` registers a second file at the same bundle path when
  // this key is present, and Xcode fails the build with "Multiple commands
  // produce …/Localizable.strings".
  check(
    !Object.hasOwn(locales[tag]?.ios ?? {}, 'Localizable.strings'),
    `locales["${tag}"].ios must not declare Localizable.strings — Expo would register a second copy beside the App Intent catalog`
  );
  for (const key of PERMISSION_PROMPT_PLIST_KEYS) {
    const value = locales[tag]?.ios?.[key];
    check(
      typeof value === 'string' && value.length > 0,
      `locales["${tag}"].ios["${key}"] must be a non-empty string`
    );
  }
  // `.lproj/InfoPlist.strings` is compiled verbatim — Xcode expands
  // `$(PRODUCT_NAME)` only in Info.plist — so the localized copy must name the
  // app instead of keeping the variable, or the prompt shows it literally.
  check(
    locales[tag]?.ios?.NSLocationWhenInUseUsageDescription?.includes('$(PRODUCT_NAME)') === false,
    `locales["${tag}"].ios.NSLocationWhenInUseUsageDescription must not keep $(PRODUCT_NAME)`
  );
  check(
    locales[tag]?.ios?.NSLocationWhenInUseUsageDescription?.includes(APP_NAME) === true,
    `locales["${tag}"].ios.NSLocationWhenInUseUsageDescription must name the app "${APP_NAME}"`
  );
}

const pluginNames = (config.plugins ?? []).map(plugin =>
  Array.isArray(plugin) ? plugin[0] : plugin
);
check(pluginNames.includes(SENTRY_PLUGIN), `plugins must include "${SENTRY_PLUGIN}"`);
// The rotation surface plugin pins the Android window background to the theme
// background; without it a rotation paints the AppCompat DayNight default
// until React's first frame lands in the new orientation.
check(
  pluginNames.includes(ROTATION_SURFACE_PLUGIN),
  `plugins must include "${ROTATION_SURFACE_PLUGIN}"`
);
// Android alert-dialog actions must render in the app's sentence case: the
// AppCompat button bar draws them ALL-CAPS, which contradicts the app's copy
// (DESIGN.md:350). The plugin re-cases them from the activity theme.
check(
  pluginNames.includes(ALERT_DIALOG_BUTTON_CASE_PLUGIN),
  `plugins must include "${ALERT_DIALOG_BUTTON_CASE_PLUGIN}"`
);
// The alert dialog theme repaints AppCompat's stock dialog surface and accent
// with the app's own tokens; without it the sign-out confirmation (and every
// other Alert.alert) is the DayNight default grey/teal.
check(
  pluginNames.includes(ALERT_DIALOG_THEME_PLUGIN),
  `plugins must include "${ALERT_DIALOG_THEME_PLUGIN}"`
);
const splashEntries = (config.plugins ?? []).filter(
  plugin => Array.isArray(plugin) && plugin[0] === BRANDED_SPLASH_PLUGIN
);
check(splashEntries.length === 1, `plugins must include exactly one "${BRANDED_SPLASH_PLUGIN}"`);
check(
  !pluginNames.includes('expo-splash-screen') &&
    !pluginNames.includes('./plugins/withAndroidSplashWindowBackground'),
  'the shared branded splash must own native splash registration and mod ordering'
);
const splashOptions = splashEntries[0]?.[1];
check(
  splashOptions?.image === './assets/images/logo-mark.png' &&
    splashOptions.backgroundColor === '#FAF74F' &&
    splashOptions.imageWidth === 100,
  'the shared native splash must match AnimatedSplashOverlay: yellow with the 100dp Kilo mark'
);
check(
  splashOptions?.ios === undefined && splashOptions?.android === undefined,
  'the branded splash must not fork its options by platform'
);
// The iOS File Provider extension target and the Pods integration behind it are
// created by this plugin alone; without it the Files-app location has no
// extension to serve it.
check(
  pluginNames.includes(ARTIFACT_FILE_PROVIDER_PLUGIN),
  `plugins must include "${ARTIFACT_FILE_PROVIDER_PLUGIN}"`
);
// Same reason one layer down: EAS only builds and signs the extension from its
// `appExtensions` entry, and the evaluated config is the only place that shows
// the entry the plugin composed.
const appExtensions = config.extra?.eas?.build?.experimental?.ios?.appExtensions ?? [];
check(
  appExtensions.some(extension => extension.targetName === 'ArtifactsFileProvider'),
  'extra.eas.build.experimental.ios.appExtensions must carry the ArtifactsFileProvider target'
);
// The app target's one `Localizable.strings` (the App Intent copy plus the
// appended Focus-filter catalog) is written by this plugin; without it the
// Shortcuts actions and the Focus filter stay English on a localized device.
check(
  pluginNames.includes(APP_INTENT_LOCALIZATIONS_PLUGIN),
  `plugins must include "${APP_INTENT_LOCALIZATIONS_PLUGIN}"`
);

// Asserted on the EVALUATED config, not on app.config.ts's source: options that
// never reach the plugin still evaluate to the dev-menu defaults (auto-show on,
// onboarding on), and the menu then sits over the product screen carrying the
// raw SF Symbol names a scene dump reads aloud.
const devClientPlugin = (config.plugins ?? []).find(
  plugin => Array.isArray(plugin) && plugin[0] === DEV_CLIENT_PLUGIN
);
for (const [option, expected] of Object.entries(DEV_CLIENT_PLUGIN_OPTIONS)) {
  check(
    devClientPlugin?.[1]?.[option] === expected,
    `plugins "${DEV_CLIENT_PLUGIN}" must set ${option}: ${JSON.stringify(expected)}`
  );
}

const extra = config.extra ?? {};
for (const key of Object.keys(ENV_KEYS)) {
  const value = extra[key];
  if (value === undefined || value === null || value === '') {
    failures.push(`extra.${key} must be present and non-empty`);
  }
}

if (failures.length > 0) {
  console.error('Expo config contract violations:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log('Expo config contract OK');
