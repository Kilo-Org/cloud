import type {
  SmartFolderPreset,
  WorkspaceFolder,
  WorkspaceFolderSortMode,
} from '@/lib/cloud-agent/workspace-folders';

export type SmartFolderDefinition = {
  preset: SmartFolderPreset;
  name: string;
  description: string;
  color: WorkspaceFolder['color'];
};

export const SMART_FOLDER_DEFINITIONS: readonly SmartFolderDefinition[] = [
  {
    preset: 'needs_you',
    name: 'Needs you',
    description: 'Attention, questions, and failed turns across a workspace stack.',
    color: 'orange',
  },
  {
    preset: 'in_review',
    name: 'In review',
    description: 'Workspaces with an open or draft pull request.',
    color: 'blue',
  },
  {
    preset: 'done',
    name: 'Done',
    description: 'Workspaces whose pull requests are all merged or closed.',
    color: 'green',
  },
];

export const SIDEBAR_SORT_OPTIONS: readonly {
  value: WorkspaceFolderSortMode;
  label: string;
}[] = [
  { value: 'manual', label: 'Manual' },
  { value: 'created', label: 'Created' },
  { value: 'activity', label: 'Last activity' },
];

export type SmartFolderToggle =
  | { action: 'create'; definition: SmartFolderDefinition }
  | { action: 'delete'; folderId: string }
  | null;

export function getSmartFolderToggle(
  folders: readonly WorkspaceFolder[],
  preset: SmartFolderPreset,
  enabled: boolean
): SmartFolderToggle {
  const existing = folders.find(folder => folder.kind === 'smart' && folder.smartPreset === preset);
  if (!enabled) return existing ? { action: 'delete', folderId: existing.id } : null;
  if (existing) return null;
  const definition = SMART_FOLDER_DEFINITIONS.find(option => option.preset === preset);
  return definition ? { action: 'create', definition } : null;
}
