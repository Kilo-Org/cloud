import 'server-only';

import { fetchSessionSnapshot, type SessionSnapshot } from '@/lib/session-ingest-client';

const DEFAULT_RETRY_DELAY_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 3;

export function extractLastAssistantText(snapshot: SessionSnapshot): string | null {
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index];
    if (message.info.role !== 'assistant') {
      continue;
    }

    const text = message.parts
      .filter(part => part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('');

    if (text.length > 0) {
      return text;
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function fetchFinalAssistantTextWithRetries(params: {
  kiloSessionId: string;
  userId: string;
  maxAttempts?: number;
  retryDelayMs?: number;
  onRetry?: (attempt: number) => void | Promise<void>;
  onFetchError?: (attempt: number, error: unknown) => void | Promise<void>;
}): Promise<string | null> {
  const maxAttempts = params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = params.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      await params.onRetry?.(attempt);
      await sleep(retryDelayMs);
    }

    try {
      const snapshot = await fetchSessionSnapshot(params.kiloSessionId, params.userId);
      const text = snapshot ? extractLastAssistantText(snapshot) : null;
      if (text) {
        return text;
      }
    } catch (error) {
      await params.onFetchError?.(attempt, error);
    }
  }

  return null;
}
