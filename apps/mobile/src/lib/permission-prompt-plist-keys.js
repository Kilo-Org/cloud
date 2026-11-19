// @ts-check
/** The Info.plist usage descriptions Expo's `withLocales` writes into one
 *  `<tag>.lproj/InfoPlist.strings` per language. The builder
 *  (src/i18n/permission-prompt-locales.ts) fills its `ios` map from this list,
 *  and the assertion script (scripts/assert-expo-config.mjs) checks the
 *  evaluated `locales` map against the same list, so a key added or renamed
 *  here moves the writer and the check together. app.config.ts reads the
 *  matching English prompt of each of these keys from
 *  plugins/permission-prompt-copy.json, which is the copy source for every
 *  language. Plain .js because that script runs under plain Node, which cannot
 *  load workspace TS (same reason env-keys.js exists). Checked by the mobile
 *  typecheck through tsconfig include — keep the entry. */
export const PERMISSION_PROMPT_PLIST_KEYS = Object.freeze(
  /** @type {const} */
  ([
    'NSCameraUsageDescription',
    'NSPhotoLibraryUsageDescription',
    'NSLocalNetworkUsageDescription',
    'NSMicrophoneUsageDescription',
    'NSSpeechRecognitionUsageDescription',
    'NSFaceIDUsageDescription',
    'NSUserTrackingUsageDescription',
  ])
);
