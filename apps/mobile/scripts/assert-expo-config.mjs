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
// One entry configures Expo's native splash on both platforms. Its internal
// Android backing-surface adapter is a documented native capability exception,
// not a separate launch lifecycle. The wrapper owns the mod ordering.
const BRANDED_SPLASH_PLUGIN = './plugins/withBrandedSplash';
// The one writer of the app target's `<tag>.lproj/Localizable.strings`: the App
// Intent copy plus the appended Focus-filter catalog.
const APP_INTENT_LOCALIZATIONS_PLUGIN = './plugins/withAppIntentLocalizations';
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
// The app target's one `Localizable.strings` (the App Intent copy plus the
// appended Focus-filter catalog) is written by this plugin; without it the
// Shortcuts actions and the Focus filter stay English on a localized device.
check(
  pluginNames.includes(APP_INTENT_LOCALIZATIONS_PLUGIN),
  `plugins must include "${APP_INTENT_LOCALIZATIONS_PLUGIN}"`
);

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
