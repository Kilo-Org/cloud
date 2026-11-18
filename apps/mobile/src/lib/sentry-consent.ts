import * as Sentry from '@sentry/react-native';

// Performance tracing (TTID/TTFD, app start), JS profiling, session replay,
// and error screenshots must not run before the user accepts consent. With
// optional consent accepted, replay and screenshots are captured MASKED
// (maskAllText/maskAllImages in _layout.tsx; DEC-02 amendment, owner decision
// 2026-08-17, disclosed in consent-details.tsx). View-hierarchy capture is
// never enabled.
// This is the pure decision function; src/app/_layout.tsx re-inits Sentry
// with these options (via reinitSentryForConsent below) whenever the stored
// consent state changes.
//
// Per-launch startup timing therefore comes from the PostHog `app_startup`
// event in src/lib/startup-timing.ts, not from Sentry traces.
type SentryConsentOptions = {
  readonly replaysSessionSampleRate: number;
  readonly replaysOnErrorSampleRate: number;
  readonly tracesSampleRate: number;
  readonly profilesSampleRate: number;
  readonly attachScreenshot: boolean;
  readonly attachViewHierarchy: boolean;
};

// Profile sampling applies on top of `tracesSampleRate: 0.1`, so 1% of all
// transactions produce a profile (~1/10 of trace volume); the SDK caps a
// profile at 30 s and attaches it only to a sampled transaction. 1.0 would
// profile every sampled transaction (10% of all), and each long agent-chat
// profile costs a large envelope, for no diagnostic gain. 0.1 covers the
// KILO-APP-51 cohort (10 users on /agent-chat) with several profiles within
// days.
const PROFILES_SAMPLE_RATE = 0.1;

export function sentryOptionsForConsent(optionalConsented: boolean): SentryConsentOptions {
  if (!optionalConsented) {
    return {
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      tracesSampleRate: 0,
      profilesSampleRate: 0,
      attachScreenshot: false,
      attachViewHierarchy: false,
    };
  }

  return {
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1,
    tracesSampleRate: 0.1,
    profilesSampleRate: PROFILES_SAMPLE_RATE,
    attachScreenshot: true,
    attachViewHierarchy: false,
  };
}

// @sentry/react-native reads tracing options only at init time; there is
// no runtime toggle for tracesSampleRate. When consent changes, a fresh
// Sentry.init() with the new options is the only way to apply them — the RN
// SDK re-runs initNativeSdk with the new options on every init, so native
// re-init is the supported path.
//
// Sentry.close() is NOT: it calls NATIVE.closeNativeSdk(), which latches the
// JS native wrapper off (`enableNative=false`) until the NEXT client's async
// native re-init settles, and the consented branch's Hermes profiler touches
// the wrapper synchronously during Sentry.init() — a close-then-init consent
// transition threw "Native is disabled" and left the app on the fail-closed
// declined client (b911 device rounds, 2026-09-07).
//
// Draining the outgoing client before the swap is NOT either — not with
// `Sentry.flush()` (no timeout) and not with a bounded `client.flush(ms)`:
// @sentry/core bounds that call with `ms` one-millisecond EVENT-LOOP TICKS,
// not wall-clock time, and a live consented client never quiets (mobile
// replay segments and the profiler keep `_numProcessing` above 0, so the
// poll runs every tick). The awaited "2 s" drain measured over 14 minutes on
// the device while the consented client — still the CURRENT client, because
// the swap sat behind the drain — kept tracing, profiling and emitting
// envelopes after the switch went to 0, and every later consent transition
// queued behind the hung chain forever (b911 vr3 device repro, 2026-09-08).
// The consent
// transition must not await the outgoing client's transport at all:
// `Sentry.init` swaps the current client synchronously, and the swap alone
// stops all NEW optional sampling because tracing reads the live client.
//
// So the transition is: swap, then silence the outgoing client by hand. Its
// session flusher and queued captures keep running on their own timers
// otherwise — exactly what a revoked consent has to stop — and its queued
// JS-side payloads are dropped, which is the privacy-correct outcome on a
// revoke (envelopes already handed to the native SDK persist and send
// independently). The chain is serialised through `lifecycle` so a fast
// accept → revoke cannot interleave two inits. Each transition catches its
// own failure, so the chain never rejects and cannot poison later ones.
// Failures surface through the caller's `onFailure`.
let lifecycle: Promise<void> | undefined = undefined;

export async function reinitSentryForConsent(
  consented: boolean,
  init: (optionalConsented: boolean) => void,
  onFailure?: () => void
): Promise<void> {
  const previous = lifecycle;
  lifecycle = (async () => {
    await previous;
    const outgoing = Sentry.getClient();
    try {
      // Swap FIRST: the new client becomes current synchronously, so no new
      // optional work is sampled on the outgoing client from here on.
      init(consented);
    } catch {
      // The consented init threw (e.g. "Native is disabled"): fall back to
      // the fail-closed declined client. Never poison the chain.
      try {
        init(false);
      } catch {
        // init(false) failed — still report failure and keep chain alive
      }
      onFailure?.();
    }
    // Silence the outgoing client only when the swap actually landed. If
    // both the consented init and the fail-closed init(false) threw, the
    // outgoing client is still the only live one and must keep mandatory
    // crash reporting running.
    if (outgoing && outgoing !== Sentry.getClient()) {
      try {
        const options = outgoing.getOptions();
        // `enabled=false` gates every send path: `_isEnabled()` gates
        // `sendEnvelope` and the `beforeEnvelope` emit.
        options.enabled = false;
        // Zero the rates too: root-span sampling reads the live options at
        // span start (core's _startRootSpan -> sampleSpan), so zeroing here
        // stops the dead client from sampling NEW transactions and running
        // the Hermes profiler on them — it keeps burning CPU building
        // envelopes that can never send otherwise. (Replay rates are not on
        // ClientOptions; the enabled gate drops their envelopes.)
        options.tracesSampleRate = 0;
        // `profilesSampleRate` lives on the RN init options, not on core's
        // `ClientOptions`; the runtime object IS the one handed to
        // `Sentry.init()`, so narrowing to the RN type reflects the shape
        // the profiler integration reads at span start.
        (options as Sentry.ReactNativeOptions).profilesSampleRate = 0;
      } catch {
        // Options shape is ours; never poison the chain for a teardown step.
      }
    }
  })();
  await lifecycle;
}
