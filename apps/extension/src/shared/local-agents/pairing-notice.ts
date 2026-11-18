/* eslint-disable typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface */
import { z } from 'zod';
import type { LocalAgentStorageArea } from './storage';

/*
 * Why the last pairing attempt failed, for the settings section. Session
 * storage on purpose: the notice must not outlive the browser session.
 */

export const LOCAL_AGENT_PAIRING_NOTICE_STORAGE_KEY = 'session:kiloLocalAgentPairingNotice';

export type LocalAgentPairingNotice = 'expired' | 'invalid' | 'not_allowed' | 'unreachable';

export const pairingNoticeSchema = z
  .object({
    notice: z.enum(['expired', 'invalid', 'not_allowed', 'unreachable']).nullable().default(null),
  })
  .strip();

export const loadPairingNotice = async (
  storage: LocalAgentStorageArea
): Promise<LocalAgentPairingNotice | null> => {
  const parsed = pairingNoticeSchema.safeParse(
    await storage.getItem(LOCAL_AGENT_PAIRING_NOTICE_STORAGE_KEY)
  );

  return parsed.success ? parsed.data.notice : null;
};

export const savePairingNotice = async (
  storage: LocalAgentStorageArea,
  notice: LocalAgentPairingNotice | null
): Promise<void> => {
  await storage.setItem(
    LOCAL_AGENT_PAIRING_NOTICE_STORAGE_KEY,
    pairingNoticeSchema.parse({ notice })
  );
};
