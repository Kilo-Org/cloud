/**
 * Pure module state for tool-summary translation.
 *
 * Deliberately free of `react`, `react-native`, `expo-secure-store` and
 * `sonner-native`: the transcript graph (`fixed-part-row.tsx`) imports this
 * through `use-translated-tool-summary`, and the ~12 existing agent test files
 * render that graph in the node environment without mocking the native
 * modules. The gateway client is loaded lazily by dynamic import and the
 * encrypted-KV cache through `tool-summary-translation-store`, so this module
 * stays importable anywhere.
 */

import { type CachedToolSummaryTranslation } from '@/lib/persist/tool-summary-translation-cache';

import { persistTranslation, readStoredTranslations } from './tool-summary-translation-store';

/** The default translation model: matches the web `kilo-auto/small` entry. */
export const DEFAULT_TOOL_SUMMARY_TRANSLATION_MODEL = {
  id: 'kilo-auto/small',
  name: 'Auto Small',
} as const;

/**
 * How long a resolved translation may be reused before it is re-fetched: the
 * request's "couple of days". An entry past the TTL reads as a cache miss, so
 * the row re-requests it; the entry is not deleted eagerly, because the
 * cache's own cap evicts the oldest entries instead.
 */
export const TOOL_SUMMARY_TRANSLATION_TTL_MS = 2 * 24 * 60 * 60 * 1000;

export type ToolSummaryTranslationConfig = {
  enabled: boolean;
  model: { id: string; name: string };
};

type QueueItem = {
  key: string;
  /**
   * The part's persistent id (`ToolPart.id`). It survives an app restart
   * because the transcript is refetched with it. There is one entry per (part
   * id, source text) pair, so two tool calls with the same text never share an
   * entry, while the row and the detail sheet share one entry while they show
   * the same string.
   */
  itemId: string;
  text: string;
  language: string;
  model: { id: string; name: string };
  /** The configuration generation this work was queued under. */
  generation: number;
};

/** One request's worth of queued work: one language and model, unique texts. */
type FlushBatch = {
  language: string;
  modelId: string;
  /** The unique texts this request carries, in queue order. */
  texts: string[];
  /** Every queued item the request serves, including the duplicates by text. */
  items: QueueItem[];
};

/**
 * One memory-cache entry: one source string of one part, in one language and
 * model. The source text is part of the key, so a changed source and a second
 * surface resolving a different string each get their own entry instead of
 * evicting each other.
 */
type CacheEntry = {
  translation: string;
  /** The source text the translation was made from: a changed source is a miss. */
  text: string;
  /** Wall-clock expiry: an entry past it is a miss and is re-fetched. */
  expiresAt: number;
};

/** A resolved translation: the cached entry plus the key it belongs to. */
type ResolvedTranslation = CachedToolSummaryTranslation & { key: string };

const CACHE_CAP = 500;
/**
 * One commit's rows mount together, so a short window collects them before the
 * first request goes out. Ten rows mounted in one commit become one batch.
 */
const BATCH_WINDOW_MS = 40;
/** One request carries at most this many distinct texts. */
const MAX_BATCH_TEXTS = 20;
/** At most this many requests are in flight; the rest wait in the queue. */
const MAX_IN_FLIGHT_BATCHES = 2;

let config: ToolSummaryTranslationConfig = {
  enabled: false,
  model: DEFAULT_TOOL_SUMMARY_TRANSLATION_MODEL,
};
// Insertion order is oldest-first, so eviction is `keys().next()`.
const cache = new Map<string, CacheEntry>();
// Each running batch stores a unique token under every key it serves, so its
// `finally` can tell whether an entry is still its own. A config change clears
// the map, so a stale batch must not delete the entry its replacement stored.
const inFlight = new Map<string, symbol>();
const queue: QueueItem[] = [];
let activeBatches = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let version = 0;
/**
 * Bumped whenever the opt-in or the selected model changes. Queued and active
 * work captures the generation it was created under, so `setConfig` drops
 * queued items and a resolving batch discards results that belong to a prior
 * generation: a summary queued before the user disabled translation or switched
 * models must never reach the gateway.
 */
let generation = 0;
/**
 * The disk cache is read once per module instance. Until that read settles,
 * `flush` holds every batch: dispatching first would re-request a summary the
 * store already holds, which is the offline restart case.
 */
let hydrationStarted = false;
let hydrated = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * The translation identity: the persistent part id plus the source string it
 * was made from, under one language and model. The part id keeps two tool calls
 * with the same text apart; the source string lets a changed source and a
 * second surface each resolve on their own entry instead of evicting the other.
 */
// eslint-disable-next-line max-params -- the language, model, part id and source text form the key
function translationKey(
  language: string,
  modelId: string,
  itemId: string,
  text: string
): string {
  return `${language}\u0000${modelId}\u0000${itemId}\u0000${text}`;
}

/** Makes room for one more entry by dropping the oldest (insertion order). */
function makeCacheRoom(): void {
  while (cache.size >= CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    cache.delete(oldest);
  }
}

/**
 * True when the cache holds a usable translation for this key and source: an
 * entry made from different text, or one past the TTL, is a miss.
 */
function isFreshCacheEntry(key: string, text: string, now: number): boolean {
  const entry = cache.get(key);
  if (entry === undefined) {
    return false;
  }
  return entry.text === text && entry.expiresAt > now;
}

/**
 * One lazy read of the encrypted-KV cache, started from `setConfig` when the
 * opt-in turns on and from the first `ensureTranslation`. It seeds the memory
 * cache with the unexpired entries, then emits. A store failure reads as no
 * entries (memory only), so the flush is released either way and translation
 * never waits on the cache.
 */
function startHydration(): void {
  if (hydrationStarted) {
    return;
  }
  hydrationStarted = true;
  void (async () => {
    try {
      const entries = await readStoredTranslations();
      const now = Date.now();
      let seeded = false;
      for (const stored of entries) {
        const expiresAt = stored.storedAt + TOOL_SUMMARY_TRANSLATION_TTL_MS;
        const key = translationKey(
          stored.language,
          stored.modelId,
          stored.itemId,
          stored.text
        );
        if (expiresAt > now && !cache.has(key)) {
          makeCacheRoom();
          cache.set(key, { translation: stored.translation, text: stored.text, expiresAt });
          seeded = true;
        }
      }
      if (seeded) {
        version += 1;
        emit();
      }
    } catch {
      // Memory-only: a store read failure settles hydration as a no-op.
    } finally {
      // The flush is released either way, so translation never waits on the
      // cache.
      hydrated = true;
      flush();
    }
  })();
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
  // here (and skipping the mismatched generation in `takeBatch`) stops
  // translations the user just turned off or moved to another model. In-flight
  // entries are cleared too: their result is discarded by `runBatch`, and
  // leaving them would make `ensureTranslation` dedupe a fresh request against
  // a summary that will never resolve, so the row would stay untranslated.
  generation += 1;
  queue.length = 0;
  inFlight.clear();
  if (config.enabled) {
    // Warm the disk read as soon as the opt-in is on, in parallel with the
    // first transcript mount, so a cached summary is known before the flush.
    startHydration();
  }
  version += 1;
  emit();
}

// eslint-disable-next-line max-params -- the part id, source text, language and model are the lookup key
export function getTranslation(
  itemId: string,
  text: string,
  language: string,
  modelId: string
): string | undefined {
  const entry = cache.get(translationKey(language, modelId, itemId, text));
  if (entry === undefined || entry.text !== text || entry.expiresAt <= Date.now()) {
    return undefined;
  }
  return entry.translation;
}

/**
 * Write each resolved translation under its own key, with one notification,
 * then persist it fire-and-forget so a restart can hydrate it.
 */
function remember(resolved: ResolvedTranslation[]): void {
  if (resolved.length === 0) {
    return;
  }
  const expiresAt = Date.now() + TOOL_SUMMARY_TRANSLATION_TTL_MS;
  for (const { key, text, translation } of resolved) {
    makeCacheRoom();
    cache.set(key, { translation, text, expiresAt });
  }
  version += 1;
  emit();
  for (const entry of resolved) {
    void persistTranslation(entry);
  }
}

/**
 * Take one request's worth of work: the first eligible item decides the
 * language and model (a request carries exactly one of each), its stale and
 * already-known neighbours are dropped, and duplicate texts collapse to one
 * entry that is written back to every item that carried it.
 */
function takeBatch(): FlushBatch | null {
  // Work queued before the last configuration change (opt-in off or model
  // switch) is stale, same as a key that already resolved or is in flight. An
  // expired entry or one made from different text is not "already resolved".
  const now = Date.now();
  const eligible = queue.filter(
    item =>
      item.generation === generation &&
      !isFreshCacheEntry(item.key, item.text, now) &&
      !inFlight.has(item.key)
  );
  const head = eligible[0];
  if (head === undefined) {
    queue.length = 0;
    return null;
  }
  // The first eligible item decides the request's language and model: one
  // request carries exactly one of each.
  const { language } = head;
  const modelId = head.model.id;
  const texts: string[] = [];
  const items: QueueItem[] = [];
  const remaining: QueueItem[] = [];
  const seenTexts = new Set<string>();

  for (const item of eligible) {
    const isForeign = item.language !== language || item.model.id !== modelId;
    const isOverflow = !seenTexts.has(item.text) && texts.length >= MAX_BATCH_TEXTS;
    if (isForeign || isOverflow) {
      remaining.push(item);
    } else {
      if (!seenTexts.has(item.text)) {
        seenTexts.add(item.text);
        texts.push(item.text);
      }
      items.push(item);
    }
  }

  queue.length = 0;
  queue.push(...remaining);
  if (texts.length === 0) {
    return null;
  }
  return { language, modelId, texts, items };
}

/** Fallback contract: nothing thrown here may reach a transcript row. */
async function runBatch(batch: FlushBatch): Promise<void> {
  // One token for the whole request: a config change clears the map and a
  // replacement request for a key may already own its slot, so the `finally`
  // below only deletes entries that are still this request's.
  const token = Symbol(batch.language);
  for (const item of batch.items) {
    inFlight.set(item.key, token);
  }
  try {
    const { requestToolSummaryTranslations } = await import('./tool-summary-translation-client');
    const results = await requestToolSummaryTranslations({
      texts: batch.texts,
      targetLanguage: batch.language,
      model: batch.modelId,
    });
    const byText = new Map<string, string | null>();
    for (const [index, text] of batch.texts.entries()) {
      byText.set(text, results[index] ?? null);
    }
    const resolved: ResolvedTranslation[] = [];
    for (const item of batch.items) {
      // Results that resolve after the opt-in or model changed are discarded:
      // the summary belongs to a prior generation.
      if (item.generation === generation) {
        const translation = byText.get(item.text);
        if (translation !== null && translation !== undefined) {
          resolved.push({
            key: item.key,
            itemId: item.itemId,
            language: item.language,
            modelId: item.model.id,
            text: item.text,
            translation,
            storedAt: Date.now(),
          });
        }
      }
    }
    remember(resolved);
  } catch {
    // Leave it uncached; the original summary stays visible (layout is fixed).
  } finally {
    activeBatches -= 1;
    // Delete only this request's entries: a config change clears the map and a
    // replacement request for the same key may already own the slots.
    for (const item of batch.items) {
      if (inFlight.get(item.key) === token) {
        inFlight.delete(item.key);
      }
    }
    flush();
  }
}

function flush(): void {
  if (!hydrated) {
    // The disk read has not settled: dispatching now could re-request a
    // summary the store already holds. Hydration re-enters here when it does.
    startHydration();
    return;
  }
  while (activeBatches < MAX_IN_FLIGHT_BATCHES) {
    const batch = takeBatch();
    if (batch === null) {
      return;
    }
    activeBatches += 1;
    void runBatch(batch);
  }
}

/** One timer per window collects every row a commit enqueued. */
function scheduleFlush(): void {
  if (flushTimer !== null) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, BATCH_WINDOW_MS);
}

/**
 * Request a translation for one summary. No-op for blank text, keys whose
 * translation is cached and unexpired, and keys already in flight, so N rows
 * with the same summary make one call. A changed source resolves on its own key
 * rather than being dropped by the in-flight guard. The row does not send: the
 * batch window collects the commit's rows first.
 */
export function ensureTranslation(input: {
  itemId: string;
  text: string;
  language: string;
  model: { id: string; name: string };
}): void {
  const { itemId, text, language, model } = input;
  if (text.trim() === '') {
    return;
  }
  // Start the disk read now, before the batch window closes, so a hydrated
  // summary is known by the time the flush runs.
  startHydration();
  const key = translationKey(language, model.id, itemId, text);
  if (isFreshCacheEntry(key, text, Date.now()) || inFlight.has(key)) {
    return;
  }
  queue.push({ key, itemId, text, language, model, generation });
  scheduleFlush();
}
