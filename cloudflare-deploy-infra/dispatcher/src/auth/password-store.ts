import type { PasswordRecord } from './password';

/** KV key prefix for password records */
const PASSWORD_KEY_PREFIX = 'password:';

function getPasswordKey(worker: string): string {
  return `${PASSWORD_KEY_PREFIX}${worker}`;
}

export async function getPasswordRecord(
  kv: KVNamespace,
  worker: string
): Promise<PasswordRecord | null> {
  const key = getPasswordKey(worker);
  const record = await kv.get<PasswordRecord>(key, 'json');
  return record;
}

export async function setPasswordRecord(
  kv: KVNamespace,
  worker: string,
  record: PasswordRecord
): Promise<void> {
  const key = getPasswordKey(worker);
  await kv.put(key, JSON.stringify(record));
}

export async function deletePasswordRecord(kv: KVNamespace, worker: string): Promise<void> {
  const key = getPasswordKey(worker);
  await kv.delete(key);
}
