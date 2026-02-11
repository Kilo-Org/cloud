/** KV key prefix for banner records */
const BANNER_KEY_PREFIX = 'app-builder-banner:';

function getBannerKey(worker: string): string {
  return `${BANNER_KEY_PREFIX}${worker}`;
}

export async function isBannerEnabled(kv: KVNamespace, worker: string): Promise<boolean> {
  const value = await kv.get(getBannerKey(worker), { cacheTtl: 60 });
  return value !== null;
}

export async function enableBanner(kv: KVNamespace, worker: string): Promise<void> {
  await kv.put(getBannerKey(worker), '1');
}

export async function disableBanner(kv: KVNamespace, worker: string): Promise<void> {
  await kv.delete(getBannerKey(worker));
}
