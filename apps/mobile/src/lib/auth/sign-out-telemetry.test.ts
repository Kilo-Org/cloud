import { afterEach, describe, expect, it, vi } from 'vitest';

import { reportAuthBranch } from '@/lib/auth/sign-out-telemetry';
import { setTelemetrySink, type TelemetryEvent } from '@/lib/telemetry/error-sink';

afterEach(() => {
  setTelemetrySink(null);
});

describe('reportAuthBranch', () => {
  it('emits exactly one warning event with the cause, branch, and key-name tags', () => {
    const sink = vi.fn<(event: TelemetryEvent) => void>();
    setTelemetrySink(sink);

    reportAuthBranch({
      cause: 'credentials_unreadable',
      branch: 'refresh_token_unreadable',
      keyNames: ['auth-token', 'auth-token-expires-at'],
    });

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith({
      level: 'warning',
      message: 'auth branch',
      tags: {
        'auth.cause': 'credentials_unreadable',
        'auth.branch': 'refresh_token_unreadable',
        'auth.keys': 'auth-token,auth-token-expires-at',
      },
    });
  });

  it('omits the key-names tag when no key names are reported', () => {
    const sink = vi.fn<(event: TelemetryEvent) => void>();
    setTelemetrySink(sink);

    reportAuthBranch({ cause: 'session_ended', branch: 'refresh_401' });

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith({
      level: 'warning',
      message: 'auth branch',
      tags: { 'auth.cause': 'session_ended', 'auth.branch': 'refresh_401' },
    });
  });

  it('never throws into the caller when no sink is installed', () => {
    expect(() => {
      reportAuthBranch({ cause: 'user', branch: 'explicit' });
    }).not.toThrow();
  });
});
