import { afterEach, describe, expect, it, vi } from 'vitest';

import { reportAuthBranch } from '@/lib/auth/sign-out-telemetry';
import {
  setBreadcrumbSink,
  setTelemetrySink,
  type TelemetryBreadcrumb,
  type TelemetryEvent,
} from '@/lib/telemetry/error-sink';

afterEach(() => {
  setTelemetrySink(null);
  setBreadcrumbSink(null);
});

function installSinks() {
  const events = vi.fn<(event: TelemetryEvent) => void>();
  const breadcrumbs = vi.fn<(breadcrumb: TelemetryBreadcrumb) => void>();
  setTelemetrySink(events);
  setBreadcrumbSink(breadcrumbs);
  return { events, breadcrumbs };
}

describe('reportAuthBranch', () => {
  it('files an unreadable credential read under its cause and branch', () => {
    const { events, breadcrumbs } = installSinks();

    reportAuthBranch({
      cause: 'credentials_unreadable',
      branch: 'refresh_token_unreadable',
      keyNames: ['auth-token', 'auth-token-expires-at'],
    });

    expect(events).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledWith({
      level: 'warning',
      error: new Error('Auth branch: credentials_unreadable (refresh_token_unreadable)'),
      tags: {
        'auth.cause': 'credentials_unreadable',
        'auth.branch': 'refresh_token_unreadable',
        'auth.keys': 'auth-token,auth-token-expires-at',
      },
      fingerprint: ['auth-branch', 'credentials_unreadable', 'refresh_token_unreadable'],
    });
    expect(breadcrumbs).not.toHaveBeenCalled();
  });

  it('files an ended session under its own key and omits the key-names tag', () => {
    const { events } = installSinks();

    reportAuthBranch({ cause: 'session_ended', branch: 'refresh_401' });

    expect(events).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledWith({
      level: 'warning',
      error: new Error('Auth branch: session_ended (refresh_401)'),
      tags: { 'auth.cause': 'session_ended', 'auth.branch': 'refresh_401' },
      fingerprint: ['auth-branch', 'session_ended', 'refresh_401'],
    });
  });

  it('records an explicit sign-out as a breadcrumb and sends no event', () => {
    const { events, breadcrumbs } = installSinks();

    reportAuthBranch({ cause: 'user', branch: 'explicit' });

    expect(events).not.toHaveBeenCalled();
    expect(breadcrumbs).toHaveBeenCalledTimes(1);
    expect(breadcrumbs).toHaveBeenCalledWith({
      category: 'auth',
      message: 'auth branch',
      level: 'warning',
      data: { 'auth.cause': 'user', 'auth.branch': 'explicit' },
    });
  });

  it('never throws into the caller when no sink is installed', () => {
    expect(() => {
      reportAuthBranch({ cause: 'user', branch: 'explicit' });
      reportAuthBranch({ cause: 'session_ended', branch: 'refresh_401' });
    }).not.toThrow();
  });
});
