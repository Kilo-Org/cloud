import type { ExpoConfig } from 'expo/config';
import { ENV_KEYS } from './src/lib/env-keys';

const missing = Object.values(ENV_KEYS).filter(key => !process.env[key]);
if (missing.length > 0) {
  const message = `Missing required environment variables: ${missing.join(', ')}`;
  if (process.env.GITHUB_ACTIONS) {
    console.warn(`⚠️  ${message}`);
  } else {
    throw new Error(message);
  }
}

const config: ExpoConfig = {
  name: 'KiloClaw',
  owner: 'kilocode',
  slug: 'kilo-app',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/images/logo.png',
  scheme: 'kiloapp',
  userInterfaceStyle: 'automatic',
  ios: {
    icon: './assets/images/logo.png',
    bundleIdentifier: 'com.kilocode.kiloapp',
    usesAppleSignIn: true,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      NSAdvertisingAttributionReportEndpoint: 'https://appsflyer-skadnetwork.com/',
      AdAttributionKit: {
        PostbackCopyURL: 'https://appsflyer-skadnetwork.com/',
      },
      NSMicrophoneUsageDescription:
        'Allow $(PRODUCT_NAME) to access your microphone to record audio messages.',
      NSPhotoLibraryUsageDescription:
        'Allow $(PRODUCT_NAME) to access your photos to share images in chat.',
      NSPhotoLibraryAddUsageDescription: 'Allow $(PRODUCT_NAME) to save photos to your library.',
      NSCameraUsageDescription:
        'Allow $(PRODUCT_NAME) to access your camera to take photos for chat.',
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
      },
    ],
    'expo-router',
    'expo-image',
    'expo-secure-store',
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
      'expo-image-picker',
      {
        photosPermission: 'Allow $(PRODUCT_NAME) to access your photos to share images in chat.',
        cameraPermission: 'Allow $(PRODUCT_NAME) to access your camera to take photos for chat.',
      },
    ],
    [
      'expo-document-picker',
      {
        iCloudContainerEnvironment: 'Production',
      },
    ],
    'expo-apple-authentication',
    'expo-audio',
    'expo-sharing',
    'expo-video',
    'expo-asset',
    [
      'expo-tracking-transparency',
      {
        userTrackingPermission:
          'This identifier is used to measure the effectiveness of advertising campaigns.',
      },
    ],
    ['react-native-appsflyer', {}],
    './plugins/withAndroidManifestFix',
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    ...Object.fromEntries(Object.entries(ENV_KEYS).map(([key, env]) => [key, process.env[env]])),
    router: {},
    eas: {
      projectId: '2cf05e39-90b5-48a5-a8a5-e0b3423cf3f4',
    },
  },
};

export default config;
