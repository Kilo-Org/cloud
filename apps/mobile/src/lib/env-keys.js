/** Config key → environment variable name. Single source of truth for both
 *  build-time validation (app.config.ts) and runtime access (config.ts). */
export const ENV_KEYS = {
  apiBaseUrl: 'API_BASE_URL',
  webBaseUrl: 'WEB_BASE_URL',
  appsFlyerDevKey: 'APPSFLYER_DEV_KEY',
  appsFlyerAppId: 'APPSFLYER_APP_ID',
};
