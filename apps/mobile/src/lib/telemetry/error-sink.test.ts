import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addTelemetryBreadcrumb,
  captureTelemetry,
  setBreadcrumbSink,
  setTelemetrySink,
  type TelemetryBreadcrumb,
  type TelemetryEvent,
} from '@/lib/telemetry/error-sink';

afterEach(() => {
  setTelemetrySink(null);
  setBreadcrumbSink(null);
});

describe('captureTelemetry', () => {
  it('is a no-op before any sink is installed', () => {
    expect(() => {
      captureTelemetry({ level: 'error', message: 'before install' });
    }).not.toThrow();
  });

  it('routes the event to the installed sink', () => {
    const sink = vi.fn<(event: TelemetryEvent) => void>();
    const event: TelemetryEvent = {
      level: 'warning',
      message: 'network down',
      tags: { 'error.subsystem': 'network' },
      contexts: { network: { outcome: 'failed' } },
      fingerprint: ['network-error', 'fetch'],
    };

    setTelemetrySink(sink);
    captureTelemetry(event);

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(event);
  });

  it('does not propagate a throwing sink', () => {
    setTelemetrySink(() => {
      throw new Error('sink exploded');
    });

    expect(() => {
      captureTelemetry({ level: 'error', message: 'boom' });
    }).not.toThrow();
  });

  it('detaches on setTelemetrySink(null)', () => {
    const sink = vi.fn<(event: TelemetryEvent) => void>();
    setTelemetrySink(sink);
    captureTelemetry({ level: 'warning', message: 'one' });
    expect(sink).toHaveBeenCalledTimes(1);

    setTelemetrySink(null);
    captureTelemetry({ level: 'warning', message: 'two' });
    expect(sink).toHaveBeenCalledTimes(1);
  });
});

describe('addTelemetryBreadcrumb', () => {
  const breadcrumb: TelemetryBreadcrumb = {
    category: 'network',
    level: 'warning',
    message: 'GET /health failed',
    data: { outcome: 'failed' },
  };

  it('is a no-op before any sink is installed', () => {
    expect(() => {
      addTelemetryBreadcrumb(breadcrumb);
    }).not.toThrow();
  });

  it('routes the breadcrumb to the breadcrumb sink and never to the event sink', () => {
    const eventSink = vi.fn<(event: TelemetryEvent) => void>();
    const breadcrumbSink = vi.fn<(value: TelemetryBreadcrumb) => void>();
    setTelemetrySink(eventSink);
    setBreadcrumbSink(breadcrumbSink);

    addTelemetryBreadcrumb(breadcrumb);

    expect(breadcrumbSink).toHaveBeenCalledTimes(1);
    expect(breadcrumbSink).toHaveBeenCalledWith(breadcrumb);
    expect(eventSink).not.toHaveBeenCalled();
  });

  it('does not propagate a throwing sink', () => {
    setBreadcrumbSink(() => {
      throw new Error('sink exploded');
    });

    expect(() => {
      addTelemetryBreadcrumb(breadcrumb);
    }).not.toThrow();
  });
});
