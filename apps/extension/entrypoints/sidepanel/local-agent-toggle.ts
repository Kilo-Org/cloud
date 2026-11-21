/* eslint-disable typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface */
import { saveLocalAgentSettings } from '@/src/shared/local-agents/settings';
import type { LocalAgentStorageArea } from '@/src/shared/local-agents/storage';

/*
 * Enabling asks for the optional nativeMessaging permission before the switch
 * is persisted, so the first native connect that follows the write already has
 * the grant. A refusal is not an error: loopback pairing still works and the
 * native endpoint reports `host_missing`.
 */
export const setLocalAgentsEnabled = async ({
  next,
  requestPermission,
  storage,
}: {
  next: boolean;
  requestPermission: () => Promise<void>;
  storage: LocalAgentStorageArea;
}): Promise<void> => {
  if (next) {
    await requestPermission();
  }

  await saveLocalAgentSettings(storage, { enabled: next });
};
