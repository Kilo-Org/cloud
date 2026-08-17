// Learn more https://docs.expo.dev/guides/customizing-babel/
//
// `inline-import` inlines the generated `drizzle/*.sql` migrations into the
// bundle as strings, which is how drizzle-orm/expo-sqlite/migrator reads them.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [['inline-import', { extensions: ['.sql'] }]],
  };
};
