import { type Part } from '@kilocode/cloud-agent-sdk';

import { isSnapshotProgressPart } from './part-types';

const toolStatusMap = {
  read: 'Exploring',
  grep: 'Searching the codebase',
  glob: 'Searching the codebase',
  list: 'Searching the codebase',
  edit: 'Making edits',
  write: 'Making edits',
  bash: 'Running commands',
  websearch: 'Searching the web',
  webfetch: 'Searching the web',
  codesearch: 'Searching the web',
  todowrite: 'Planning next steps',
  todoread: 'Planning next steps',
  task: 'Delegating work',
  question: 'Asking a question',
} satisfies Record<string, string>;

/** Matches CLI PROGRESS_INITIALIZING typography (U+2026 ellipsis). */
export const SNAPSHOT_PROGRESS_STATUS = 'Initializing snapshot…';

export function computeStatus(part: Part): string {
  if (part.type === 'tool') {
    return Object.hasOwn(toolStatusMap, part.tool)
      ? toolStatusMap[part.tool as keyof typeof toolStatusMap]
      : 'Considering next steps';
  }
  if (part.type === 'reasoning') {
    return 'Thinking';
  }
  if (part.type === 'text') {
    if (isSnapshotProgressPart(part)) {
      return SNAPSHOT_PROGRESS_STATUS;
    }
    return 'Writing response';
  }
  return 'Considering next steps';
}
