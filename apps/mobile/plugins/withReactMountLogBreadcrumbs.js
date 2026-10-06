const { withAppDelegate } = require('expo/config-plugins');

/**
 * Copies the mount-skip errors from `patches/react-native@0.86.3.patch` into
 * Sentry breadcrumbs on iOS.
 *
 * The patch reports a Fabric mutation for an unregistered component view
 * through `RCTLogError`. A release build sends `RCTLogError` only to the device
 * log, so a later crash report (KILO-APP-3C2) cannot show whether a skip came
 * before it. A breadcrumb is attached to that crash report.
 *
 * The hook lives in `AppDelegate.swift` because the app target is the only
 * target that can import `Sentry`: RNSentry adds the `Sentry.xcframework`
 * search paths to the app target, not to other pods.
 *
 * The `@sentry/react-native/expo` plugin writes `RNSentrySDK.start()`. This
 * plugin must be listed before it in app.config.ts, because Expo runs the
 * AppDelegate mods in reverse order.
 */
const IMPORT_ANCHOR = 'import RNSentry\n';
const START_ANCHOR = '    RNSentrySDK.start()\n';
const MARKER = 'react.mount';

const IMPORT = 'import Sentry\n';
const HOOK = `    RCTAddLogFunction { level, _, _, _, message in
      guard level.rawValue >= RCTLogLevel.error.rawValue,
            let message,
            message.hasPrefix("RCTPerformMountInstructions:") || message.hasPrefix("RCTComponentViewRegistry:") else {
        return
      }
      let breadcrumb = Breadcrumb(level: .error, category: "${MARKER}")
      breadcrumb.message = message
      SentrySDK.addBreadcrumb(breadcrumb)
    }
`;

function addMountLogBreadcrumbs(contents) {
  if (contents.includes(`category: "${MARKER}"`)) {
    return contents;
  }
  if (!contents.includes(IMPORT_ANCHOR) || !contents.includes(START_ANCHOR)) {
    throw new Error(
      'withReactMountLogBreadcrumbs: AppDelegate.swift has no RNSentry import or RNSentrySDK.start() call.'
    );
  }
  return contents
    .replace(IMPORT_ANCHOR, IMPORT_ANCHOR + IMPORT)
    .replace(START_ANCHOR, START_ANCHOR + HOOK);
}

function withReactMountLogBreadcrumbs(config) {
  return withAppDelegate(config, mod => {
    if (mod.modResults.language !== 'swift') {
      throw new Error('withReactMountLogBreadcrumbs: AppDelegate must be Swift.');
    }
    mod.modResults.contents = addMountLogBreadcrumbs(mod.modResults.contents);
    return mod;
  });
}

module.exports = withReactMountLogBreadcrumbs;
