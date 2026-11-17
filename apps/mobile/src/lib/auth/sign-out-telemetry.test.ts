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
  it('files a session no credential can renew under its cause and branch', () => {
    const { events, breadcrumbs } = installSinks();

    reportAuthBranch({ cause: 'session_unrenewable' });

    expect(events).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledWith({
      level: 'warning',
      error: new Error('Auth branch: session_unrenewable (refresh_token_absent)'),
      tags: {
        'auth.cause': 'session_unrenewable',
        'auth.branch': 'refresh_token_absent',
      },
      fingerprint: ['auth-branch', 'session_unrenewable', 'refresh_token_absent'],
    });
    expect(breadcrumbs).not.toHaveBeenCalled();
  });

  it('files an ended session under its own key', () => {
    const { events } = installSinks();

    reportAuthBranch({ cause: 'session_ended' });

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

    reportAuthBranch({ cause: 'user' });

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
      reportAuthBranch({ cause: 'user' });
      reportAuthBranch({ cause: 'session_ended' });
    }).not.toThrow();
  });
});
