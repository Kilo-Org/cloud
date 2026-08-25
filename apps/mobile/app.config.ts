import type { ExpoConfig } from 'expo/config';
import { ENV_KEYS, OPTIONAL_ENV_KEYS } from './src/lib/env-keys';
import { SUPPORTED_LANGUAGES } from './src/i18n/languages.ts';
import { SENTRY_NATIVE_OPTIONS } from './src/lib/sentry-dsn';
import { UNIVERSAL_LINK_PATH_PATTERNS } from './src/lib/universal-link-paths';
import {
  assertProductionHost,
  assertUrlScheme,
  PRODUCTION_HOSTS,
  URL_SCHEMES,
} from './src/lib/url-contract';

const isProductionBuild = process.env.EAS_BUILD_PROFILE === 'production';

// Required env is fatal by build intent: a production build must never ship
// with a missing value, so throw under EAS_BUILD_PROFILE === 'production'.
// Otherwise keep the old behavior: warn under GITHUB_ACTIONS, throw locally.
const missing = Object.values(ENV_KEYS).filter(key => !process.env[key]);
if (missing.length > 0) {
  const message = `Missing required environment variables: ${missing.join(', ')}`;
  if (isProductionBuild) {
    throw new Error(message);
  } else if (process.env.GITHUB_ACTIONS) {
    console.warn(`⚠️  ${message}`);
  } else {
    throw new Error(message);
  }
}

// URL contract: every URL value must use its allowed scheme. Non-production
// builds additionally permit http:/ws: for local development; production
// builds also assert the host against the production allowlist.
for (const [key, schemes] of Object.entries(URL_SCHEMES)) {
  const value = process.env[ENV_KEYS[key as keyof typeof ENV_KEYS]];
  if (!value) continue;
  assertUrlScheme(key, value, schemes, { allowInsecure: !isProductionBuild });
  if (isProductionBuild) {
    assertProductionHost(key, value, PRODUCTION_HOSTS);
  }
}

// Source-map gate: an unauthenticated production artifact must never reach the
// stores with silently missing symbolication.
if (isProductionBuild && !process.env.SENTRY_AUTH_TOKEN) {
  throw new Error(
    'Missing SENTRY_AUTH_TOKEN: production builds require an authenticated Sentry source-map upload.'
  );
}

// Google OAuth client IDs are public identifiers (committed .env, all EAS
// environments). The conditional below tolerates their absence so the app still builds when a
// checkout lacks them; the native Google button hides itself when undefined.
const googleIosClientId = process.env[OPTIONAL_ENV_KEYS.googleIosClientId];
const googleIosUrlScheme = googleIosClientId
  ? `com.googleusercontent.apps.${googleIosClientId.replace(/\.apps\.googleusercontent\.com$/, '')}`
  : undefined;
const googleSignInPlugins: NonNullable<ExpoConfig['plugins']> = googleIosUrlScheme
  ? [['@react-native-google-signin/google-signin', { iosUrlScheme: googleIosUrlScheme }]]
  : [];

const config: ExpoConfig = {
  name: 'Kilo',
  owner: 'kilocode',
  slug: 'kilo-app',
  version: '1.0.5',
  // Portrait-only is an accepted, documented product deviation from WCAG 1.3.4
  // (Orientation). Landscape layouts and iPad split-view/multitasking are out
  // of scope; `ios.requireFullScreen` below enforces that. This is not claimed
  // as a WCAG "essential" exception, which requires functionality to
  // fundamentally change with orientation.
  orientation: 'portrait',
  icon: './assets/images/logo.png',
  scheme: 'kiloapp',
  userInterfaceStyle: 'automatic',
  ios: {
    // iOS 18+ appearance variants. `light` is the existing icon unchanged; `dark` keeps the
    // canonical mobile brand yellow on a dark backdrop; `tinted` is grayscale because iOS
    // applies its own tint. All three are opaque 1024x1024 — Expo requires the icon to fill
    // the square with no transparent pixels.
    icon: {
      light: './assets/images/logo.png',
      dark: './assets/images/logo-dark.png',
      tinted: './assets/images/logo-tinted.png',
    },
    bundleIdentifier: 'com.kilocode.kiloapp',
    requireFullScreen: true,
    supportsTablet: true,
    usesAppleSignIn: true,
    associatedDomains: ['applinks:app.kilo.ai'],
    entitlements: {
      // App Attest, used by @expo/app-integrity for native admission. `production`
      // is required for App Store builds; a development build against the
      // production environment still attests, it just uses Apple's dev servers
      // when the app is signed with a development profile.
      'com.apple.developer.devicecheck.appattest-environment': 'production',
    },
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      // iOS reads this list, not the JS catalog. Without it the system treats
      // the app as English-only, so OS-drawn text we cannot translate — the
      // native Sign in with Apple button above all — stays English on a
      // localized device.
      CFBundleLocalizations: [...SUPPORTED_LANGUAGES],
      NSAdvertisingAttributionReportEndpoint: 'https://appsflyer-skadnetwork.com/',
      // Apple's raw key for AdAttributionKit postback copies is the top-level
      // string `AttributionCopyEndpoint` (Xcode displays it as "AdAttributionKit -
      // Postback Copy URL"). A nested AdAttributionKit dictionary is silently
      // ignored by iOS, so copies never reached AppsFlyer.
      AttributionCopyEndpoint: 'https://appsflyer-skadnetwork.com/',
      // Make the app's Documents directory user-visible in the iOS Files
      // app so downloaded any-file attachments (uploaded via the cloud-agent
      // composer) can be opened in place.
      UIFileSharingEnabled: true,
      LSSupportsOpeningDocumentsInPlace: true,
    },
  },
  android: {
    googleServicesFile: './google-services.json',
    package: 'com.kilocode.kiloapp',
    adaptiveIcon: {
      backgroundColor: '#FAF74F',
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-foreground.png',
    },
    predictiveBackGestureEnabled: true,
    blockedPermissions: [
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.READ_MEDIA_AUDIO',
    ],
    intentFilters: [
      {
        action: 'VIEW',
        autoVerify: true,
        data: UNIVERSAL_LINK_PATH_PATTERNS.map(pathPattern => ({
          scheme: 'https',
          host: 'app.kilo.ai',
          pathPattern,
        })),
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ],
  },
  plugins: [
    ['expo-dev-client', { toolsButton: false }],
    [
      'expo-build-properties',
      {
        android: {
          enableMinifyInReleaseBuilds: true,
          usePrecompiledHeaders: true,
        },
        ios: {
          ccacheEnabled: true,
          // GoogleSignIn is a Swift static lib that imports GoogleUtilities/RecaptchaInterop
          // (pulled transitively alongside expo-iap's AppCheckCore); those pods don't define
          // modules, so pod install fails unless we force module maps on them. Unconditional
          // because the google-signin pod autolinks whether or not the OAuth client is set.
          extraPods: [
            { name: 'GoogleUtilities', modular_headers: true },
            { name: 'RecaptchaInterop', modular_headers: true },
          ],
        },
      },
    ],
    [
      'expo-speech-recognition',
      {
        microphonePermission: 'Allow Kilo to use your microphone to turn speech into text.',
        speechRecognitionPermission:
          'Allow Kilo to use speech recognition to turn your voice into text.',
      },
    ],
    'expo-router',
    'expo-image',
    'expo-font',
    'expo-secure-store',
    'expo-sharing',
    // Encrypts the local persistence database (kilo-persist.db) with SQLCipher.
    // The key is generated from expo-crypto and held in SecureStore; see
    // src/lib/persist/encrypted-kv.ts.
    ['expo-sqlite', { useSQLCipher: true }],
    [
      'expo-notifications',
      {
        icon: './assets/images/android-notification-icon.png',
        color: '#FAF74F',
      },
    ],
    'expo-web-browser',
    [
      '@sentry/react-native/expo',
      {
        url: 'https://sentry.io/',
        project: 'kilo-app',
        organization: 'kilo-code',
        useNativeInit: true,
        options: SENTRY_NATIVE_OPTIONS,
      },
    ],
    [
      'expo-splash-screen',
      {
        image: './assets/images/logo.png',
        backgroundColor: '#FAF74F',
        imageWidth: 100,
      },
    ],
    [
      'expo-location',
      {
        locationWhenInUsePermission:
          'Allow $(PRODUCT_NAME) to use your location to set up local weather.',
        isIosBackgroundLocationEnabled: false,
        isAndroidBackgroundLocationEnabled: false,
        isAndroidForegroundServiceEnabled: false,
      },
    ],
    'expo-apple-authentication',
    'expo-iap',
    [
      'expo-tracking-transparency',
      {
        userTrackingPermission:
          'This identifier is used to measure the effectiveness of advertising campaigns.',
      },
    ],
    ['react-native-appsflyer', { shouldUsePurchaseConnector: true }],
    // Local wrapper: pnpm isolation + Kilo target-name collision (see plugin).
    [
      './plugins/withExpoShareIntent',
      {
        iosActivationRules: {
          NSExtensionActivationSupportsText: true,
          NSExtensionActivationSupportsWebURLWithMaxCount: 1,
          NSExtensionActivationSupportsWebPageWithMaxCount: 1,
          NSExtensionActivationSupportsImageWithMaxCount: 5,
          NSExtensionActivationSupportsFileWithMaxCount: 5,
        },
        androidIntentFilters: ['text/*', '*/*'],
        androidMultiIntentFilters: ['*/*'],
        iosAppGroupIdentifier: 'group.com.kilocode.kiloapp',
        // Display name "Kilo" is applied by the wrapper; target is ShareExtension
        // because iosShareExtensionName "Kilo" collides with the main app target.
        iosShareExtensionName: 'Kilo',
      },
    ],
    './plugins/withAndroidManifestFix',
    // Registered only when GOOGLE_IOS_CLIENT_ID is set — a guard for checkouts
    // whose environment does not provide it.
    ...googleSignInPlugins,
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    ...Object.fromEntries(Object.entries(ENV_KEYS).map(([key, env]) => [key, process.env[env]])),
    ...Object.fromEntries(
      Object.entries(OPTIONAL_ENV_KEYS).map(([key, env]) => [key, process.env[env]])
    ),
    router: {},
    isProductionBuild,
    eas: {
      projectId: '2cf05e39-90b5-48a5-a8a5-e0b3423cf3f4',
    },
  },
};

export default config;
