import { z } from 'zod';

export const MEMORY_SETTINGS_STORAGE_KEY = 'local:kiloMemorySettings';

// eslint-disable-next-line typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type
export type AgentMemorySettings = {
  autoApproveMemorySaves: boolean;
};

/**
 * Off by default: `save_memory` shows the approval card until the user opts out.
 * Kept in its own storage key so the Memories settings section never writes the
 * workflow settings blob — both sections are mounted at once and would clobber
 * each other's toggles.
 */
export const DEFAULT_MEMORY_SETTINGS: AgentMemorySettings = {
  autoApproveMemorySaves: false,
};

export const agentMemorySettingsSchema = z
  .object({
    autoApproveMemorySaves: z.boolean().default(false),
  })
  .strip();

type MaybePromise<Value> = Promise<Value> | Value;

export interface AgentMemorySettingsStorageArea {
  getItem(key: typeof MEMORY_SETTINGS_STORAGE_KEY): MaybePromise<unknown>;
  setItem(key: typeof MEMORY_SETTINGS_STORAGE_KEY, value: unknown): MaybePromise<void>;
}

export const loadMemorySettings = async (
  storageArea: AgentMemorySettingsStorageArea
): Promise<AgentMemorySettings> => {
  const parsed = agentMemorySettingsSchema.safeParse(
    await storageArea.getItem(MEMORY_SETTINGS_STORAGE_KEY)
  );
  return parsed.success ? parsed.data : DEFAULT_MEMORY_SETTINGS;
};

export const saveMemorySettings = async (
  storageArea: AgentMemorySettingsStorageArea,
  settings: AgentMemorySettings
): Promise<void> => {
  await storageArea.setItem(MEMORY_SETTINGS_STORAGE_KEY, agentMemorySettingsSchema.parse(settings));
};
