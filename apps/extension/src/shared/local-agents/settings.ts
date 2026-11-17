/* eslint-disable typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface */
import { z } from 'zod';
import type { LocalAgentStorageArea } from './storage';

/*
 * "Allow local agents" is the only browser-side consent (SPEC D1). Off by
 * default, and stored under its own key so no other settings section can
 * rewrite it.
 */

export const LOCAL_AGENT_SETTINGS_STORAGE_KEY = 'local:kiloLocalAgentSettings';

export type LocalAgentSettings = { enabled: boolean };

export const DEFAULT_LOCAL_AGENT_SETTINGS: LocalAgentSettings = { enabled: false };

export const localAgentSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .strip();

export const loadLocalAgentSettings = async (
  storage: LocalAgentStorageArea
): Promise<LocalAgentSettings> => {
  const parsed = localAgentSettingsSchema.safeParse(
    await storage.getItem(LOCAL_AGENT_SETTINGS_STORAGE_KEY)
  );

  return parsed.success ? parsed.data : DEFAULT_LOCAL_AGENT_SETTINGS;
};

export const saveLocalAgentSettings = async (
  storage: LocalAgentStorageArea,
  settings: LocalAgentSettings
): Promise<void> => {
  await storage.setItem(LOCAL_AGENT_SETTINGS_STORAGE_KEY, localAgentSettingsSchema.parse(settings));
};
