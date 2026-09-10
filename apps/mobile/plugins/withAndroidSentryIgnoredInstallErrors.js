const { withMainApplication } = require('expo/config-plugins');

/**
 * Stops the native Sentry SDK reporting an unrecoverable broken-install crash.
 *
 * KILO-APP-53: `com.facebook.soloader.SoLoaderDSONotFoundError: couldn't find
 * DSO to load: libreactnative.so` thrown from `MainApplication.onCreate` before
 * JS starts. The released AAB ships `libreactnative.so` for every ABI, so this
 * only happens when the app is side-loaded from split APKs whose ABI split is
 * missing or does not match the device (base.apk alone, or the arm64 split on
 * an x86_64 device). No code can load a library that is not installed; the
 * crash is an install-integrity failure, not an app defect, so it is dropped
 * instead of paged.
 *
 * The native SDK captures this crash before JS loads, so the JS `beforeSend`
 * never sees it and `options.ignoreErrors` is not read from
 * `sentry.options.json` on the native-init path. The only hook is the
 * `OptionsConfiguration` passed to `RNSentrySDK.init`.
 *
 * The Sentry config plugin inserts `RNSentrySDK.init(this)` after
 * `super.onCreate()`. Config-plugin mods run in reverse registration order, so
 * this plugin is registered BEFORE `@sentry/react-native/expo` and patches the
 * line the Sentry plugin has already written.
 */
// Java `Pattern.matches` is a full-string match and the SoLoader message spans
// several lines, so `[\s\S]` (not `.`) spans newlines. It is also valid in the
// JS `RegExp` the test uses.
const DSO_MESSAGE_PATTERN = "[\\s\\S]*couldn't find DSO to load: libreactnative\\.so[\\s\\S]*";

const KOTLIN_TARGET = 'RNSentrySDK.init(this)';
const JAVA_TARGET = 'RNSentrySDK.init(this);';

function kotlinReplacement() {
  return [
    'RNSentrySDK.init(this) { options ->',
    `      options.addIgnoredError(${JSON.stringify(DSO_MESSAGE_PATTERN)})`,
    '    }',
  ].join('\n');
}

function javaReplacement() {
  return `RNSentrySDK.init(this, options -> options.addIgnoredError(${JSON.stringify(
    DSO_MESSAGE_PATTERN
  )}));`;
}

/**
 * Replaces the Sentry native-init call with one that installs the ignored-error
 * filter. Returns `null` when the target is absent, so the caller decides how
 * loud to be.
 */
function patchMainApplication(contents, language) {
  if (language === 'java') {
    return contents.includes(JAVA_TARGET) ? contents.replace(JAVA_TARGET, javaReplacement()) : null;
  }
  return contents.includes(KOTLIN_TARGET) ? contents.replace(KOTLIN_TARGET, kotlinReplacement()) : null;
}

function withAndroidSentryIgnoredInstallErrors(config) {
  return withMainApplication(config, config => {
    const { language, contents } = config.modResults;
    const patched = patchMainApplication(contents, language);
    if (patched === null) {
      throw new Error(
        `withAndroidSentryIgnoredInstallErrors: could not find '${KOTLIN_TARGET}' in ` +
          'MainApplication. The @sentry/react-native/expo plugin must run first (register this ' +
          'plugin before it) and insert RNSentrySDK.init. Re-check the plugin order in app.config.ts.'
      );
    }
    config.modResults.contents = patched;
    return config;
  });
}

module.exports = withAndroidSentryIgnoredInstallErrors;
module.exports.patchMainApplication = patchMainApplication;
module.exports.DSO_MESSAGE_PATTERN = DSO_MESSAGE_PATTERN;
