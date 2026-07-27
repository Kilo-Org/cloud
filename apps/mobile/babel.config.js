module.exports = function (api) {
  api.cache(true);
  return {
    // worklets:false alone is insufficient: babel-preset-expo falls through to
    // react-native-reanimated/plugin (a re-export of worklets/plugin with no
    // options). Disable both so the explicit plugin below is the sole registration.
    presets: [['babel-preset-expo', { worklets: false, reanimated: false }]],
    plugins: [['react-native-worklets/plugin', { bundleMode: true, strictGlobal: true }]],
  };
};
