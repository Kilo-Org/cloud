import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Contract values mirrored from app.config.ts and src/lib/env-keys.js. The
// script runs the full evaluated config, so these must match the resolved
// build-time output, not the raw app.config.ts source.
const BUNDLE_IDENTIFIER = 'com.kilocode.kiloapp';
const ANDROID_PACKAGE = 'com.kilocode.kiloapp';
const SCHEME = 'kiloapp';
const ASSOCIATED_DOMAIN = 'applinks:app.kilo.ai';
const BLOCKED_PERMISSIONS = [
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_AUDIO',
];
const SENTRY_PLUGIN = '@sentry/react-native/expo';
const ENV_KEYS = [
  'apiBaseUrl',
  'webBaseUrl',
  'cloudAgentWsUrl',
  'sessionIngestWsUrl',
  'appsFlyerDevKey',
  'appsFlyerAppId',
  'kiloChatUrl',
  'eventServiceUrl',
  'notificationsUrl',
  'posthogApiKey',
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

const associatedDomains = config.ios?.associatedDomains ?? [];
check(
  associatedDomains.includes(ASSOCIATED_DOMAIN),
  `ios.associatedDomains must contain "${ASSOCIATED_DOMAIN}"`
);

const blockedPermissions = config.android?.blockedPermissions ?? [];
const blockedPermissionsMatch =
  blockedPermissions.length === BLOCKED_PERMISSIONS.length &&
  BLOCKED_PERMISSIONS.every(permission => blockedPermissions.includes(permission));
check(
  blockedPermissionsMatch,
  `android.blockedPermissions must equal exactly [${BLOCKED_PERMISSIONS.join(', ')}]`
);

const pluginNames = (config.plugins ?? []).map(plugin =>
  Array.isArray(plugin) ? plugin[0] : plugin
);
check(pluginNames.includes(SENTRY_PLUGIN), `plugins must include "${SENTRY_PLUGIN}"`);

const extra = config.extra ?? {};
for (const key of ENV_KEYS) {
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
