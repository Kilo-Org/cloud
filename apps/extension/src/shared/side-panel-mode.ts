import { z } from 'zod';

export const SIDE_PANEL_MODE_STORAGE_KEY = 'local:kiloSidePanelMode';
export const DEFAULT_SIDE_PANEL_MODE = 'browser' as const;
export type SidePanelMode = 'browser' | 'agents';

const sidePanelModeSchema = z.enum(['browser', 'agents']);

export interface SidePanelModeStorageArea {
  getItem(key: typeof SIDE_PANEL_MODE_STORAGE_KEY): unknown;
  setItem(key: typeof SIDE_PANEL_MODE_STORAGE_KEY, value: SidePanelMode): Promise<void> | void;
  removeItem(key: typeof SIDE_PANEL_MODE_STORAGE_KEY): Promise<void> | void;
}

export const loadSidePanelMode = async (
  storage: SidePanelModeStorageArea
): Promise<SidePanelMode> => {
  try {
    const stored = await storage.getItem(SIDE_PANEL_MODE_STORAGE_KEY);
    const parsed = sidePanelModeSchema.safeParse(stored);
    return parsed.success ? parsed.data : DEFAULT_SIDE_PANEL_MODE;
  } catch {
    return DEFAULT_SIDE_PANEL_MODE;
  }
};

export const saveSidePanelMode = async (
  storage: SidePanelModeStorageArea,
  mode: SidePanelMode
): Promise<void> => {
  await storage.setItem(SIDE_PANEL_MODE_STORAGE_KEY, mode);
};
