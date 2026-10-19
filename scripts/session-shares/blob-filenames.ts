export const SHARE_BLOB_FILENAMES = [
  'api_conversation_history',
  'task_metadata',
  'ui_messages',
  'git_state',
] as const;

export type ShareBlobFilename = (typeof SHARE_BLOB_FILENAMES)[number];

export function isShareBlobFilename(value: string): value is ShareBlobFilename {
  return (SHARE_BLOB_FILENAMES as readonly string[]).includes(value);
}
