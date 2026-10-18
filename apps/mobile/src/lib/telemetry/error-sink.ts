/**
 * Transport-neutral telemetry sink.
 *
 * The real Sentry adapter is installed later via {@link setTelemetrySink}; this
 * module must stay free of `@sentry/react-native` so node vitest suites can
 * import it (the RN SDK does not parse under vitest/rolldown). Every function
 * wraps its body: telemetry must never throw into app code.
 */

type TelemetryLevel = 'warning' | 'error';

export type TelemetryEvent = {
  error?: unknown;
  message?: string;
  level: TelemetryLevel;
  tags?: Record<string, string | number | boolean>;
  contexts?: Record<string, Record<string, unknown>>;
  extra?: Record<string, unknown>;
  fingerprint?: readonly string[];
};

/**
 * Property a domain error uses to declare its own telemetry. The React Query
 * reporters read it so a typed error is filed under its subsystem's stable
 * fingerprint, tags and level instead of the catch-all `app-error` one.
 */
export const TELEMETRY_DESCRIPTION_KEY = 'kiloTelemetry';

export type TelemetryDescription = {
  fingerprint: readonly string[];
  /** Defaults to `error`. An expected, recoverable outcome declares `warning`. */
  level?: TelemetryLevel;
  tags?: Record<string, string | number | boolean>;
  contexts?: Record<string, Record<string, unknown>>;
  extra?: Record<string, unknown>;
};

export type TelemetrySink = (event: TelemetryEvent) => void;

let sink: TelemetrySink | null = null;

/** Install the active sink, or detach with `null`. */
export function setTelemetrySink(next: TelemetrySink | null): void {
  sink = next;
}

/**
 * Route one event to the installed sink. No-op until a sink is installed, and
 * a throwing sink is swallowed so it can never break a caller.
 */
export function captureTelemetry(event: TelemetryEvent): void {
  const current = sink;
  if (current === null) {
    return;
  }
  try {
    current(event);
  } catch {
    // Telemetry must never throw into app code.
  }
}

/**
 * A diagnostic trail entry. It rides on the next captured event and is never
 * an event of its own: use it for an expected condition (a device without
 * network) that explains a later failure but is not a defect.
 */
export type TelemetryBreadcrumb = {
  category: string;
  message: string;
  level: TelemetryLevel;
  data?: Record<string, string | number | boolean>;
};

export type BreadcrumbSink = (breadcrumb: TelemetryBreadcrumb) => void;

let breadcrumbSink: BreadcrumbSink | null = null;

/** Install the active breadcrumb sink, or detach with `null`. */
export function setBreadcrumbSink(next: BreadcrumbSink | null): void {
  breadcrumbSink = next;
}

/**
 * Route one breadcrumb to the installed sink. No-op until a sink is
 * installed, and a throwing sink is swallowed so it can never break a caller.
 */
export function addTelemetryBreadcrumb(breadcrumb: TelemetryBreadcrumb): void {
  const current = breadcrumbSink;
  if (current === null) {
    return;
  }
  try {
    current(breadcrumb);
  } catch {
    // Telemetry must never throw into app code.
  }
}
