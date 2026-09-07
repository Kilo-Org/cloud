const fs = require('fs');
const path = require('path');

// Registers the local `active-agents-live-update` Expo module.
//
// The module is a `file:` dependency declared in apps/mobile/package.json, so
// pnpm links it into the app's node_modules and Expo autolinking reads its
// expo-module.config.json during prebuild. At this level it is JS-only (the
// native module lists are empty); slice `and` adds the Android native module.
// This plugin exists as the named hook in app.config.ts so a later level can
// extend registration without touching app.config.ts again.
module.exports = function withActiveAgentsLiveUpdate(config) {
  const moduleDir = path.resolve(__dirname, '../modules/active-agents-live-update');
  const moduleConfig = path.join(moduleDir, 'expo-module.config.json');
  if (!fs.existsSync(moduleConfig)) {
    throw new Error(`active-agents-live-update module config not found at ${moduleConfig}`);
  }
  return config;
};
