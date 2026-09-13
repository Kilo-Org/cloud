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
};

const CACHE_CAP = 500;
const MAX_CONCURRENT = 4;

let config: ToolSummaryTranslationConfig = {
  enabled: false,
  model: DEFAULT_TOOL_SUMMARY_TRANSLATION_MODEL,
};
// Insertion order is oldest-first, so eviction is `keys().next()`.
const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<void>>();
const queue: QueueItem[] = [];
let active = 0;
let version = 0;
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

/** Fallback contract: nothing thrown here may reach a transcript row. */
async function run(item: QueueItem): Promise<void> {
  try {
    const { requestToolSummaryTranslation } = await import('./tool-summary-translation-client');
    const translated = await requestToolSummaryTranslation({
      text: item.text,
      targetLanguage: item.language,
      model: item.model.id,
    });
    if (translated !== null) {
      remember(item.key, translated);
    }
  } catch {
    // Leave it uncached; the original summary stays visible (layout is fixed).
  } finally {
    active -= 1;
    inFlight.delete(item.key);
    pump();
  }
}

function pump(): void {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) {
      return;
    }
    const isDuplicate = cache.has(item.key) || inFlight.has(item.key);
    if (!isDuplicate) {
      active += 1;
      const promise = run(item);
      inFlight.set(item.key, promise);
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
  queue.push({ key, text, language, model });
  pump();
}
