/** KV key prefix for banner records */
const BANNER_KEY_PREFIX = 'app-builder-banner:';

export type BannerRecord = {
  enabled: boolean;
};

function getBannerKey(worker: string): string {
  return `${BANNER_KEY_PREFIX}${worker}`;
}

export async function getBannerRecord(
  kv: KVNamespace,
  worker: string
): Promise<BannerRecord | null> {
  const key = getBannerKey(worker);
  const record = await kv.get<BannerRecord>(key, { type: 'json', cacheTtl: 60 });
  return record;
}

export async function setBannerRecord(
  kv: KVNamespace,
  worker: string,
  record: BannerRecord
): Promise<void> {
  const key = getBannerKey(worker);
  await kv.put(key, JSON.stringify(record));
}

export async function deleteBannerRecord(kv: KVNamespace, worker: string): Promise<void> {
  const key = getBannerKey(worker);
  await kv.delete(key);
}
