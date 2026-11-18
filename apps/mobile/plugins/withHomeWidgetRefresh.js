const fs = require('fs');
const path = require('path');
const plist = require('@expo/plist').default;
const {
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} = require('expo/config-plugins');

const TARGET = 'ExpoWidgetsTarget';
const GROUP = 'group.com.kilocode.kiloapp';
const KEYCHAIN = '$(AppIdentifierPrefix)com.kilocode.kiloapp.home-widget-refresh';
const FILES = ['HomeWidgetRefreshStore.swift', 'HomeWidgetTimelineProvider.swift'];

function integrateProvider(source) {
  if (source.includes('HomeWidgetTimelineProvider(name: name)')) return source;
  const provider = 'WidgetsTimelineProvider(name: name)';
  const body = 'var body: some WidgetConfiguration {';
  if (
    !source.includes(provider) ||
    !source.includes(body) ||
    !source.includes('WidgetsEntryView(entry: entry)')
  ) {
    throw new Error('Home widget generator changed: cannot attach authenticated provider');
  }
  source = source
    .replace(provider, 'HomeWidgetTimelineProvider(name: name)')
    .replace(body, 'var configuration: some WidgetConfiguration {')
    .replace(
      'WidgetsEntryView(entry: entry)',
      'WidgetsEntryView(entry: entry).environment(\\.layoutDirection, HomeWidgetRefreshStore.layoutDirection)'
    );
  const end = source.lastIndexOf('}');
  return (
    source.slice(0, end) +
    `
  // Statement returns, not an if-expression: SE-0360 allows a different opaque type under #available.
  var body: some WidgetConfiguration {
    if #available(iOS 26.0, *) {
      return configuration.pushHandler(HomeWidgetPushHandler.self)
    }
    return configuration
  }
` +
    source.slice(end)
  );
}

// Register BEFORE expo-widgets: dangerous/Xcode mods run in reverse order.
module.exports = function withHomeWidgetRefresh(config) {
  const extensions = config.extra?.eas?.build?.experimental?.ios?.appExtensions ?? [];
  const previous = extensions.find(entry => entry.targetName === TARGET);
  config.extra ??= {};
  config.extra.eas ??= {};
  config.extra.eas.build ??= {};
  config.extra.eas.build.experimental ??= {};
  config.extra.eas.build.experimental.ios ??= {};
  config.extra.eas.build.experimental.ios.appExtensions = [
    ...extensions.filter(entry => entry.targetName !== TARGET),
    {
      ...previous,
      targetName: TARGET,
      bundleIdentifier: `${config.ios.bundleIdentifier}.${TARGET}`,
      entitlements: {
        ...previous?.entitlements,
        'com.apple.security.application-groups': [GROUP],
        'keychain-access-groups': [KEYCHAIN],
        'aps-environment': 'production',
      },
    },
  ];
  config = withEntitlementsPlist(config, cfg => {
    const groups = cfg.modResults['keychain-access-groups'] ?? [];
    // SecureStore's default must remain first; the extension may access only the widget group.
    const defaultGroup = `$(AppIdentifierPrefix)${cfg.ios.bundleIdentifier}`;
    cfg.modResults['keychain-access-groups'] = [...new Set([defaultGroup, ...groups, KEYCHAIN])];
    return cfg;
  });
  config = withInfoPlist(config, cfg => {
    cfg.modResults.HomeWidgetKeychainAccessGroup = KEYCHAIN;
    return cfg;
  });
  config = withDangerousMod(config, [
    'ios',
    cfg => {
      const root = path.join(cfg.modRequest.platformProjectRoot, TARGET);
      const module = path.join(cfg.modRequest.projectRoot, 'modules/home-widget-refresh/ios');
      if (!fs.existsSync(path.join(root, 'ActiveAgentsWidget.swift')))
        throw new Error('expo-widgets must generate its target before Home refresh');
      fs.copyFileSync(path.join(module, FILES[0]), path.join(root, FILES[0]));
      fs.copyFileSync(path.join(module, 'WidgetExtension', FILES[1]), path.join(root, FILES[1]));
      const widgetPath = path.join(root, 'ActiveAgentsWidget.swift');
      fs.writeFileSync(widgetPath, integrateProvider(fs.readFileSync(widgetPath, 'utf8')));
      const infoPath = path.join(root, 'Info.plist');
      const info = plist.parse(fs.readFileSync(infoPath, 'utf8'));
      info.HomeWidgetKeychainAccessGroup = KEYCHAIN;
      fs.writeFileSync(infoPath, plist.build(info));
      const entitlementPath = path.join(root, `${TARGET}.entitlements`);
      const entitlements = plist.parse(fs.readFileSync(entitlementPath, 'utf8'));
      entitlements['keychain-access-groups'] = [KEYCHAIN];
      entitlements['aps-environment'] = 'production';
      fs.writeFileSync(entitlementPath, plist.build(entitlements));
      return cfg;
    },
  ]);
  return withXcodeProject(config, cfg => {
    const project = cfg.modResults;
    const targets = project.pbxNativeTargetSection();
    const uuid = Object.keys(targets).find(
      key => !key.endsWith('_comment') && targets[key].name === TARGET
    );
    if (!uuid) throw new Error('Home widget target must exist before attaching refresh sources');
    // Xcode rejects a second Sources phase as duplicate tasks; join the target's existing phase.
    const groups = project.hash.project.objects.PBXGroup;
    const groupKey = Object.keys(groups).find(
      key =>
        !key.endsWith('_comment') &&
        groups[key].name === TARGET &&
        String(groups[key].path).replaceAll('"', '') === TARGET
    );
    if (!groupKey) throw new Error('Home widget group must exist before attaching refresh sources');
    for (const file of FILES) {
      if (!project.hasFile(file)) {
        project.addSourceFile(file, { target: uuid }, groupKey);
      }
    }
    return cfg;
  });
};
module.exports.integrateProvider = integrateProvider;
