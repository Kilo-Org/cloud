// Learn more https://docs.expo.dev/guides/customizing-babel/
//
// `inline-import` inlines the generated `drizzle/*.sql` migrations into the
// bundle as strings, which is how drizzle-orm/expo-sqlite/migrator reads them,
// and the app's `CHANGELOG.md` the same way, so the changelog screen renders
// the file the Release workflow wrote instead of a copy of it.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [['inline-import', { extensions: ['.sql', '.md'] }]],
  };
};
