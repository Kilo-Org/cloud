import { WorkspaceFolderColor as folderColors } from '@kilocode/db/schema-types';
import * as z from 'zod';

export const workspaceFolderColorSchema = z.enum(folderColors);

export type WorkspaceFolderColor = z.infer<typeof workspaceFolderColorSchema>;

export const workspaceFolderNameSchema = z.string().trim().min(1).max(200);

export const workspaceFolderSortModeSchema = z.enum(['manual', 'created', 'activity']);

export type WorkspaceFolderSortMode = z.infer<typeof workspaceFolderSortModeSchema>;

export const workspaceOrderSchema = workspaceFolderSortModeSchema;

export type WorkspaceOrder = z.infer<typeof workspaceOrderSchema>;

export const DEFAULT_WORKSPACE_ORDER: WorkspaceOrder = 'manual';

/** The sidebar workspace list accepts at most this many search characters. */
export const WORKSPACE_LIST_SEARCH_MAX_LENGTH = 256;

export function defaultWorkspaceOrder(): WorkspaceOrder {
  return DEFAULT_WORKSPACE_ORDER;
}

export const workspaceFolderKindSchema = z.enum(['manual', 'smart']);

export type WorkspaceFolderKind = z.infer<typeof workspaceFolderKindSchema>;

export const smartFolderPresetSchema = z.enum(['needs_you', 'in_review', 'done']);

export type SmartFolderPreset = z.infer<typeof smartFolderPresetSchema>;

export type WorkspaceFolder = {
  id: string;
  name: string;
  color: WorkspaceFolderColor;
  kind: WorkspaceFolderKind;
  smartPreset: SmartFolderPreset | null;
  sortMode: WorkspaceFolderSortMode;
  worktreeIds: string[];
};
