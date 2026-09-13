import * as SecureStore from 'expo-secure-store';
import { z } from 'zod';

import { isSupportedLanguage, LANGUAGE_ENDONYMS } from '@/i18n/languages';
import { getAuthTokenForRequest } from '@/lib/auth/token-owner';
import { API_BASE_URL } from '@/lib/config';
import { ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';

/**
 * The single Kilo gateway entry point for tool-summary translation. Loaded only
 * through the runtime's dynamic import, so this module may carry the native and
 * config imports the pure runtime must avoid. Every failure returns null: the
 * caller keeps the original summary rather than surfacing an error.
 */

export const TOOL_SUMMARY_TRANSLATION_TIMEOUT_MS = 15_000;

const GATEWAY_CHAT_COMPLETIONS_PATH = '/api/gateway/chat/completions';
const FEATURE_VALUE = 'tool-summary-translation';

/** Wire contract for the chat-completions response. Untrusted upstream at the entry boundary. */
const TranslationResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })),
});

export type RequestToolSummaryTranslationInput = {
  text: string;
  targetLanguage: string;
  model: string;
};

/** Wire headers for the translation request; the organization header is scoped. */
type TranslationRequestHeaders = {
  Authorization: string;
  'Content-Type': string;
  'X-KILOCODE-FEATURE': string;
  'X-KiloCode-OrganizationId'?: string;
};

/** Read the organization scope the translation is attributed to; null is personal. */
async function readStoredOrganizationId(): Promise<string | null> {
  const value = await SecureStore.getItemAsync(ORGANIZATION_STORAGE_KEY);
  return value;
}

/**
 * Translate one tool summary through the Kilo gateway. Returns the trimmed
 * translation, or null on any failure (no token, non-2xx, malformed body,
 * timeout/abort, empty content, throw).
 */
export async function requestToolSummaryTranslation({
  text,
  targetLanguage,
  model,
}: RequestToolSummaryTranslationInput): Promise<string | null> {
  const token = await getAuthTokenForRequest();
  if (!token) {
    return null;
  }
  const organizationId = await readStoredOrganizationId();

  const headers: TranslationRequestHeaders = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-KILOCODE-FEATURE': FEATURE_VALUE,
  };
  if (organizationId && organizationId !== '') {
    headers['X-KiloCode-OrganizationId'] = organizationId;
  }

  const targetName = isSupportedLanguage(targetLanguage)
    ? LANGUAGE_ENDONYMS[targetLanguage]
    : targetLanguage;
  const prompt = `Translate the user's text into ${targetName}. Keep file paths, commands, code, and identifiers unchanged. Return only the translation, with no quotes or commentary.`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, TOOL_SUMMARY_TRANSLATION_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE_URL}${GATEWAY_CHAT_COMPLETIONS_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: text },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const parsed = TranslationResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return null;
    }
    const choice = parsed.data.choices[0];
    if (choice === undefined) {
      return null;
    }
    const content = choice.message.content.trim();
    return content === '' ? null : content;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
