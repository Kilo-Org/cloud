/**
 * Pure module state for tool-summary translation.
 *
 * Deliberately free of `react`, `react-native`, `expo-secure-store` and
 * `sonner-native`: the transcript graph (`fixed-part-row.tsx`) imports this
 * through `use-translated-tool-summary`, and the ~12 existing agent test files
 * render that graph in the node environment without mocking the native
 * modules. The gateway client is loaded lazily by dynamic import so this module
 * stays importable anywhere.
 */

/** The default translation model: matches the web `kilo-auto/small` entry. */
export const DEFAULT_TOOL_SUMMARY_TRANSLATION_MODEL = {
  id: 'kilo-auto/small',
  name: 'Auto Small',
} as const;

export type ToolSummaryTranslationConfig = {
  enabled: boolean;
  model: { id: string; name: string };
};

type QueueItem = {
  key: string;
  text: string;
  language: string;
  model: { id: string; name: string };
  /** The configuration generation this work was queued under. */
  generation: number;
};

const CACHE_CAP = 500;
const MAX_CONCURRENT = 4;

/**
 * First retry delay for a summary whose request produced no translation. Each
 * further attempt for the same key doubles it, capped at
 * `TOOL_SUMMARY_TRANSLATION_RETRY_MAX_MS`.
 */
export const TOOL_SUMMARY_TRANSLATION_RETRY_BASE_MS = 2000;
/** Ceiling for the retry backoff: a gateway that stays down is polled slowly. */
export const TOOL_SUMMARY_TRANSLATION_RETRY_MAX_MS = 30_000;

let config: ToolSummaryTranslationConfig = {
  enabled: false,
  model: DEFAULT_TOOL_SUMMARY_TRANSLATION_MODEL,
};
// Insertion order is oldest-first, so eviction is `keys().next()`.
const cache = new Map<string, string>();
// Each running request stores a unique token so its `finally` can tell whether
// the entry is still its own. A config change clears the map, so a stale run
// must not delete the entry its replacement just stored.
const inFlight = new Map<string, symbol>();
const queue: QueueItem[] = [];
/**
 * Per-key retry attempts, the delay exponent for `scheduleRetry`. A request
 * that settles with no translation leaves nothing cached and is not re-queued
 * by anyone else, so without this a failed summary would keep a row's
 * count-only label for the row's whole life.
 */
const retryAttempts = new Map<string, number>();
let active = 0;
let version = 0;
/**
 * Bumped whenever the opt-in or the selected model changes. Queued and active
 * work captures the generation it was created under, so `setConfig` drops
 * queued items and `run` discards results that resolve after the change: a
 * summary queued before the user disabled translation or switched models must
 * never reach the gateway.
 */
let generation = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function translationKey(language: string, modelId: string, text: string): string {
  return `${language}\u0000${modelId}\u0000${text}`;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getVersion(): number {
  return version;
}

export function getConfig(): ToolSummaryTranslationConfig {
  return config;
}

/** Shallow-equal guard: only a real change bumps the version and notifies. */
export function setConfig(next: ToolSummaryTranslationConfig): void {
  if (
    config.enabled === next.enabled &&
    config.model.id === next.model.id &&
    config.model.name === next.model.name
  ) {
    return;
  }
  config = { enabled: next.enabled, model: { id: next.model.id, name: next.model.name } };
  // Any queued work was captured under the previous opt-in/model; dropping it
  // here (and skipping the mismatched generation in `pump`) stops translations
  // the user just turned off or moved to another model. In-flight entries are
  // cleared too: their result is discarded by `run`, and leaving them would make
  // `ensureTranslation` dedupe a fresh request against a summary that will never
  // resolve, so the row would stay untranslated.
  generation += 1;
  queue.length = 0;
  inFlight.clear();
  retryAttempts.clear();
  version += 1;
  emit();
}

export function getTranslation(
  text: string,
  language: string,
  modelId: string
): string | undefined {
  return cache.get(translationKey(language, modelId, text));
}

function remember(key: string, translated: string): void {
  if (cache.size >= CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(key, translated);
  version += 1;
  emit();
}

/**
 * Fallback contract: nothing thrown here may reach a transcript row. A request
 * that settles without a translation (`null`, or a thrown client) is asked
 * again later: the runtime is the only thing that ever requests a summary, so
 * without a retry one gateway hiccup would leave every row that embeds the
 * summary in its own copy (`CondensedToolRunRow`) on the count-only label for
 * the row's whole life. Rows that can fall back in place show the original
 * meanwhile.
 */
async function run(item: QueueItem, token: symbol): Promise<void> {
  // Retry only work the current configuration still wants: a config change
  // supersedes this request, and that generation re-requests on its own.
  let retry = false;
  try {
    const { requestToolSummaryTranslation } = await import('./tool-summary-translation-client');
    const translated = await requestToolSummaryTranslation({
      text: item.text,
      targetLanguage: item.language,
      model: item.model.id,
    });
    if (translated !== null && item.generation === generation) {
      retryAttempts.delete(item.key);
      remember(item.key, translated);
    } else {
      retry = item.generation === generation;
    }
  } catch {
    retry = item.generation === generation;
  } finally {
    active -= 1;
    // Delete only this request's entry: a config change clears the map and a
    // replacement request for the same key may already own the slot.
    if (inFlight.get(item.key) === token) {
      inFlight.delete(item.key);
    }
    if (retry) {
      scheduleRetry(item);
    }
    pump();
  }
}

/**
 * Re-queue a summary whose request settled without a translation, after a
 * per-summary backoff so a gateway that stays down is polled slowly rather
 * than hammered. The wait checks the generation, exactly like queued work, so
 * a config change during the wait drops the retry.
 */
function scheduleRetry(item: QueueItem): void {
  const attempt = (retryAttempts.get(item.key) ?? 0) + 1;
  retryAttempts.set(item.key, attempt);
  const delay = Math.min(
    TOOL_SUMMARY_TRANSLATION_RETRY_BASE_MS * 2 ** (attempt - 1),
    TOOL_SUMMARY_TRANSLATION_RETRY_MAX_MS
  );
  setTimeout(() => {
    if (item.generation !== generation) {
      return;
    }
    ensureTranslation({ text: item.text, language: item.language, model: item.model });
  }, delay);
}

function pump(): void {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) {
      return;
    }
    // Work queued before the last configuration change (opt-in off or model
    // switch) is stale and must not be sent, same as a cached or in-flight key.
    const isStale = item.generation !== generation;
    const isDuplicate = cache.has(item.key) || inFlight.has(item.key);
    if (!isStale && !isDuplicate) {
      active += 1;
      const token = Symbol(item.key);
      inFlight.set(item.key, token);
      void run(item, token);
    }
  }
}

/**
 * Request a translation for one summary. No-op for blank text, cached keys and
 * keys already in flight, so N rows with the same summary make one call.
 */
export function ensureTranslation(input: {
  text: string;
  language: string;
  model: { id: string; name: string };
}): void {
  const { text, language, model } = input;
  if (text.trim() === '') {
    return;
  }
  const key = translationKey(language, model.id, text);
  if (cache.has(key) || inFlight.has(key)) {
    return;
  }
  queue.push({ key, text, language, model, generation });
  pump();
}
