import { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import {
  ensureTranslation,
  getConfig,
  getTranslation,
  subscribe,
} from './tool-summary-translation-runtime';

/**
 * The translation for a tool summary, falling back to the original text until
 * it resolves. The subscription also carries the preference that decides
 * whether to translate at all.
 *
 * Both the config and the cache read go through `useSyncExternalStore` rather
 * than plain render expressions. With React Compiler enabled
 * (`reactCompiler: true`) a plain `getTranslation(...)` call is memoized on its
 * arguments, so a row mounted before the request resolved kept the original
 * English even though the runtime emitted the translation; only a remount showed
 * it. Reading the cache as the store snapshot makes the resolved translation a
 * reactive value, so the row re-renders when it lands. `FixedPartRow` is
 * single-line, so the swap cannot shift layout.
 */
export function useTranslatedToolSummary(text: string, enabled = true): string {
  const { i18n } = useTranslation();
  const language = i18n.language;
  const config = useSyncExternalStore(subscribe, getConfig, getConfig);
  const active = enabled && config.enabled && text !== '';
  const getSnapshot = (): string =>
    active ? (getTranslation(text, language, config.model.id) ?? text) : text;
  const shown = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (active) {
      ensureTranslation({ text, language, model: config.model });
    }
  }, [active, text, language, config.model]);

  return shown;
}
