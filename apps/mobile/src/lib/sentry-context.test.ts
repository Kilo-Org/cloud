import { beforeEach, describe, expect, it, vi } from 'vitest';

const setUser = vi.hoisted(() => vi.fn());
const setTag = vi.hoisted(() => vi.fn());

vi.mock('@sentry/react-native', () => ({ setUser, setTag }));

describe('Sentry context', () => {
  beforeEach(() => {
    vi.resetModules();
    setUser.mockReset();
    setTag.mockReset();
  });

  it('sets the app user id and low-cardinality global tags', async () => {
    const { setSentryContext } = await import('./sentry-context');

    setSentryContext({
      userId: 'user-123',
      authState: 'signed_in',
      telemetryMode: 'optional',
    });

    expect(setUser).toHaveBeenCalledWith({ id: 'user-123' });
    expect(setTag).toHaveBeenCalledWith('app.auth_state', 'signed_in');
    expect(setTag).toHaveBeenCalledWith('app.telemetry_mode', 'optional');
  });

  it('reapplies the current identity and tags after an SDK reinitialization', async () => {
    const { applySentryContext, setSentryContext } = await import('./sentry-context');
    setSentryContext({
      userId: 'user-123',
      authState: 'signed_in',
      telemetryMode: 'optional',
    });
    setUser.mockClear();
    setTag.mockClear();

    applySentryContext();

    expect(setUser).toHaveBeenCalledWith({ id: 'user-123' });
    expect(setTag).toHaveBeenCalledWith('app.auth_state', 'signed_in');
    expect(setTag).toHaveBeenCalledWith('app.telemetry_mode', 'optional');
  });

  it('clears identity and marks the user signed out', async () => {
    const { clearSentryUser, setSentryContext } = await import('./sentry-context');
    setSentryContext({
      userId: 'user-123',
      authState: 'signed_in',
      telemetryMode: 'optional',
    });
    setUser.mockClear();
    setTag.mockClear();

    clearSentryUser();

    expect(setUser).toHaveBeenCalledWith(null);
    expect(setTag).toHaveBeenCalledWith('app.auth_state', 'signed_out');
    expect(setTag).toHaveBeenCalledWith('app.telemetry_mode', 'optional');
  });

  it('clears identity when account lookup fails', async () => {
    const { setSentryContext } = await import('./sentry-context');

    setSentryContext({ userId: null, authState: 'error', telemetryMode: 'mandatory' });

    expect(setUser).toHaveBeenCalledWith(null);
    expect(setTag).toHaveBeenCalledWith('app.auth_state', 'error');
  });
});
