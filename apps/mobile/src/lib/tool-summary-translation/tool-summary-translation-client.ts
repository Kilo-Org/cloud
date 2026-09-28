import { z } from 'zod';

import { isSupportedLanguage, LANGUAGE_ENDONYMS } from '@/i18n/languages';
import { readStoredValue } from '@/lib/auth/secure-store-value';
import { getAuthTokenForRequest } from '@/lib/auth/token-owner';
import { API_BASE_URL } from '@/lib/config';
import { ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';

/**
 * The single Kilo gateway entry point for tool-summary translation, one request
 * per batch of summaries. Loaded only through the runtime's dynamic import, so
 * this module may carry the native and config imports the pure runtime must
 * avoid. Every failure resolves to one null per text: the caller keeps the
 * original summary rather than surfacing an error.
 *
 * The organization scope is read through the shared SecureStore helper, not a
 * direct `expo-secure-store` import: expo-secure-store exists on both iOS and
 * Android, so one entry point covers both platforms and there is no
 * per-platform storage branch to maintain.
 */

export const TOOL_SUMMARY_TRANSLATION_TIMEOUT_MS = 15_000;

/** Upper bound for the batch-scaled abort timeout. */
const MAX_BATCH_TIMEOUT_MS = 60_000;

/** Each extra text adds this much to the batch's abort deadline. */
const PER_TEXT_TIMEOUT_MS = 2000;

const GATEWAY_CHAT_COMPLETIONS_PATH = '/api/gateway/chat/completions';
const FEATURE_VALUE = 'tool-summary-translation';

/** Wire contract for the chat-completions response. Untrusted upstream at the entry boundary. */
const TranslationResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })),
});

/** The model's reply: a JSON array with one entry per text, in order. */
const TranslationArraySchema = z.array(z.unknown());

/** One entry of the reply: only a string is a translation. */
const TranslationEntrySchema = z.string();

export type RequestToolSummaryTranslationsInput = {
  texts: readonly string[];
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

/** The fallback for an unusable batch: one null per text. */
function nullResults(count: number): null[] {
  return Array.from({ length: count }, () => null);
}

/** Strips one optional ```` ```json ```` fence around the model's JSON array. */
function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/.exec(trimmed);
  return match?.[1] === undefined ? trimmed : match[1].trim();
}

/**
 * The model's content as one translation per text. Anything that is not a JSON
 * array of the same length is unusable, and a non-string or empty entry yields
 * null at that position only, so one bad entry never discards the batch.
 */
function parseTranslations(content: string, count: number): (string | null)[] {
  let raw: unknown = undefined;
  try {
    // The reply is untrusted: a parse failure is one null per text.
    raw = JSON.parse(stripCodeFence(content));
  } catch {
    return nullResults(count);
  }
  const parsed = TranslationArraySchema.safeParse(raw);
  if (!parsed.success || parsed.data.length !== count) {
    return nullResults(count);
  }
  return parsed.data.map(value => {
    const entry = TranslationEntrySchema.safeParse(value);
    if (!entry.success) {
      return null;
    }
    const translated = entry.data.trim();
    return translated === '' ? null : translated;
  });
}

/**
 * Translate a batch of tool summaries through the Kilo gateway with ONE
 * request. Returns one entry per text in the same order — the trimmed
 * translation, or null at a position whose entry was unusable. Every whole-batch
 * failure (no token, non-2xx, malformed body, timeout/abort, throw) returns one
 * null per text.
 */
export async function requestToolSummaryTranslations({
  texts,
  targetLanguage,
  model,
}: RequestToolSummaryTranslationsInput): Promise<(string | null)[]> {
  if (texts.length === 0) {
    return [];
  }
  const token = await getAuthTokenForRequest();
  if (!token) {
    return nullResults(texts.length);
  }
  // The organization scope the translation is attributed to; null is personal.
  const organizationId = await readStoredValue(ORGANIZATION_STORAGE_KEY);

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
  const prompt = `Translate each string of the user's JSON array into ${targetName}. The array holds ${texts.length} strings; return a JSON array of the same length and order, each string translated. Keep file paths, commands, code, and identifiers unchanged. Return only the JSON array, with no prose and no code fences.`;

  const controller = new AbortController();
  // A big batch needs longer than a single text; the scale stays bounded.
  const timeoutMs = Math.min(
    TOOL_SUMMARY_TRANSLATION_TIMEOUT_MS + PER_TEXT_TIMEOUT_MS * (texts.length - 1),
    MAX_BATCH_TIMEOUT_MS
  );
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(`${API_BASE_URL}${GATEWAY_CHAT_COMPLETIONS_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: JSON.stringify(texts) },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return nullResults(texts.length);
    }
    const parsed = TranslationResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return nullResults(texts.length);
    }
    const choice = parsed.data.choices[0];
    if (choice === undefined) {
      return nullResults(texts.length);
    }
    return parseTranslations(choice.message.content, texts.length);
  } catch {
    return nullResults(texts.length);
  } finally {
    clearTimeout(timeoutId);
  }
}
