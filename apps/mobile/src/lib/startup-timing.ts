// One-shot cold-start timing. Deltas are milliseconds from the FIRST
// `markStartup` call of any name (its own value is therefore always 0) — read
// them as "since the first bootstrap gate was observed", not "since auth" and
// not "since process start". Pre-JS native startup is not observable from JS;
// Sentry's app-start measurement covers that half.
//
// Imports nothing at runtime; its types come from a type-only import that is
// erased, so nothing here evaluates before the origin is captured and no
// import cost disappears from the numbers.

import { type AnalyticsEventMap, type StartupOutcome } from '@kilocode/app-shared/analytics';

type StartupMark =
  | 'auth_ready'
  | 'fonts_ready'
  | 'theme_ready'
  | 'user_ready'
  | 'consent_ready'
  | 'splash_hidden';

// The payload type the producer must return. The literal map key is required
// here because the producer must return exactly the cataloged payload type.
type StartupTimingsPayload = AnalyticsEventMap['app_startup'];

let origin: number | undefined = undefined;
const marks = new Map<StartupMark, number>();
let outcome: StartupOutcome | undefined = undefined;
let taken = false;

// Listeners notified exactly once when startup completes. Set iteration is
// deletion-safe: a listener may unsubscribe itself from inside its callback.
const completionListeners = new Set<() => void>();

// First mark wins for a given name: these are gate transitions, and the
// effect that records them re-runs on every later gate change.
export function markStartup(mark: StartupMark): void {
  origin ??= Date.now();
  if (!marks.has(mark)) {
    marks.set(mark, Date.now() - origin);
  }
}

// The first splash hide ends startup; later navigations are not startup.
export function markStartupComplete(value: StartupOutcome): void {
  if (outcome === undefined) {
    outcome = value;
    markStartup('splash_hidden');
    for (const listener of completionListeners) {
      listener();
    }
  }
}

// Registers a listener fired exactly once on the first `markStartupComplete`.
export function subscribeStartupComplete(listener: () => void): () => void {
  completionListeners.add(listener);
  return () => {
    completionListeners.delete(listener);
  };
}

export function isStartupComplete(): boolean {
  return outcome !== undefined;
}

// Returns the event payload exactly once per launch, and only after startup
// actually finished. Null means "nothing to send" — never send a partial
// launch, and never send twice. Callers may poll this freely.
export function takeStartupTimings(): StartupTimingsPayload | null {
  if (taken || outcome === undefined) {
    return null;
  }
  taken = true;
  // Writes each mark to its named optional field instead of spreading a
  // `Map` widening to `Record<string, number>`; only `StartupMark` keys exist.
  const payload: StartupTimingsPayload = { outcome };
  for (const [mark, delta] of marks) {
    payload[mark] = delta;
  }
  return payload;
}
