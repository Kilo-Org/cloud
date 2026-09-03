import type * as SentryReactNative from '@sentry/react-native';
import { type GlanceableAgentsSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';
import { type LiveActivity } from 'expo-widgets';

/**
 * One sink consumes the glanceable snapshot for one native surface (persist,
 * iOS Live Activity/widgets, Android widget/ongoing). Platform sinks register
 * themselves from files their slices own; the layout mount registers only the
 * persist sink.
 */
export type GlanceableSinkContext = {
  /** For token registration only; must never enter the snapshot. */
  organizationId: string | null;
  /** For token registration only; must never enter the snapshot. `null` in
   * the headless background apply when the active-user hint is unavailable. */
  userId: string | null;
};

export type GlanceableSink = {
  publish(snapshot: GlanceableAgentsSnapshot): void;
  /** Owns native terminal dismissal; await submission, never schedule a later JS end. */
  waitForNativeTerminal?(): Promise<void>;
  endImmediate(): void;
  startOrUpdate(snapshot: GlanceableAgentsSnapshot, ctx: GlanceableSinkContext): void;
};

const sinks = new Set<GlanceableSink>();

export function registerGlanceableSink(sink: GlanceableSink): void {
  sinks.add(sink);
}

export function unregisterGlanceableSink(sink: GlanceableSink): void {
  sinks.delete(sink);
}

export function getGlanceableSinks(): readonly GlanceableSink[] {
  return [...sinks];
}

function reportSinkFailure(operation: string, error: unknown): void {
  try {
    // Lazy require keeps @sentry/react-native out of the pure test graph, the
    // same reason the Android permission reader defers its import.
    // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load
    const Sentry = require('@sentry/react-native') as typeof SentryReactNative;
    Sentry.captureException(error, {
      tags: { 'error.subsystem': 'glanceable', 'error.operation': operation },
    });
  } catch {
    // Reporting is best effort; a missing reporter must not mask the guard.
  }
}

/**
 * Run one sink operation and swallow its failure. A native surface must never
 * throw into the auth transition, the org switch, or the in-app publisher: a
 * throwing WidgetKit or ActivityKit host function there would abort a sign-in
 * or kill the publisher effect. The background push path deliberately does NOT
 * use this — a native failure must reject so the OS retries the push.
 */
export function guardSink(operation: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    reportSinkFailure(operation, error);
  }
}

/** `guardSink` for every registered sink. One sink's failure never skips the rest. */
export function forEachSink(operation: string, run: (sink: GlanceableSink) => void): void {
  // Snapshot the list: a sink may register or unregister from inside `run`.
  const registered = [...sinks];
  for (const sink of registered) {
    guardSink(operation, () => {
      run(sink);
    });
  }
}

/**
 * Activity-token registrar, set by a later token slice. No-op by default.
 * `unregisterTokens` reports only the tokens whose unregister failed, so
 * logout can tombstone the failed tokens and retry them later.
 */
export type GlanceableActivity = Pick<LiveActivity, 'getPushToken' | 'addPushTokenListener'>;

export type GlanceableDelivery = {
  registerScopeTokens(organizationId: string | null, userId: string | null): void;
  registerTokens(
    snapshot: GlanceableAgentsSnapshot,
    organizationId: string | null,
    userId: string | null,
    activity?: GlanceableActivity
  ): void;
  /** Retire a lifetime and tombstone failures. The optional lookup starts before native end. */
  cleanupTokens(lifetime: 'scope' | 'activity', activityToken?: Promise<string | null>): void;
  unregisterTokens(
    lifetime?: 'scope' | 'activity',
    activityToken?: Promise<string | null>
  ): Promise<{ ok: boolean; tokens: string[] }>;
};

const noopDelivery: GlanceableDelivery = {
  registerScopeTokens() {
    // No-op until a token slice registers a delivery.
  },
  registerTokens() {
    // No-op until a token slice registers a delivery.
  },
  cleanupTokens() {
    // No-op until a token slice registers a delivery.
  },
  async unregisterTokens() {
    // No-op until a token slice registers a delivery.
    await Promise.resolve();
    return { ok: true, tokens: [] };
  },
};

let delivery: GlanceableDelivery = noopDelivery;

export function setGlanceableDelivery(next: GlanceableDelivery): void {
  delivery = next;
}

export function getGlanceableDelivery(): GlanceableDelivery {
  return delivery;
}
