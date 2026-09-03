import { type GlanceableAgentsSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';

/**
 * One sink consumes the glanceable snapshot for one native surface (persist,
 * iOS Live Activity/widgets, Android widget/ongoing). Platform sinks register
 * themselves from files their slices own; the layout mount registers only the
 * persist sink.
 */
export type GlanceableSinkContext = {
  /** For token registration only; must never enter the snapshot. */
  organizationId: string | null;
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

/** Activity-token registrar, set by a later token slice. No-op by default. */
export type GlanceableDelivery = {
  registerTokens(snapshot: GlanceableAgentsSnapshot, organizationId: string | null): void;
  unregisterTokens(): void;
};

const noopDelivery: GlanceableDelivery = {
  registerTokens() {
    // No-op until a token slice registers a delivery.
  },
  unregisterTokens() {
    // No-op until a token slice registers a delivery.
  },
};

let delivery: GlanceableDelivery = noopDelivery;

export function setGlanceableDelivery(next: GlanceableDelivery): void {
  delivery = next;
}

export function getGlanceableDelivery(): GlanceableDelivery {
  return delivery;
}
