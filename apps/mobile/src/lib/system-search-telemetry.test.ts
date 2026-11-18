import { beforeEach, describe, expect, it, vi } from 'vitest';

const telemetryMock = vi.hoisted(() => ({
  captureTelemetry: vi.fn(),
}));

vi.mock('@/lib/telemetry/error-sink', () => telemetryMock);

/* eslint-disable import/first */
// vi.mock is hoisted by Vitest before the real import resolves.
import { reportSystemSearchFailure } from './system-search-telemetry';
/* eslint-enable import/first */

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

beforeEach(() => {
  telemetryMock.captureTelemetry.mockReset();
});

describe('reportSystemSearchFailure', () => {
  it('does not report an iOS index timeout', () => {
    // CoreSpotlight did not call its completion handler within the bound.
    const timeout = codedError(
      'ERR_SYSTEM_SEARCH_TIMEOUT: The system search index did not respond.',
      'ERR_SYSTEM_SEARCH_TIMEOUT'
    );

    reportSystemSearchFailure('clear', timeout);

    expect(telemetryMock.captureTelemetry).not.toHaveBeenCalled();
  });

  it('does not report an Android index timeout wrapped as a rejected call', () => {
    // Expo wraps the AppSearch timeout and keeps the code of its cause.
    const timeout = codedError(
      "Call to function 'KiloSystemSearch.indexedFingerprints' has been rejected.\n→ Caused by: The system search index did not respond.",
      'ERR_SYSTEM_SEARCH_TIMEOUT'
    );

    reportSystemSearchFailure('sync', timeout);

    expect(telemetryMock.captureTelemetry).not.toHaveBeenCalled();
  });

  it('reports any other rejection with the operation tag', () => {
    const failure = codedError(
      "Call to function 'KiloSystemSearch.applyUpdate' has been rejected.\n→ Caused by: The system search index rejected a document.",
      'ERR_CODED'
    );

    reportSystemSearchFailure('sync', failure);

    expect(telemetryMock.captureTelemetry).toHaveBeenCalledExactlyOnceWith({
      error: failure,
      level: 'warning',
      tags: { 'error.subsystem': 'system-search', 'error.operation': 'sync' },
    });
  });

  it('reports a rejection that carries no code', () => {
    const failure = new Error('The system search index did not respond.');

    reportSystemSearchFailure('clear', failure);

    expect(telemetryMock.captureTelemetry).toHaveBeenCalledExactlyOnceWith({
      error: failure,
      level: 'warning',
      tags: { 'error.subsystem': 'system-search', 'error.operation': 'clear' },
    });
  });
});
