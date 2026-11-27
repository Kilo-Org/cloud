// The one reviewed batch: the Notifications production Expo token only (M108). The other three
// Notifications values are copied from 1Password by secrets-cutover under their STS lookup names,
// so this Create-only copier must never target them. The row equals its production (top-level)
// `secrets_store_secrets` entry in services/notifications/wrangler.jsonc and its row of checks.mjs
// `NAME_MAP` (`checkSource`). A new batch is a new reviewed edit of this file and of core.mjs
// `REVIEWED_TARGETS`, never a runtime parameter.

const freeze = o => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') freeze(v);
  return Object.freeze(o);
};

export const BATCH = freeze({
  id: 'm65-notifications-expo-production-1',
  accountId: 'e115e769bcdd4c3d66af59d3332cb394',
  sourceScript: 'notifications',
  environment: 'production',
  rows: [
    {
      kind: 'secrets_store',
      binding: 'EXPO_ACCESS_TOKEN',
      storeId: '342a86d9e3a94da698e82d0c6e2a36f0',
      secretName: 'EXPO_ACCESS_TOKEN',
      secretPath: '/workloads/notifications',
      secretKey: 'NOTIFICATIONS_EXPO_ACCESS_TOKEN',
    },
  ],
});
