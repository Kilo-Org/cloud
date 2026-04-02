/** @type {import('expo/config').ExpoConfig} */
const config = {
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
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
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
    package: 'com.kilocode.kiloapp',
    adaptiveIcon: {
      backgroundColor: '#FAF74F',
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-foreground.png',
    },
    predictiveBackGestureEnabled: false,
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
      'expo-media-library',
      {
        photosPermission: 'Allow $(PRODUCT_NAME) to access your photos to save and share media.',
        savePhotosPermission: 'Allow $(PRODUCT_NAME) to save photos to your library.',
      },
    ],
    [
      'expo-document-picker',
      {
        iCloudContainerEnvironment: 'Production',
      },
    ],
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
    apiBaseUrl: process.env.API_BASE_URL,
    webBaseUrl: process.env.WEB_BASE_URL,
    appsFlyerDevKey: process.env.APPSFLYER_DEV_KEY,
    appsFlyerAppId: process.env.APPSFLYER_APP_ID,
    router: {},
    eas: {
      projectId: '2cf05e39-90b5-48a5-a8a5-e0b3423cf3f4',
    },
  },
};

module.exports = config;
