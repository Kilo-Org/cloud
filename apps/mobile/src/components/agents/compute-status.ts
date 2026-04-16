import { type Part } from 'cloud-agent-sdk';

const toolStatusMap: Record<string, string> = {
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
};

export function computeStatus(part: Part): string {
  if (part.type === 'tool') {
    return toolStatusMap[part.tool] ?? 'Considering next steps';
  }
  if (part.type === 'reasoning') {
    return 'Thinking';
  }
  if (part.type === 'text') {
    return 'Writing response';
  }
  return 'Considering next steps';
}
