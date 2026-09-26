import { onlineManager } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import {
  ensureTranslation,
  getConfig,
  getTranslation,
  releaseTranslationInterest,
  retryUnresolvedTranslations,
  subscribe,
} from './tool-summary-translation-runtime';

/** A tool summary as a row shows it, and whether its translation is still on its way. */
export type ToolSummaryTranslation = {
  text: string;
  pending: boolean;
};

/**
 * The first wait before an unresolved summary is asked for again, and the delay
 * the shared retry returns to on the reconnection edge. Every client failure (no
 * token, non-2xx, timeout, malformed body) resolves to `null` and caches
 * nothing, so a request that settled without a translation would otherwise
 * leave `pending` true for the rest of the mount: a condensed label would keep
 * its count alone and never show the last summary again, and a plain row would
 * keep the original text. The retry is shared by every mounted unresolved row
 * (one timer, not one per row), so `ensureTranslation`'s de-duplication keeps
 * the gateway work to one request per cadence per distinct summary.
 */
export const TOOL_SUMMARY_TRANSLATION_RETRY_MS = 10_000;

/**
 * The longest the shared retry wait may grow to. The wait doubles after every
 * replay, from the 10 s base to this cap, so a gateway that stays down costs a
 * handful of attempts instead of one every ten seconds for the life of the
 * mount.
 */
const TRANSLATION_RETRY_BACKOFF_CAP_MS = 300_000;

/**
 * One shared, backed-off scheduler for every mounted row whose summary is still
 * unresolved. A per-row interval woke the JS thread once per failed row and kept
 * issuing gateway calls while offline; this module arms a single timer for all
 * of them, backs the wait off after every replay, and never wakes while
 * `onlineManager` reports offline. `onlineManager` is already the app's single
 * online source of truth (NetInfo drives `onlineManager.setOnline` in
 * `query-client-lifecycle.tsx`), so no new dependency or platform branch is
 * needed. When the last row disarms, the timer is cleared and the wait resets,
 * so nothing outlives the account: the transcript unmounting on sign-out clears
 * the timer, and the runtime's own memory clear drops the pending work.
 */
let retrySubscribers = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined = undefined;
let retryDelayMs = TOOL_SUMMARY_TRANSLATION_RETRY_MS;
let onlineListenerInstalled = false;

function clearRetryTimer(): void {
  if (retryTimer !== undefined) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
}

/**
 * Arm the one shared timer when a row is subscribed and the device is online.
 * The tick clears its handle, returns without replaying when there is nothing
 * to serve or the device went offline (the online edge below re-arms), and
 * otherwise replays the unresolved keys once, doubles the wait up to the cap and
 * arms again.
 */
function armRetryTimer(): void {
  if (retrySubscribers === 0 || retryTimer !== undefined || !onlineManager.isOnline()) {
    return;
  }
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    if (retrySubscribers === 0 || !onlineManager.isOnline()) {
      return;
    }
    retryUnresolvedTranslations();
    retryDelayMs = Math.min(retryDelayMs * 2, TRANSLATION_RETRY_BACKOFF_CAP_MS);
    armRetryTimer();
  }, retryDelayMs);
}

/**
 * Register one mounted unresolved row with the shared retry and return the
 * closure that deregisters it. The first row installs the single online
 * listener; the reconnect edge resets the wait to the base delay and re-arms,
 * so the first replay after coming back online happens at the base cadence
 * rather than the backed-off one. The armed handle is cleared first: a
 * reconnect inside an already-armed long backed-off wait must replace it, or
 * `armRetryTimer`'s early return would leave the stale wait standing. The last
 * disarmed row clears the timer and resets the delay, so a later mount starts
 * from the base again.
 */
function armTranslationRetry(): () => void {
  retrySubscribers += 1;
  if (!onlineListenerInstalled) {
    onlineListenerInstalled = true;
    onlineManager.subscribe(online => {
      if (online && retrySubscribers > 0) {
        retryDelayMs = TOOL_SUMMARY_TRANSLATION_RETRY_MS;
        clearRetryTimer();
        armRetryTimer();
      }
    });
  }
  armRetryTimer();
  return () => {
    retrySubscribers -= 1;
    if (retrySubscribers === 0) {
      clearRetryTimer();
      retryDelayMs = TOOL_SUMMARY_TRANSLATION_RETRY_MS;
    }
  };
}

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
 * holds no translation for it, but the row joins the shared retry while it stays
 * mounted: a request that failed (or timed out) leaves the runtime uncached, so
 * the row retries it rather than reporting the missing summary as final. A row
 * that embeds the summary in a sentence of its own (`CondensedToolRunRow`) has
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
    // stays mounted it joins the one shared, backed-off retry, so a transient
    // gateway failure resolves once the gateway recovers instead of stranding
    // the label for the session. The row keeps its runtime interest while it
    // waits, so the shared scheduler replays exactly the mounted unresolved keys
    // in one batch, and the runtime still drops each replay while the key is
    // cached, in flight or already queued, so no replay stacks a second copy of
    // the same summary. The shared timer never wakes while the device is
    // offline, and it stops as soon as the translation lands (this cleanup
    // disarms it) or the last mounted row unmounts.
    const disarm = armTranslationRetry();
    return () => {
      disarm();
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
