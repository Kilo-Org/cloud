const fs = require('fs');
const path = require('path');

const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

const BACKUP_RULES_RES = '@xml/kilo_backup_rules';
const DATA_EXTRACTION_RULES_RES = '@xml/kilo_data_extraction_rules';
const SHRINK_SENTINEL_NAME = 'kilo_shrink_sentinel_unused';

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
 *
 * The two SDKs want mutually incompatible backup rule files, so this plugin
 * writes one union rule set (SecureStore + AppsFlyer exclusions) into the
 * generated Android res directory and points both manifest attributes at it.
 */
function withAndroidManifestFix(config) {
  config = withAndroidBackupResources(config);
  return withAndroidManifest(config, config => {
    const manifest = config.modResults.manifest;
    const application = manifest.application?.[0];
    if (!application) return config;

    // Ensure tools namespace is declared
    manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';

    // Add tools:replace to resolve the conflicting attributes
    application.$['tools:replace'] = 'android:dataExtractionRules,android:fullBackupContent';

    // Point both attributes at the union rules written by withAndroidBackupResources.
    application.$['android:fullBackupContent'] = BACKUP_RULES_RES;
    application.$['android:dataExtractionRules'] = DATA_EXTRACTION_RULES_RES;

    const features = (manifest['uses-feature'] ??= []);
    const declared = new Set(features.map(feature => feature.$?.['android:name']));
    for (const name of OPTIONAL_FEATURES) {
      if (declared.has(name)) continue;
      features.push({ $: { 'android:name': name, 'android:required': 'false' } });
    }

    return config;
  });
}

/**
 * Copies the union backup XML files and an unused raw resource into the
 * generated Android res directory.
 *
 * The raw resource is never referenced by the app. Release builds enable
 * resource shrinking, which strips it from the AAB; the inspector asserts its
 * absence to prove the shrink regression cannot silently land.
 */
function withAndroidBackupResources(config) {
  return withDangerousMod(config, [
    'android',
    async config => {
      const resDir = path.join(config.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res');
      const xmlDir = path.join(resDir, 'xml');
      const rawDir = path.join(resDir, 'raw');
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.mkdirSync(rawDir, { recursive: true });

      fs.copyFileSync(
        path.join(__dirname, 'backup', 'kilo_backup_rules.xml'),
        path.join(xmlDir, 'kilo_backup_rules.xml')
      );
      fs.copyFileSync(
        path.join(__dirname, 'backup', 'kilo_data_extraction_rules.xml'),
        path.join(xmlDir, 'kilo_data_extraction_rules.xml')
      );
      fs.writeFileSync(path.join(rawDir, SHRINK_SENTINEL_NAME), 'resource shrink sentinel');
      return config;
    },
  ]);
}

module.exports = withAndroidManifestFix;
