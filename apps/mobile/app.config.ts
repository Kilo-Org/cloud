import type { ExpoConfig } from 'expo/config';
import { ENV_KEYS, OPTIONAL_ENV_KEYS } from './src/lib/env-keys';
import { SUPPORTED_LANGUAGES } from './src/i18n/languages.ts';
import { buildFocusFilterStringsFiles } from './src/i18n/focus-filter-locales.ts';
import { buildPermissionPromptLocales } from './src/i18n/permission-prompt-locales.ts';
// Prebuild-time native copy, not app copy — see the widget gallery precedent in
// plugins/withWidgetLocalizations.js. Kept in plugins/ so the runtime i18next
// catalogs (src/i18n/locales) stay free of non-runtime strings.
import FOCUS_FILTER_COPY from './plugins/focus-filter-copy.json';
import PERMISSION_PROMPT_COPY from './plugins/permission-prompt-copy.json';
// The widget gallery's own copy. Native bundle metadata, not app copy — see
// plugins/withWidgetLocalizations.js.
import WIDGET_GALLERY_COPY from './plugins/widget-gallery-copy.json';
// The App Intents' own copy, the twin of the widget gallery's. Native bundle
// metadata, not app copy — see plugins/withAppIntentLocalizations.js.
import APP_INTENT_COPY from './plugins/app-intent-copy.json';
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

// Prebuild-time native copy, one `ios` entry per supported language. Expo's
// built-in `withLocales` plugin writes the usage-description keys into
// `<tag>.lproj/InfoPlist.strings`. The `ios` key is the capability, not a
// scope: an `.lproj/InfoPlist.strings` catalog is an Apple bundle format whose
// keys here are iOS `NS*UsageDescription` keys, and Android has no per-locale
// equivalent (the system draws its own permission prompts), so the Android
// prebuild has nothing to write. It is deliberately NOT given the Focus-filter
// `Localizable.strings`: Expo would then register a second copy of the app
// bundle's `<tag>.lproj/Localizable.strings` beside the App Intent catalog
// `withAppIntentLocalizations` already writes, and Xcode fails the build with
// "Multiple commands produce …/Localizable.strings". That catalog travels to the
// single app-target writer instead (`additionalStrings` below).
const permissionLocales = buildPermissionPromptLocales(PERMISSION_PROMPT_COPY);
const focusFilterCatalog = buildFocusFilterStringsFiles(FOCUS_FILTER_COPY);
const nativeLocales: ExpoConfig['locales'] = Object.fromEntries(
  SUPPORTED_LANGUAGES.map(tag => [tag, { ios: permissionLocales[tag].ios }])
);

const config: ExpoConfig = {
  name: 'Kilo',
  owner: 'kilocode',
  slug: 'kilo-app',
  // Keep in lockstep with AGENT_CHANNEL_SPLIT_APP_VERSION in
  // @kilocode/notifications: this is the first build that creates the split
  // agent channels, so older tokens stay on the legacy `agent` channel.
  version: '1.0.12',
  // Rotation is supported on iOS and Android: `default` resolves to portrait +
  // both landscapes in UISupportedInterfaceOrientations on iOS and all
  // orientations in the Android manifest, satisfying WCAG 1.3.4 (Orientation)
  // without claiming an "essential" exception. `ios.requireFullScreen` below
  // STAYS true so iPad split-view/multitasking remains out of scope:
  // full-screen rotation yes, Split View/Slide Over no.
  orientation: 'default',
  icon: './assets/images/logo.png',
  scheme: 'kiloapp',
  userInterfaceStyle: 'automatic',
  // Per-locale native strings. Expo's built-in `withLocales` writes a
  // `<tag>.lproj/InfoPlist.strings` per tag at prebuild from the
  // usage-description keys (the plugin options below stay as the base Info.plist
  // value). `ios`-nested because only iOS has this catalog: Android defines no
  // per-locale native string file for permission prompts, so its `withLocales`
  // resolves each tag to nothing by capability rather than by omission. The
  // location copy spells the app name out: `.lproj` strings are not
  // build-expanded, so the upstream `$(PRODUCT_NAME)` would render literally
  // there. The `Localizable.strings` the same bundle resolves is written by
  // `withAppIntentLocalizations` below, not here.
  locales: nativeLocales,
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
    // `webcredentials` is the passkey half of the claim: it lets the iOS
    // platform authenticator offer the passkey created at app.kilo.ai (the
    // relying-party id) inside the app. It is the one platform-specific line
    // the feature needs, and only because the platform has no equivalent
    // app-config capability: the Associated Domains entitlement is how iOS's
    // AuthenticationServices learns the association, while Android's
    // Credential Manager resolves the same association from the
    // `delegate_permission/common.get_login_creds` relation served at
    // apps/web/public/.well-known/assetlinks.json. Both platforms therefore
    // share the one relying-party id, the one hosted association, and the one
    // credential set; only the declaration's location differs. `applinks` keeps
    // universal links.
    associatedDomains: ['applinks:app.kilo.ai', 'webcredentials:app.kilo.ai'],
    entitlements: {
      // App Attest, used by @expo/app-integrity for native admission. `production`
      // is required for App Store builds; a development build against the
      // production environment still attests, it just uses Apple's dev servers
      // when the app is signed with a development profile.
      'com.apple.developer.devicecheck.appattest-environment': 'production',
      // Needs-input pushes are sent with the `time-sensitive` interruption
      // level so they break through Do Not Disturb and a Focus. iOS grants
      // that level only to an app entitled to it, and the same capability must
      // be enabled on the App ID (`com.kilocode.kiloapp`) in the Apple
      // Developer portal for a provisioning profile to include it.
      'com.apple.developer.usernotifications.time-sensitive': true,
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
    // Keep the platform's classic back delivery. React Native 0.86 only
    // installs its OnBackPressedCallback workaround when the device runs
    // API 36+ (`AndroidVersion.isAtLeastTargetSdk36`), so opting into
    // predictive back (`android:enableOnBackInvokedCallback="true"`) on an
    // API 33-35 device routes Back straight to finish() and the JS
    // `hardwareBackPress` event never fires. API 36 devices enforce
    // predictive back regardless, where React Native does install the
    // callback, so `false` is correct on every API level.
    predictiveBackGestureEnabled: false,
    blockedPermissions: [
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.READ_MEDIA_AUDIO',
    ],
    // Android drops a channel's app-requested `bypassDnd` unless the app has Do
    // Not Disturb policy access: AOSP resets bypassDnd to false when
    // NotificationManagerService reports hasDndAccess false, and the user-facing
    // Do Not Disturb access list (Settings > Special app access) is built from
    // exactly the packages holding this normal-protection marker permission. The
    // user grants that system row; only then does the needs-input channel's
    // `bypassDnd: true` (src/lib/notifications.ts) survive, and the next launch
    // re-asserts it because `ensureAndroidNotificationChannels()` runs at
    // startup (src/app/_layout.tsx). Deliberately no in-app screen or prompt:
    // the system owns this choice.
    permissions: ['android.permission.ACCESS_NOTIFICATION_POLICY'],
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
          // Old release AABs shipped without resource shrinking. Keep this on so
          // the unused kilo_shrink_sentinel_unused raw resource is stripped and
          // the inspector contract can catch a shrink regression before it lands.
          enableShrinkResourcesInReleaseBuilds: true,
          usePrecompiledHeaders: true,
        },
        ios: {
          ccacheEnabled: true,
          // iOS consumes React Native Core prebuilt by default, so the pnpm patch
          // over RCTComponentViewFactory.mm would never compile into the app.
          // The Expo Podfile maps this to ENV['RCT_USE_PREBUILT_RNCORE'] = '0'
          // (KILO-APP-6H; react/react-native#58299).
          // Compile React Native from the patched source instead of linking the
          // prebuilt core. The App Store core ships with assertions enabled
          // (react/react-native#57454), so the Fabric unmount assert must carry
          // the bounds guard from react/react-native#57865 or a stale child
          // index SIGABRTs release builds (Kilo-Org/kilocode#14065; see
          // patches/react-native@0.86.3.patch).
          buildReactNativeFromSource: true,
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
    // The app owns its Android backup rules (plugins/withAndroidManifestFix.js
    // writes the union of the SecureStore and AppsFlyer exclusions). Disable the
    // module's own backup configuration so prebuild does not warn that other
    // rules are already present.
    ['expo-secure-store', { configureAndroidBackup: false }],
    [
      'expo-local-authentication',
      { faceIDPermission: 'Allow Kilo to use Face ID to unlock the app.' },
    ],
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
        // iOS requires `remote-notification` in UIBackgroundModes for the
        // headless background task (`registerTaskAsync`) to deliver a data-only
        // `active_agents_glanceable` push while the app is not in the foreground.
        enableBackgroundRemoteNotifications: true,
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
        image: './assets/images/logo-mark.png',
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
    // Play flavor (the defaults the plugin already applies). The plugin strips
    // and re-adds the `missingDimensionStrategy "platform", ...` line on every
    // prebuild, so its "Added missingDimensionStrategy for play flavor" log line
    // is expected output, not a misconfiguration.
    ['expo-iap', { isHorizonEnabled: false, isFireOsEnabled: false }],
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
    // Window background follows the app theme (values-night aware) so the
    // rotation surface resize never paints a foreign blank frame.
    './plugins/withAndroidRotationSurface',
    './plugins/withAndroidExpoModuleRepos',
    // Writes the app target's single `Localizable.strings` per language: the
    // four App Intent actions and their parameters resolve their
    // `LocalizedStringResource` literals against it, and the Focus-filter copy
    // is appended to the same file (`additionalStrings`), so the bundle has one
    // producer. The app-target twin of the widget registration below.
    [
      './plugins/withAppIntentLocalizations',
      {
        languages: [...SUPPORTED_LANGUAGES],
        copy: APP_INTENT_COPY,
        additionalStrings: focusFilterCatalog,
      },
    ],
    // Declares the app's languages on the widget extension, which expo-widgets
    // leaves English-only. This must be registered BEFORE 'expo-widgets':
    // dangerous mods run in reverse registration order, so the earlier entry
    // runs last and sees the Info.plist expo-widgets has already written.
    [
      './plugins/withWidgetLocalizations',
      { languages: [...SUPPORTED_LANGUAGES], copy: WIDGET_GALLERY_COPY },
    ],
    // Aggregate "Active Agents" glanceable surfaces: one Live Activity plus Home
    // Screen and Lock Screen widgets, rendered by src/glanceable-ios. The widget
    // target reuses the existing app group; no second group is created.
    [
      'expo-widgets',
      {
        groupIdentifier: 'group.com.kilocode.kiloapp',
        bundleIdentifier: 'com.kilocode.kiloapp.ExpoWidgetsTarget',
        enablePushNotifications: true,
        widgets: [
          {
            name: 'ActiveAgentsWidget',
            displayName: WIDGET_GALLERY_COPY.en.displayName,
            description: WIDGET_GALLERY_COPY.en.description,
            contentMarginsDisabled: false,
            // Home Screen: the small square and the medium row. `systemLarge`
            // is deliberately absent — three counts cannot fill a card that
            // tall, and the whitespace read as an unfinished widget. Add it
            // back only with a layout that earns the extra area.
            supportedFamilies: [
              'systemSmall',
              'systemMedium',
              'accessoryCircular',
              'accessoryRectangular',
              'accessoryInline',
            ],
          },
        ],
      },
    ],
    // The iOS notification service extension that drops an agent-progress push
    // the active Focus excluded. The foreground handler in
    // src/lib/notifications.ts cannot see a background delivery, so this
    // extension is the delivery path the per-Focus choice holds on. The server
    // marks exactly the pushes it may drop with `mutable-content`
    // (iosMutableContentForPushData in @kilocode/notifications). Appears in
    // PlugIns as Kilo's extension, and reads the same app group as the widget.
    ['./plugins/withNotificationFocusFilter', { appGroupIdentifier: 'group.com.kilocode.kiloapp' }],
    // Local Expo module for Android Live Updates (no-op until slice `and`).
    './plugins/withActiveAgentsLiveUpdate',
    // Translates the Android widget-picker entry, which the widget library
    // leaves English-only. Registered BEFORE the widget plugin for the same
    // reason as the iOS pair above: mods run in reverse registration order.
    [
      './plugins/withAndroidWidgetLocalizations',
      {
        widgetName: 'ActiveAgentsWidget',
        languages: [...SUPPORTED_LANGUAGES],
        copy: WIDGET_GALLERY_COPY,
      },
    ],
    // No-op until slice `and` writes src/glanceable-android/widget-config.json.
    './plugins/withActiveAgentsAndroidWidget',
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
    // Expo Head reads this as the handoff origin before it registers the
    // session's NSUserActivity, and it throws in development when the value is
    // missing (expo-router/build/head/url.js). Handoff is an iOS capability:
    // expo-router resolves an Android `Head` that renders nothing and reads no
    // origin, so this value is inert there and the session-handoff advertiser
    // needs no platform branch around it. It is the origin of the associated
    // domain in `ios.associatedDomains`, asserted in
    // scripts/assert-expo-config.mjs so the requirement is checked rather than
    // remembered.
    router: { headOrigin: 'https://app.kilo.ai' },
    isProductionBuild,
    eas: {
      projectId: '2cf05e39-90b5-48a5-a8a5-e0b3423cf3f4',
    },
  },
};

export default config;
