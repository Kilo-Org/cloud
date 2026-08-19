import { z } from 'zod';

export const WEB_MCP_SETTINGS_STORAGE_KEY = 'local:kiloWebMcpSettings';

// eslint-disable-next-line typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type
export type WebMcpSettings = {
  allowWebMcpInSafeMode: boolean;
};

/**
 * Off by default: safe mode exposes page WebMCP tools only after the user opts
 * in. Dangerous mode enables page tools without this setting.
 */
export const DEFAULT_WEB_MCP_SETTINGS: WebMcpSettings = {
  allowWebMcpInSafeMode: false,
};

export const webMcpSettingsSchema = z
  .object({
    allowWebMcpInSafeMode: z.boolean().default(false),
  })
  .strip();

type MaybePromise<Value> = Promise<Value> | Value;

export interface WebMcpSettingsStorageArea {
  getItem(key: typeof WEB_MCP_SETTINGS_STORAGE_KEY): MaybePromise<unknown>;
  setItem(key: typeof WEB_MCP_SETTINGS_STORAGE_KEY, value: unknown): MaybePromise<void>;
}

export const loadWebMcpSettings = async (
  storageArea: WebMcpSettingsStorageArea
): Promise<WebMcpSettings> => {
  const parsed = webMcpSettingsSchema.safeParse(
    await storageArea.getItem(WEB_MCP_SETTINGS_STORAGE_KEY)
  );
  return parsed.success ? parsed.data : DEFAULT_WEB_MCP_SETTINGS;
};

export const saveWebMcpSettings = async (
  storageArea: WebMcpSettingsStorageArea,
  settings: WebMcpSettings
): Promise<void> => {
  await storageArea.setItem(WEB_MCP_SETTINGS_STORAGE_KEY, webMcpSettingsSchema.parse(settings));
};
