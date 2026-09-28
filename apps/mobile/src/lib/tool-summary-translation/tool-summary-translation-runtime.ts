/* eslint-disable max-lines -- the runtime owns the full batch/hydration/retry state machine; splitting it would scatter the invariants its generation, in-flight and retry bookkeeping share. */
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

import type * as toolSummaryTranslationClient from './tool-summary-translation-client';

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

/**
 * Longest a store read may hold the first flush. The store is a warm-start
 * optimization, never a source of truth, so a read that never settles — a
 * native module that hangs — must not block every translation; past this the
 * flush proceeds memory-only.
 */
export const TOOL_SUMMARY_TRANSLATION_HYDRATION_TIMEOUT_MS = 2000;

/**
 * Longest sign-out waits for the store writes it already dispatched. A healthy
 * write settles in milliseconds; past this one is treated as hung — the store
 * is a native module, and a write that never answers must not hold sign-out
 * teardown and the disk-scope clear that follows it.
 */
export const TOOL_SUMMARY_TRANSLATION_SIGN_OUT_DRAIN_TIMEOUT_MS = 1000;

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
/**
 * Upper bound on remembered unresolved summaries. Re-entry to an already
 * mounted transcript is a navigation no-op, so failed work is remembered here
 * for `retryUnresolvedTranslations` instead of waiting for a remount; the cap
 * keeps that memory bounded to more than any single screen shows.
 */
const MAX_RETRYABLE_ENTRIES = 200;

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
// Every summary that was asked for but has not resolved, keyed like the cache.
// A failed batch leaves its items here so `retryUnresolvedTranslations` can
// re-queue them when the session transport comes back; a resolving batch
// removes them. `ensureTranslation` drops the same part's other source texts,
// so at most one text per part is remembered. Insertion order is oldest-first,
// so eviction is `keys().next()`.
const retryable = new Map<string, QueueItem>();
// The keys the queue currently holds. A mounted row re-asks on its own cadence
// while its summary is unresolved, and a summary parked behind the batch window
// or the in-flight cap is neither cached nor in flight, so without this each
// ask of every waiting row would stack another copy of it: the queue would grow
// without bound during an outage, and the copies would replay as extra store
// writes once a slot freed. `ensureTranslation` treats a queued key like an
// in-flight one, and `takeBatch` resyncs the set to the queue it leaves behind.
const queued = new Set<string>();
// The client module loads through one memoized dynamic import, like the
// store's: concurrent batches share the single in-flight load instead of each
// re-importing, and a failed load is retried by the next batch.
let clientPromise: Promise<typeof toolSummaryTranslationClient> | null = null;

/**
 * The store writes `remember` has dispatched that have not settled yet, each
 * with the time it was dispatched. A sign-out must drain them before it clears
 * the disk scope: a write that started under the signed-out account can
 * otherwise land after the clear and leave its entry behind.
 * `drainPendingPersists` bounds that wait, so a write that never settles cannot
 * hold sign-out teardown either; for the same reason a write is remembered only
 * for that bound, so a store that never answers cannot keep one tracked
 * promise — and the entry it captured — per resolved translation for the whole
 * session.
 */
const pendingPersists = new Map<Promise<void>, number>();

/** Tracks one fire-and-forget store write until it settles or ages out. */
function trackPersist(write: Promise<void>): void {
  const dispatchedAt = Date.now();
  // Drop the writes a sign-out would already have abandoned: a store whose
  // writes never settle would otherwise grow this map for the whole session.
  for (const [tracked, trackedAt] of pendingPersists) {
    if (dispatchedAt - trackedAt >= TOOL_SUMMARY_TRANSLATION_SIGN_OUT_DRAIN_TIMEOUT_MS) {
      pendingPersists.delete(tracked);
    }
  }
  pendingPersists.set(write, dispatchedAt);
  void (async () => {
    try {
      await write;
    } catch {
      // The store already reports its own failure as a cache miss; the tracker
      // must only stop tracking the write, so a rejection neither leaks the
      // entry in `pendingPersists` nor escapes as an unhandled rejection.
    } finally {
      pendingPersists.delete(write);
    }
  })();
}

async function loadClient(): Promise<typeof toolSummaryTranslationClient> {
  const pending = (clientPromise ??= import('./tool-summary-translation-client'));
  try {
    return await pending;
  } catch (error) {
    if (clientPromise === pending) {
      clientPromise = null;
    }
    throw error;
  }
}

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
/**
 * Bumped by {@link clearToolSummaryTranslationMemory} on sign-out and on a
 * direct account switch. {@link startHydration} reads it before it awaits the
 * store and drops the seed when it changed meanwhile: the entries that read
 * returns belong to the account the reset just dropped, so seeding them would
 * repopulate the cache the reset cleared. Only the account reset counts here —
 * a configuration change keeps the cache and its hydration seed.
 */
let accountResetEpoch = 0;
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
function translationKey(language: string, modelId: string, itemId: string, text: string): string {
  return `${language}\u0000${modelId}\u0000${itemId}\u0000${text}`;
}

/**
 * How many mounted surfaces currently ask for one key's source text. The hook
 * effect registers its surface while it renders the text and releases it on
 * cleanup, so a part shown by two surfaces (row and detail sheet) under
 * different source strings holds both keys, while a part whose text streamed
 * on holds only the settled one.
 */
const surfaceInterest = new Map<string, number>();

function addSurfaceInterest(key: string): void {
  surfaceInterest.set(key, (surfaceInterest.get(key) ?? 0) + 1);
}

function removeSurfaceInterest(key: string): void {
  const count = surfaceInterest.get(key) ?? 0;
  if (count <= 1) {
    surfaceInterest.delete(key);
  } else {
    surfaceInterest.set(key, count - 1);
  }
}

/**
 * Re-derives {@link queued} from the queue a pass just rewrote. `takeBatch`
 * rebuilds the queue (dropping resolved and stale items and keeping the copies
 * a retry left queued), so the set must follow it exactly; otherwise a later
 * `ensureTranslation` would miss a key that is still queued and stack a second
 * copy of it.
 */
function syncQueuedKeys(): void {
  queued.clear();
  for (const item of queue) {
    queued.add(item.key);
  }
}

/**
 * Drops one part's superseded source text from the retry memory and from the
 * queue. A text is superseded only when no mounted surface asks for it any
 * more: a part renders one source string at a time, but two surfaces may
 * render two strings of one part side by side, so a text another surface still
 * shows must neither be dropped from the queue nor from the retry memory. A
 * text no surface shows any more, though, must neither be dispatched from the
 * queue by a later flush nor re-sent by `retryUnresolvedTranslations`: either
 * would carry a summary the rows no longer show.
 */
// eslint-disable-next-line max-params -- the language, model, part id and source text form the key
function forgetSupersededEntries(
  language: string,
  modelId: string,
  itemId: string,
  key: string
): void {
  const partPrefix = `${language}\u0000${modelId}\u0000${itemId}\u0000`;
  for (const remembered of retryable.keys()) {
    if (
      remembered !== key &&
      remembered.startsWith(partPrefix) &&
      !surfaceInterest.has(remembered)
    ) {
      retryable.delete(remembered);
    }
  }
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const candidate = queue[index];
    if (
      candidate !== undefined &&
      candidate.key !== key &&
      candidate.key.startsWith(partPrefix) &&
      !surfaceInterest.has(candidate.key)
    ) {
      queue.splice(index, 1);
      queued.delete(candidate.key);
    }
  }
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

const noopTimeoutResolution = (_entries: CachedToolSummaryTranslation[]) => undefined;
const noopVoidResolution = () => undefined;

/**
 * Awaits the stored read, or `[]` once {@link
 * TOOL_SUMMARY_TRANSLATION_HYDRATION_TIMEOUT_MS} elapses: a read that never
 * settles must not hold every translation, and the cache is an optimization
 * either way. The timer is cleared when the read wins; a read that settles
 * after the timeout is discarded.
 */
async function readStoredTranslationsWithinTimeout(): Promise<CachedToolSummaryTranslation[]> {
  let resolveTimeout: (entries: CachedToolSummaryTranslation[]) => void = noopTimeoutResolution;
  const timeout = new Promise<CachedToolSummaryTranslation[]>(resolve => {
    resolveTimeout = resolve;
  });
  const timeoutId = setTimeout(() => {
    resolveTimeout([]);
  }, TOOL_SUMMARY_TRANSLATION_HYDRATION_TIMEOUT_MS);
  try {
    return await Promise.race([readStoredTranslations(), timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * One lazy read of the encrypted-KV cache, started from `setConfig` when the
 * opt-in turns on and from the first `ensureTranslation`. It seeds the memory
 * cache with the unexpired entries, then emits. A store failure or a read that
 * never settles reads as no entries (memory only), so the flush is released
 * either way and translation never waits on the cache. A read that settles
 * after an account reset seeds nothing: the reset's clear is final.
 */
function startHydration(): void {
  if (hydrationStarted) {
    return;
  }
  hydrationStarted = true;
  const epochAtStart = accountResetEpoch;
  void (async () => {
    try {
      const entries = await readStoredTranslationsWithinTimeout();
      // A reset that ran while the read was in flight already cleared the
      // cache this read was started for; its entries are the signed-out
      // account's, so the read must neither seed nor notify.
      if (epochAtStart !== accountResetEpoch) {
        return;
      }
      const now = Date.now();
      let seeded = false;
      for (const stored of entries) {
        const expiresAt = stored.storedAt + TOOL_SUMMARY_TRANSLATION_TTL_MS;
        const key = translationKey(stored.language, stored.modelId, stored.itemId, stored.text);
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

/**
 * How many summaries are waiting for a concurrency slot. Exposed alongside
 * `getVersion` for the runtime's tests: a row retries on its own cadence while
 * its summary is unresolved, so a waiting summary that took two entries here
 * would grow the queue with every tick of every mounted row.
 */
export function getQueueSize(): number {
  return queue.length;
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
  // The retry memory is cleared with them: mounted rows re-request under the
  // new generation through the hook effect, so remembering the old model's
  // failures would only make `retryUnresolvedTranslations` re-send work the
  // user just invalidated.
  generation += 1;
  queue.length = 0;
  queued.clear();
  inFlight.clear();
  retryable.clear();
  // The hook effect re-runs for every active row (its deps carry the config),
  // so interest re-registers under the new generation.
  surfaceInterest.clear();
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
    // Resolved: it is no longer a retry candidate.
    retryable.delete(key);
  }
  version += 1;
  emit();
  for (const entry of resolved) {
    trackPersist(persistTranslation(entry));
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
  // switch) is stale, same as a key that already resolved. An expired entry or
  // one made from different text is not "already resolved". A key another
  // request already owns is neither: it stays queued instead of being dropped.
  // A retry that arrives while the attempt it races is still pending would
  // otherwise lose its re-queued work here and never issue it, leaving the row
  // in the source language; kept in the queue, it is dispatched when that
  // attempt settles unresolved, and the freshness check drops it when the
  // attempt resolves.
  const now = Date.now();
  const current = queue.filter(item => item.generation === generation);
  const eligible: QueueItem[] = [];
  const owned: QueueItem[] = [];
  for (const item of current) {
    if (isFreshCacheEntry(item.key, item.text, now)) {
      // Resolved through hydration or a duplicate request while this item
      // waited: no retry memory is needed for a summary already translated.
      retryable.delete(item.key);
    } else if (inFlight.has(item.key)) {
      // A retry re-queued this row while the attempt it races is still
      // pending, so the row's re-request would be lost here. Kept, it is
      // dispatched when that attempt settles unresolved. The part must still
      // ask for this text: `ensureTranslation` prunes a superseded source
      // text from the queue and the retry memory together once no surface
      // asks for it, so an owned key the part no longer asks for is gone
      // from the queue, and one that resolved while it waited (no longer in
      // `retryable`) is dropped here instead of being dispatched by a later
      // flush.
      if (retryable.has(item.key)) {
        owned.push(item);
      }
    } else {
      eligible.push(item);
    }
  }
  const head = eligible[0];
  if (head === undefined) {
    queue.length = 0;
    queue.push(...owned);
    syncQueuedKeys();
    return null;
  }
  // The first eligible item decides the request's language and model: one
  // request carries exactly one of each.
  const { language } = head;
  const modelId = head.model.id;
  const texts: string[] = [];
  const items: QueueItem[] = [];
  const remaining: QueueItem[] = [...owned];
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
  syncQueuedKeys();
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
    const { requestToolSummaryTranslations } = await loadClient();
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
 * translation is cached and unexpired, and keys already in flight or queued, so
 * N rows with the same summary make one call however often they retry. A
 * changed source resolves on its own key rather than being dropped by the
 * in-flight guard, and a summary parked behind the batch window or the in-flight
 * cap is not stacked again. The row does not send: the batch window collects the
 * commit's rows first.
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
  // This mounted surface asks for `text` until its effect cleanup runs: the
  // supersede prune below must not drop a queued copy another surface still
  // renders, and this text's own copy must outlive unrelated work.
  addSurfaceInterest(key);
  // This part now asks for `text`: any other source string remembered or
  // queued for the same part that no surface asks for any more is superseded,
  // so drop it from the retry memory and the queue before the freshness,
  // in-flight and queued guards return.
  forgetSupersededEntries(language, model.id, itemId, key);
  if (isFreshCacheEntry(key, text, Date.now())) {
    // Resolved: no retry memory is needed for a summary already translated.
    return;
  }
  const item: QueueItem = { key, itemId, text, language, model, generation };
  // Remember the unresolved summary before the in-flight and queued guards
  // return, so `retryUnresolvedTranslations` can re-queue it after a connection
  // recovery. A mounted row's retry tick releases its interest and re-asks on
  // the same key while the attempt it waits on is still in flight; releasing
  // drops the key from this memory, and the re-ask early-returns on the guards
  // below, so only re-remembering it here keeps the row re-queueable for the
  // whole attempt. Resolution removes it (`remember`) and the map is capped, so
  // failures cannot grow without bound.
  if (retryable.size >= MAX_RETRYABLE_ENTRIES && !retryable.has(key)) {
    const oldest = retryable.keys().next().value;
    if (oldest !== undefined) {
      retryable.delete(oldest);
    }
  }
  retryable.set(key, item);
  if (inFlight.has(key) || queued.has(key)) {
    return;
  }
  queue.push(item);
  queued.add(key);
  scheduleFlush();
}

/**
 * Records that one mounted surface stopped asking for a key's source text: the
 * hook effect's cleanup calls this when its row unmounts or its source text,
 * language or model changed. Once no surface asks for a part's text any more,
 * that text leaves the retry memory and the queue immediately, so a summary a
 * row showed before it unmounted neither stays re-sendable by
 * `retryUnresolvedTranslations` on a reconnect or deep link nor is dispatched
 * by a later flush. A text another surface still renders keeps its interest
 * and stays served.
 */
export function releaseTranslationInterest(input: {
  itemId: string;
  text: string;
  language: string;
  model: { id: string; name: string };
}): void {
  if (input.text.trim() === '') {
    return;
  }
  const key = translationKey(input.language, input.model.id, input.itemId, input.text);
  removeSurfaceInterest(key);
  if (surfaceInterest.has(key)) {
    // Another mounted surface still renders this text: it is not superseded.
    return;
  }
  // The last surface stopped showing this key. A failed attempt must not stay
  // in the retry memory, or a reconnect edge or deep link would re-send a
  // summary no row shows any more; a copy still waiting for a slot is dropped
  // from the queue for the same reason.
  retryable.delete(key);
  if (queued.delete(key)) {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index]?.key === key) {
        queue.splice(index, 1);
      }
    }
  }
}

/**
 * Re-queue every summary that was asked for but never resolved. The session
 * transport calls this when it reconnects: a batch that failed while the
 * gateway was unreachable left its items in `retryable`, and re-entering an
 * already-mounted transcript is a navigation no-op, so no remount would
 * re-request them and the rows would keep showing the source language.
 * Idempotent while a request is still in flight or already waiting: `takeBatch`
 * keeps keys another batch already owns queued, so they are requested once that
 * attempt settles unresolved, and drops them if it resolves them, while a key
 * the queue already holds is not stacked a second time. The opt-in lifecycle
 * needs no check here: `setConfig` clears this memory on any change, so what
 * remains was asked for under the current configuration.
 */
export function retryUnresolvedTranslations(): void {
  if (retryable.size === 0) {
    return;
  }
  for (const item of retryable.values()) {
    if (!queued.has(item.key)) {
      queue.push(item);
      queued.add(item.key);
    }
  }
  scheduleFlush();
}

/**
 * Drop every remembered-but-unresolved summary, the queue, the in-flight
 * bookkeeping and the in-memory cache when the authenticated account changes
 * (sign-out or a direct account switch). The retry memory and the cache
 * entries carry the previous account's tool text, and
 * `retryUnresolvedTranslations` runs from the retry mount on a deep link or a
 * connection recovery, so without this the signed-out account's summaries
 * would be sent to the gateway under the next account's token. The generation
 * bump discards a batch that is still in flight under the old account, and
 * the emitted version drops every mounted row back to its source text. The
 * reset epoch fences a hydration read that is still in flight too, so the
 * cleared cache stays cleared.
 */
export function clearToolSummaryTranslationMemory(): void {
  generation += 1;
  accountResetEpoch += 1;
  queue.length = 0;
  queued.clear();
  inFlight.clear();
  retryable.clear();
  cache.clear();
  surfaceInterest.clear();
  version += 1;
  emit();
}

/**
 * Resolves once every write dispatched before the sign-out reset has settled,
 * or after {@link TOOL_SUMMARY_TRANSLATION_SIGN_OUT_DRAIN_TIMEOUT_MS}. The
 * drain is best effort, so a write that never settles is abandoned rather than
 * allowed to hold sign-out teardown; the abandoned write is also forgotten, so
 * it cannot make a later sign-out wait the bound again. The scope clear that
 * follows still runs.
 * An abandoned write that settles late cannot recreate the cleared entry: the
 * store captures the auth epoch at dispatch and removes the entry again when
 * the epoch moved, so the durable scope stays empty. The in-memory cache was
 * already dropped by the reset, so a late store write never renders either.
 */
async function drainPendingPersists(): Promise<void> {
  if (pendingPersists.size === 0) {
    return;
  }
  let resolveTimeout: () => void = noopVoidResolution;
  const timeout = new Promise<'timeout'>(resolve => {
    resolveTimeout = () => {
      resolve('timeout');
    };
  });
  const timeoutId = setTimeout(resolveTimeout, TOOL_SUMMARY_TRANSLATION_SIGN_OUT_DRAIN_TIMEOUT_MS);
  try {
    const outcome = await Promise.race([
      // `allSettled` never rejects, so no write outcome can abort sign-out.
      Promise.allSettled(pendingPersists.keys()).then(() => 'settled' as const),
      timeout,
    ]);
    // A write the bound gave up on can hang forever, so drop the abandoned
    // writes here: the next sign-out must not see them as still pending and
    // re-pay the whole bound for work already written off.
    if (outcome === 'timeout') {
      pendingPersists.clear();
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Sign-out: reset the in-memory state and settle the store writes it already
 * dispatched, so the caller can drop the disk scope afterwards with as few
 * writes as possible left to land on it.
 *
 * The order is load-bearing. {@link clearToolSummaryTranslationMemory} bumps
 * the generation first, so a batch that resolves while the scope clear is in
 * flight is discarded by `runBatch` instead of remembered; the drain then
 * covers the writes dispatched before the bump, because a fire-and-forget
 * persist that started under the signed-out account must not reach the scope
 * after it was cleared. Resolves once no such write is outstanding, or once
 * the drain bound elapses.
 */
export async function clearToolSummaryTranslationMemoryForSignOut(): Promise<void> {
  clearToolSummaryTranslationMemory();
  await drainPendingPersists();
}
