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
