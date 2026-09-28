const fs = require('fs');
const path = require('path');

// Registers the local `active-agents-live-update` Expo module.
//
// The module is a `file:` dependency declared in apps/mobile/package.json, so
// pnpm links it into the app's node_modules and Expo autolinking reads its
// expo-module.config.json during prebuild. Its native surface is Android-only
// by capability (the Live Update notification; iOS uses the ActivityKit Live
// Activity through expo-widgets), which is why only the android module list in
// expo-module.config.json names a native module and apple's stays empty. This
// plugin exists as the named hook in app.config.ts so the registration can be
// extended without touching app.config.ts again.
module.exports = function withActiveAgentsLiveUpdate(config) {
  const moduleDir = path.resolve(__dirname, '../modules/active-agents-live-update');
  const moduleConfig = path.join(moduleDir, 'expo-module.config.json');
  if (!fs.existsSync(moduleConfig)) {
    throw new Error(`active-agents-live-update module config not found at ${moduleConfig}`);
  }
  return config;
};
