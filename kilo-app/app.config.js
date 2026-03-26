/** @type {import('expo/config').ExpoConfig} */
const config = {
  name: 'Kilo',
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
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    apiBaseUrl: process.env.API_BASE_URL,
    webBaseUrl: process.env.WEB_BASE_URL,
    router: {},
    eas: {
      projectId: '2cf05e39-90b5-48a5-a8a5-e0b3423cf3f4',
    },
  },
};

module.exports = config;
