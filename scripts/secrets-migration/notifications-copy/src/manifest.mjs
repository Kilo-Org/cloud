// The one reviewed batch: Notifications production, all four Secrets Store bindings. Source rows
// equal the production (top-level) `secrets_store_secrets` of services/notifications/wrangler.jsonc;
// targets equal services/sts/policy/notifications.yaml (checks.mjs `checkSource`). A new batch is
// a new reviewed edit of this file, never a runtime parameter.

const freeze = o => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') freeze(v);
  return Object.freeze(o);
};

const STORE_ID = '342a86d9e3a94da698e82d0c6e2a36f0';

export const BATCH = freeze({
  id: 'm65-notifications-production-1',
  accountId: 'e115e769bcdd4c3d66af59d3332cb394',
  sourceScript: 'notifications',
  environment: 'production',
  rows: [
    {
      kind: 'secrets_store',
      binding: 'APNS_PRIVATE_KEY',
      storeId: STORE_ID,
      secretName: 'APNS_PRIVATE_KEY_PROD',
      secretPath: '/workloads/notifications',
      secretKey: 'NOTIFICATIONS_APNS_PRIVATE_KEY',
    },
    {
      kind: 'secrets_store',
      binding: 'EXPO_ACCESS_TOKEN',
      storeId: STORE_ID,
      secretName: 'EXPO_ACCESS_TOKEN',
      secretPath: '/workloads/notifications',
      secretKey: 'NOTIFICATIONS_EXPO_ACCESS_TOKEN',
    },
    {
      kind: 'secrets_store',
      binding: 'NEXTAUTH_SECRET',
      storeId: STORE_ID,
      secretName: 'NEXTAUTH_SECRET_PROD',
      secretPath: '/shared',
      secretKey: 'NEXTAUTH_SECRET',
    },
    {
      kind: 'secrets_store',
      binding: 'INTERNAL_API_SECRET',
      storeId: STORE_ID,
      secretName: 'INTERNAL_API_SECRET_PROD',
      secretPath: '/shared',
      secretKey: 'INTERNAL_API_SECRET',
    },
  ],
});
