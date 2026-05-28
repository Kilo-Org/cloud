import type { Message, Thread } from 'chat';

const EXPLICIT_NEW_PULL_REQUEST_PATTERNS = [
  /\b(?:open|create|start|make)\s+(?:a\s+)?(?:new|fresh|separate)\s+(?:github\s+)?(?:pr|pull request)\b/,
  /\b(?:new|fresh|separate)\s+(?:github\s+)?(?:pr|pull request)\b/,
];

const NEGATED_NEW_PULL_REQUEST_PATTERNS = [
  /\b(?:no|without)\s+(?:a\s+)?(?:new|fresh|separate)\s+(?:github\s+)?(?:pr|pull request)\b/,
  /\b(?:do not|don't|dont|never)\s+(?:open|create|start|make)\s+(?:a\s+)?(?:new|fresh|separate)\s+(?:github\s+)?(?:pr|pull request)\b/,
];

function normalizeRequestText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\u2019/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function hasObjectProperty(value: unknown, key: string): value is object {
  return typeof value === 'object' && value !== null && key in value;
}

function getObjectProperty(value: unknown, key: string): unknown {
  if (!hasObjectProperty(value, key)) return undefined;
  return Reflect.get(value, key);
}

function isGitHubPullRequestThread(thread: Thread): boolean {
  return /^github:[^/]+\/[^:]+:\d+(?::rc:\d+)?$/.test(thread.id);
}

function isGitHubPullRequestMessage(message: Message): boolean {
  const raw = message.raw;
  if (hasObjectProperty(raw, 'pull_request')) return true;

  const issue = getObjectProperty(raw, 'issue');
  return hasObjectProperty(issue, 'pull_request');
}

function requestsSeparatePullRequest(text: string): boolean {
  const normalizedText = normalizeRequestText(text);
  if (NEGATED_NEW_PULL_REQUEST_PATTERNS.some(pattern => pattern.test(normalizedText))) {
    return false;
  }

  return EXPLICIT_NEW_PULL_REQUEST_PATTERNS.some(pattern => pattern.test(normalizedText));
}

export function shouldUseSeparatePullRequestStrategy({
  thread,
  message,
}: {
  thread: Thread;
  message: Message;
}): boolean {
  if (thread.adapter.name !== 'github') return false;
  if (!requestsSeparatePullRequest(message.text)) return false;

  return isGitHubPullRequestThread(thread) || isGitHubPullRequestMessage(message);
}
