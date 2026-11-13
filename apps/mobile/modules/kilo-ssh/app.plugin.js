const { AndroidConfig, createRunOncePlugin, withAndroidManifest } = require('expo/config-plugins');

const PLUGIN_NAME = 'kilo-ssh';
const PLUGIN_VERSION = '1.0.0';

const SERVICE_NAME = 'ai.kilo.reactnativessh.background.SshSessionService';
const SPECIAL_USE_PROPERTY = 'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE';
const SPECIAL_USE_SUBTYPE = 'interactive SSH terminal sessions the user opened';
const PERMISSIONS = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
  'android.permission.POST_NOTIFICATIONS',
];

function withSpecialUseService(config) {
  return withAndroidManifest(config, config => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);
    const services = (application.service ??= []);
    const existing = services.find(service => service.$?.['android:name'] === SERVICE_NAME);
    const service = existing ?? { $: { 'android:name': SERVICE_NAME } };

    service.$['android:exported'] = 'false';
    service.$['android:foregroundServiceType'] = 'specialUse';

    const properties = (service.property ??= []);
    if (!properties.some(property => property.$?.['android:name'] === SPECIAL_USE_PROPERTY)) {
      properties.push({
        $: { 'android:name': SPECIAL_USE_PROPERTY, 'android:value': SPECIAL_USE_SUBTYPE },
      });
    }

    if (!existing) {
      services.push(service);
    }

    return config;
  });
}

function withBackgroundSessions(config, { backgroundSessions = true } = {}) {
  if (!backgroundSessions) {
    return config;
  }

  return withSpecialUseService(AndroidConfig.Permissions.withPermissions(config, PERMISSIONS));
}

module.exports = createRunOncePlugin(withBackgroundSessions, PLUGIN_NAME, PLUGIN_VERSION);
