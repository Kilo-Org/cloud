import { LOCAL_AGENT_ENDPOINTS_STORAGE_KEY } from './local-agents/endpoints';
import { LOCAL_AGENT_SETTINGS_STORAGE_KEY } from './local-agents/settings';

type MaybePromise<Value> = Promise<Value> | Value;
type LocalStorageKey = `local:${string}`;

export interface AccountStorageArea {
  snapshot(base: 'local'): MaybePromise<Record<string, unknown>>;
  removeItems(keys: LocalStorageKey[]): MaybePromise<void>;
}

/*
 * The local-agents switch and its paired endpoints belong to this browser, not
 * to a Kilo account (SPEC D15): sign-out and session expiry keep them, so a
 * running local agent keeps running. Every other `local:` key is account data
 * and is removed, including keys added later that are not listed here.
 */
const DEVICE_OWNED_LOCAL_STORAGE_KEYS: ReadonlySet<string> = new Set([
  LOCAL_AGENT_ENDPOINTS_STORAGE_KEY,
  LOCAL_AGENT_SETTINGS_STORAGE_KEY,
]);

export const clearAccountStorage = async (storageArea: AccountStorageArea): Promise<void> => {
  const accountKeys = Object.keys(await storageArea.snapshot('local'))
    .map((key): LocalStorageKey => `local:${key}`)
    .filter(key => !DEVICE_OWNED_LOCAL_STORAGE_KEYS.has(key));

  await storageArea.removeItems(accountKeys);
};
