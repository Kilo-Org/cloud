// One-shot cold-start timing. Deltas are milliseconds from the FIRST
// `markStartup` call of any name (its own value is therefore always 0) — read
// them as "since the first bootstrap gate was observed", not "since auth" and
// not "since process start". Pre-JS native startup is not observable from JS;
// Sentry's app-start measurement covers that half.
//
// Deliberately imports nothing: anything imported here would evaluate before
// the origin is captured and its own cost would disappear from the numbers.

type StartupMark =
  | 'auth_ready'
  | 'fonts_ready'
  | 'theme_ready'
  | 'user_ready'
  | 'consent_ready'
  | 'splash_hidden';

// Why the splash hid — the startup path this launch actually took. Stable enum
// strings only, per the payload rules in src/lib/analytics/posthog.ts.
type StartupOutcome =
  | 'app'
  | 'login'
  | 'consent'
  | 'force-update'
  | 'user-error'
  | 'consent-error'
  | 'language-error';

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
export function takeStartupTimings(): Record<string, string | number> | null {
  if (taken || outcome === undefined) {
    return null;
  }
  taken = true;
  return { outcome, ...Object.fromEntries(marks) };
}
