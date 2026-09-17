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
