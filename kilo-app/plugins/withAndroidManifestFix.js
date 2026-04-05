const { withAndroidManifest } = require('expo/config-plugins');

/**
 * Resolves manifest merger conflict between expo-secure-store and AppsFlyer SDK,
 * which both declare dataExtractionRules and fullBackupContent on <application>.
 */
const withAndroidManifestFix = config => {
  return withAndroidManifest(config, config => {
    const application = config.modResults.manifest.application?.[0];
    if (!application) return config;

    // Ensure tools namespace is declared
    config.modResults.manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';

    // Add tools:replace to resolve the conflicting attributes
    application.$['tools:replace'] = 'android:dataExtractionRules,android:fullBackupContent';

    return config;
  });
};

module.exports = withAndroidManifestFix;
