import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  captureTelemetry,
  setTelemetrySink,
  type TelemetryEvent,
} from '@/lib/telemetry/error-sink';

afterEach(() => {
  setTelemetrySink(null);
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
