import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENV_KEYS } from '../src/lib/env-keys.js';

// Contract values mirrored from app.config.ts (bundle id, package, scheme,
// orientation, associated domain, app name, blocked permissions, and Sentry
// plugin). ENV_KEYS is imported live from src/lib/env-keys.js. The script runs
// the full evaluated config, so these must match the resolved build-time
// output, not the raw app.config.ts source.
const BUNDLE_IDENTIFIER = 'com.kilocode.kiloapp';
const ANDROID_PACKAGE = 'com.kilocode.kiloapp';
const SCHEME = 'kiloapp';
const ASSOCIATED_DOMAIN = 'applinks:app.kilo.ai';
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
const SENTRY_PLUGIN = '@sentry/react-native/expo';
const ROTATION_SURFACE_PLUGIN = './plugins/withAndroidRotationSurface';
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
