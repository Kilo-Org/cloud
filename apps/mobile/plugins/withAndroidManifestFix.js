const { withAndroidManifest } = require('expo/config-plugins');

/**
 * Features Google Play treats as required because a permission implies them.
 * The app declares CAMERA, RECORD_AUDIO, ACCESS_FINE/COARSE_LOCATION and
 * ACCESS_WIFI_STATE, so Play hides the listing ("This app won't work for your
 * device") on every device that lacks one. All five are optional to this app,
 * so declare them with required="false".
 * https://developer.android.com/guide/topics/manifest/uses-feature-element
 */
const OPTIONAL_FEATURES = [
  'android.hardware.camera',
  'android.hardware.camera.autofocus',
  'android.hardware.microphone',
  'android.hardware.location',
  'android.hardware.wifi',
];

/**
 * Resolves manifest merger conflict between expo-secure-store and AppsFlyer SDK,
 * which both declare dataExtractionRules and fullBackupContent on <application>,
 * and stops Google Play from filtering devices on implied hardware features.
 */
const withAndroidManifestFix = config => {
  return withAndroidManifest(config, config => {
    const manifest = config.modResults.manifest;
    const application = manifest.application?.[0];
    if (!application) return config;

    // Ensure tools namespace is declared
    manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';

    // Add tools:replace to resolve the conflicting attributes
    application.$['tools:replace'] = 'android:dataExtractionRules,android:fullBackupContent';

    const features = (manifest['uses-feature'] ??= []);
    const declared = new Set(features.map(feature => feature.$?.['android:name']));
    for (const name of OPTIONAL_FEATURES) {
      if (declared.has(name)) continue;
      features.push({ $: { 'android:name': name, 'android:required': 'false' } });
    }

    return config;
  });
};

module.exports = withAndroidManifestFix;
