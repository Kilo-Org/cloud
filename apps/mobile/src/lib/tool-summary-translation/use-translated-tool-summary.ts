import { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import {
  ensureTranslation,
  getConfig,
  getTranslation,
  releaseTranslationInterest,
  subscribe,
} from './tool-summary-translation-runtime';

/** A tool summary as a row shows it, and whether its translation is still on its way. */
export type ToolSummaryTranslation = {
  text: string;
  pending: boolean;
};

/**
 * How long an unresolved row waits before it asks the gateway again. Every
 * client failure (no token, non-2xx, timeout, malformed body) resolves to
 * `null` and caches nothing, so a request that settled without a translation
 * would otherwise leave `pending` true for the rest of the mount: a condensed
 * label would keep its count alone and never show the last summary again, and a
 * plain row would keep the original text. The retry belongs to the mounted row,
 * so it stops when the translation lands (`translated` clears the timer) or the
 * row unmounts, and `ensureTranslation` drops each tick while a request is in
 * flight, a request is already queued behind the concurrency limit, or the
 * translation is already cached, so rows sharing a summary ask the gateway once
 * per cadence.
 */
export const TOOL_SUMMARY_TRANSLATION_RETRY_MS = 10_000;

/**
 * The translation for a tool summary and whether it is still on its way. The
 * subscription also carries the preference that decides whether to translate at
 * all.
 *
 * Translation is keyed by the part's persistent `itemId` plus the source text,
 * so two tool calls with the same text never share an entry and a changed
 * source gets its own entry instead of evicting the string another surface
 * still shows. A caller with no part of its own — the summary embedded in
 * `CondensedToolRunRow`'s assembled label — passes no `itemId`, so its key is
 * the source text alone, which is all that row has to identify itself.
 *
 * The effect pairs with the runtime's supersede prune: while it runs, the
 * surface counts as asking for its text, and its cleanup releases that
 * interest. So when a part's text streams on, the settled effect's cleanup has
 * already released the streaming text before the settled text is ensured, and
 * the runtime drops the superseded copy — while a second surface still showing
 * the old string (the detail sheet beside the row) keeps its interest and stays
 * served.
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
 * holds no translation for it, but the row keeps asking while it stays mounted:
 * a request that failed (or timed out) leaves the runtime uncached, so the row
 * retries it rather than reporting the missing summary as final. A row that
 * embeds the summary in a sentence of its own (`CondensedToolRunRow`) has
 * nowhere to put the original English while it waits, so it reads this flag
 * instead of the fallback text.
 */
export function useToolSummaryTranslation(
  text: string,
  enabled = true,
  itemId?: string
): ToolSummaryTranslation {
  const { i18n } = useTranslation();
  const language = i18n.language;
  const config = useSyncExternalStore(subscribe, getConfig, getConfig);
  const active = enabled && config.enabled && text !== '';
  const getSnapshot = (): string | undefined =>
    active ? getTranslation(itemId ?? '', text, language, config.model.id) : undefined;
  const translated = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const model = config.model;
    const id = itemId ?? '';
    ensureTranslation({ itemId: id, text, language, model });
    const release = () => {
      releaseTranslationInterest({ itemId: id, text, language, model });
    };
    if (translated !== undefined) {
      return release;
    }
    // A request that settled without a translation is not final: while the row
    // stays mounted it asks again, so a transient gateway failure resolves once
    // the gateway recovers instead of stranding the label for the session. The
    // runtime drops each tick while the key is cached, in flight or already
    // queued, so the tick never stacks a second copy of the same summary. The
    // tick releases its interest first because it is the same surface re-asking,
    // not a second one, so the runtime's presence count stays at one per mounted
    // surface instead of growing with every tick.
    const retry = setInterval(() => {
      releaseTranslationInterest({ itemId: id, text, language, model });
      ensureTranslation({ itemId: id, text, language, model });
    }, TOOL_SUMMARY_TRANSLATION_RETRY_MS);
    return () => {
      clearInterval(retry);
      release();
    };
  }, [active, itemId, text, language, config.model, translated]);

  return { text: translated ?? text, pending: active && translated === undefined };
}

/**
 * The translation for a tool summary, falling back to the original text until
 * it resolves. A single-line row with no other copy swaps the text in place,
 * so it never needs the pending state `useToolSummaryTranslation` carries.
 *
 * A row without a persistent part id is never translated: every unkeyed call
 * with the same text would share one entry, so two tool calls with equal
 * summaries could never keep their own translation. The pending variant is for
 * the summary embedded in an assembled label, which has no part of its own.
 */
export function useTranslatedToolSummary(text: string, enabled = true, itemId?: string): string {
  return useToolSummaryTranslation(text, enabled && itemId !== undefined, itemId).text;
}
