import type { CloudAgentSessionPushStatus } from '../notifications-binding.js';

const PUSH_SNIPPET_MAX_LENGTH = 100;
const ELLIPSIS = '...';

export function truncatePushSnippet(text: string, maxLength = PUSH_SNIPPET_MAX_LENGTH): string {
  const singleLineText = text.trim().replace(/\s+/g, ' ');
  if (singleLineText.length <= maxLength) return singleLineText;
  if (maxLength <= ELLIPSIS.length) return ELLIPSIS.slice(0, maxLength);
  return singleLineText.slice(0, maxLength - ELLIPSIS.length) + ELLIPSIS;
}

/**
 * The English detail interpolated into the translated body templates
 * (`Failed: {{detail}}` / `Interrupted: {{detail}}`). Snippets and error text
 * are user/error-authored and pass through untranslated.
 */
export function buildCloudAgentPushDetail(
  status: CloudAgentSessionPushStatus,
  snippet?: string,
  error?: string
): string {
  const truncatedSnippet = snippet ? truncatePushSnippet(snippet) : undefined;

  if (status === 'completed') {
    return truncatedSnippet ?? 'Task completed';
  }

  if (status === 'failed') {
    return truncatedSnippet ?? (error ? truncatePushSnippet(error) : undefined) ?? 'Task failed';
  }

  return truncatedSnippet ?? 'Task interrupted';
}

export function buildCloudAgentPushBody(
  status: CloudAgentSessionPushStatus,
  snippet?: string,
  error?: string
): string {
  const detail = buildCloudAgentPushDetail(status, snippet, error);

  if (status === 'completed') {
    return detail;
  }

  if (status === 'failed') {
    return `Failed: ${detail}`;
  }

  return `Interrupted: ${detail}`;
}
