import type { CloudAgentSessionPushStatus } from '../notifications-binding.js';

const PUSH_SNIPPET_MAX_LENGTH = 100;
const ELLIPSIS = '...';

export function truncatePushSnippet(text: string, maxLength = PUSH_SNIPPET_MAX_LENGTH): string {
  const singleLineText = text.trim().replace(/\s+/g, ' ');
  if (singleLineText.length <= maxLength) return singleLineText;
  if (maxLength <= ELLIPSIS.length) return ELLIPSIS.slice(0, maxLength);
  return singleLineText.slice(0, maxLength - ELLIPSIS.length) + ELLIPSIS;
}

export function buildCloudAgentPushBody(
  status: CloudAgentSessionPushStatus,
  snippet?: string,
  error?: string
): string {
  const truncatedSnippet = snippet ? truncatePushSnippet(snippet) : undefined;

  if (status === 'completed') {
    return truncatedSnippet ?? 'Task completed';
  }

  if (status === 'failed') {
    const detail =
      truncatedSnippet ?? (error ? truncatePushSnippet(error) : undefined) ?? 'Task failed';
    return `Failed: ${detail}`;
  }

  const detail = truncatedSnippet ?? 'Task interrupted';
  return `Interrupted: ${detail}`;
}
