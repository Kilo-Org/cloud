import type { ExpoConfig } from 'expo/config';
import { ENV_KEYS, OPTIONAL_ENV_KEYS } from './src/lib/env-keys';

const missing = Object.values(ENV_KEYS).filter(key => !process.env[key]);
if (missing.length > 0) {
  const message = `Missing required environment variables: ${missing.join(', ')}`;
  if (process.env.GITHUB_ACTIONS) {
    console.warn(`⚠️  ${message}`);
  } else {
    throw new Error(message);
  }
}

// ponytail: Google OAuth client IDs aren't created yet — plugin/config below tolerate absence
// so the app still builds; the native Google button (Task 6) hides itself when undefined.
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
  version: '1.0.2',
  orientation: 'portrait',
  icon: './assets/images/logo.png',
  scheme: 'kiloapp',
  userInterfaceStyle: 'automatic',
  ios: {
    icon: './assets/images/logo.png',
    bundleIdentifier: 'com.kilocode.kiloapp',
    requireFullScreen: true,
    supportsTablet: true,
    usesAppleSignIn: true,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      NSAdvertisingAttributionReportEndpoint: 'https://appsflyer-skadnetwork.com/',
      AdAttributionKit: {
        PostbackCopyURL: 'https://appsflyer-skadnetwork.com/',
      },
    },
  },
  splash: {
    image: './assets/images/logo.png',
    resizeMode: 'contain',
    backgroundColor: '#FAF74F',
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
    predictiveBackGestureEnabled: false,
    blockedPermissions: [
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.READ_MEDIA_AUDIO',
    ],
  },
  plugins: [
    [
      'expo-build-properties',
      {
        android: {
          enableProguardInReleaseBuilds: true,
        },
        ios: {
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
    'expo-router',
    'expo-image',
    'expo-font',
    'expo-secure-store',
    'expo-sharing',
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
    ['react-native-appsflyer', {}],
    './plugins/withAndroidManifestFix',
    // ponytail: only registered when GOOGLE_IOS_CLIENT_ID is set, so prebuild works before the
    // Google OAuth clients exist.
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
    eas: {
      projectId: '2cf05e39-90b5-48a5-a8a5-e0b3423cf3f4',
    },
  },
};

export default config;
