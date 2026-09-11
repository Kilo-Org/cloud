import { WorkspaceFolderColor as folderColors } from '@kilocode/db/schema-types';
import * as z from 'zod';

export const workspaceFolderColorSchema = z.enum(folderColors);

export type WorkspaceFolderColor = z.infer<typeof workspaceFolderColorSchema>;

export const workspaceFolderNameSchema = z.string().trim().min(1).max(200);

export type WorkspaceFolder = {
  id: string;
  name: string;
  color: WorkspaceFolderColor;
  worktreeIds: string[];
};
