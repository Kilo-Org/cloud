// The two pure helpers behind `withKiloAppIntents`: which files the app target
// compiles, and the AppDelegate edit that starts the visible-session publisher.
// Nothing here touches an Expo config, so the contract test drives both
// without a prebuild or a pbxproj.

const fs = require('fs');
const path = require('path');

/** The directory the app target compiles, relative to the project root. */
const APP_TARGET_SOURCES = path.join('modules', 'kilo-app-actions', 'ios', 'AppIntents');

const INSTALL_CALL = 'KiloVisibleSessionBridge.install(publisher: KiloVisibleSession.publish)';
const CREATE_REACT_DELEGATE = /^([ \t]*)let delegate = ReactNativeDelegate\(\)/m;

/** The `AppIntentsPackage` an earlier plugin generated into the AppDelegate. */
const LEGACY_PACKAGE =
  /\n@available\(iOS 17\.0, \*\)\nstruct KiloAppIntentsPackage: AppIntentsPackage \{[\s\S]*?\n\}\n?/;

/**
 * Every Swift file the app target compiles, read from the directory itself so
 * a fourth file cannot be added to `ios/AppIntents` and silently compiled into
 * neither the pod (which excludes the directory) nor the app target. Sorted
 * because the copied files and the Sources phase entries are compared by name.
 *
 * @param {string} projectRoot
 * @returns {string[]}
 */
function sourceFiles(projectRoot) {
  const sourceRoot = path.join(projectRoot, APP_TARGET_SOURCES);
  return fs
    .readdirSync(sourceRoot, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.swift'))
    .map(entry => entry.name)
    .sort();
}

/**
 * The AppDelegate contents that start the visible-session publisher before
 * React runs, importing the pod's module internally. The edit is idempotent
 * and drops the package declaration the earlier plugin generated.
 *
 * @param {string} contents
 * @returns {string}
 */
function installPublisher(contents) {
  if (LEGACY_PACKAGE.test(contents)) {
    // The previous plugin owned both this struct and the AppIntents import it
    // needed; remove them together and leave every other import alone.
    contents = contents.replace(LEGACY_PACKAGE, '\n').replace(/^import AppIntents\n/m, '');
  }
  contents = contents.replace(/^import KiloAppActions$/m, 'internal import KiloAppActions');
  if (!contents.includes('internal import KiloAppActions\n')) {
    contents = 'internal import KiloAppActions\n' + contents;
  }
  if (contents.includes(INSTALL_CALL)) return contents;
  if (!CREATE_REACT_DELEGATE.test(contents)) {
    throw new Error('withKiloAppIntents: AppDelegate has no ReactNativeDelegate initialization');
  }
  return contents.replace(
    CREATE_REACT_DELEGATE,
    (match, indent) => `${indent}${INSTALL_CALL}\n${match}`
  );
}

module.exports = {
  APP_TARGET_SOURCES,
  installPublisher,
  sourceFiles,
};
