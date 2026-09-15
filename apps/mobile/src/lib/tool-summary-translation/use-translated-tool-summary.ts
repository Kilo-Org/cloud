import { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import {
  ensureTranslation,
  getConfig,
  getTranslation,
  subscribe,
} from './tool-summary-translation-runtime';

/** A tool summary as a row shows it, and whether its translation is still on its way. */
export type ToolSummaryTranslation = {
  text: string;
  pending: boolean;
};

/**
 * The translation for a tool summary and whether it is still on its way. The
 * subscription also carries the preference that decides whether to translate at
 * all.
 *
 * Both the config and the cache read go through `useSyncExternalStore` rather
 * than plain render expressions. With React Compiler enabled
 * (`reactCompiler: true`) a plain `getTranslation(...)` call is memoized on its
 * arguments, so a row mounted before the request resolved kept the original
 * English even though the runtime emitted the translation; only a remount showed
 * it. Reading the cache as the store snapshot makes the resolved translation a
 * reactive value, so the row re-renders when it lands. `FixedPartRow` is
 * single-line, so the swap cannot shift layout.
 *
 * `pending` is true only while translation is on for this text and the runtime
 * holds no translation for it: a row that embeds the summary in a sentence of
 * its own (`CondensedToolRunRow`) has nowhere to put the original English while
 * it waits, so it reads this flag instead of the fallback text.
 */
export function useToolSummaryTranslation(text: string, enabled = true): ToolSummaryTranslation {
  const { i18n } = useTranslation();
  const language = i18n.language;
  const config = useSyncExternalStore(subscribe, getConfig, getConfig);
  const active = enabled && config.enabled && text !== '';
  const getSnapshot = (): string | undefined =>
    active ? getTranslation(text, language, config.model.id) : undefined;
  const translated = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (active) {
      ensureTranslation({ text, language, model: config.model });
    }
  }, [active, text, language, config.model]);

  return { text: translated ?? text, pending: active && translated === undefined };
}

/**
 * The translation for a tool summary, falling back to the original text until
 * it resolves. A single-line row with no other copy swaps the text in place,
 * so it never needs the pending state `useToolSummaryTranslation` carries.
 */
export function useTranslatedToolSummary(text: string, enabled = true): string {
  return useToolSummaryTranslation(text, enabled).text;
}
