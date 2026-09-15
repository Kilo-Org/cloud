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

/** One request's worth of queued work: one language and model, unique texts. */
type FlushBatch = {
  language: string;
  modelId: string;
  /** The unique texts this request carries, in queue order. */
  texts: string[];
  /** Every queued item the request serves, including the duplicates by text. */
  items: QueueItem[];
};

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
const cache = new Map<string, string>();
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
  // here (and skipping the mismatched generation in `takeBatch`) stops
  // translations the user just turned off or moved to another model. In-flight
  // entries are cleared too: their result is discarded by `runBatch`, and
  // leaving them would make `ensureTranslation` dedupe a fresh request against
  // a summary that will never resolve, so the row would stay untranslated.
  generation += 1;
  queue.length = 0;
  inFlight.clear();
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

/** Write each resolved translation under its own key, with one notification. */
function remember(resolved: { key: string; translated: string }[]): void {
  if (resolved.length === 0) {
    return;
  }
  for (const { key, translated } of resolved) {
    if (cache.size >= CACHE_CAP) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
    cache.set(key, translated);
  }
  version += 1;
  emit();
}

/**
 * Take one request's worth of work: the first eligible item decides the
 * language and model (a request carries exactly one of each), its stale and
 * already-known neighbours are dropped, and duplicate texts collapse to one
 * entry that is written back to every item that carried it.
 */
function takeBatch(): FlushBatch | null {
  // Work queued before the last configuration change (opt-in off or model
  // switch) is stale, same as a key that already resolved or is in flight.
  const eligible = queue.filter(
    item => item.generation === generation && !cache.has(item.key) && !inFlight.has(item.key)
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
    const resolved: { key: string; translated: string }[] = [];
    for (const item of batch.items) {
      // Results that resolve after the opt-in or model changed are discarded:
      // the summary belongs to a prior generation.
      if (item.generation === generation) {
        const translated = byText.get(item.text);
        if (translated !== null && translated !== undefined) {
          resolved.push({ key: item.key, translated });
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
 * Request a translation for one summary. No-op for blank text, cached keys and
 * keys already in flight, so N rows with the same summary make one call. The
 * row does not send: the batch window collects the commit's rows first.
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
  scheduleFlush();
}
