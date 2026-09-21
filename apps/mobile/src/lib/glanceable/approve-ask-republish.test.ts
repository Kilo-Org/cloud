/* eslint-disable require-await -- the fake tray fetch settles without await */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The republish that follows an answered ask runs on the *tray*, and the tray's
 * row for the answered session can still read permission/question until the
 * control plane's status sync lands. Re-recording that row put Approve back on
 * the notification the user had just actioned, so the surface kept asking for
 * input for that session. This suite runs the real publisher wiring (no
 * `createPublisher` override) to pin both halves: the answered session is
 * dropped, and every other session's ask still reaches the surface.
 *
 * The mocks are the import-time native/SDK graph `approve-ask` pulls in; see
 * `approve-ask.test.ts`, whose fakes cover the answer path itself.
 */
vi.mock('@/lib/trpc', () => ({ trpcClient: {} }));
vi.mock('@/lib/cloud-agent-stream-ticket', () => ({ fetchCloudAgentStreamTicket: vi.fn() }));
vi.mock('@kilocode/cloud-agent-sdk', () => ({ createConnection: vi.fn() }));
vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.test',
  CLOUD_AGENT_WS_URL: 'wss://ws.test',
  WEB_BASE_URL: 'https://web.test',
}));
vi.mock('@/lib/user-web-connection-lifecycle', () => ({
  createNativeUserWebConnectionLifecycleHooks: vi.fn(() => ({})),
}));
// `credentials.ts` pulls the event-service client for its refresh deadline; this
// suite never reaches that path, and the client drags the RN runtime in with it.
vi.mock('@kilocode/event-service', () => ({
  CONTROL_PLANE_DEADLINE_MS: 15_000,
  withDeadline: vi.fn(),
}));
// `credentials.ts` also imports expo-secure-store at module scope, whose entry
// imports react-native. This suite only needs the import to resolve.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

const { refreshGlanceableSnapshot } = await import('./approve-ask');
const { _resetGlanceablePersistForTests } = await import('./persist');
const { _resetWaitingAskForTests, getWaitingAsk, recordWaitingAsk } = await import('./waiting-ask');

const WAITING_ROW = {
  id: 'ses_1',
  status: 'permission',
  statusUpdatedAt: '2026-01-01T00:00:00.000Z',
};

/** The record a retryable Approve failure leaves in place. */
const RETRYABLE_ASK = {
  kiloSessionId: 'ses_1',
  status: 'permission',
  isCloudAgent: true,
  scopeKey: 'scope',
  organizationId: null,
  userId: 'u1',
  recordedAt: 1,
};

/** One tick only: the poll's own cadence and budget are covered in approve-ask.test.ts. */
const oneTick = { sleep: vi.fn(), deadlineMs: 0 };

beforeEach(() => {
  _resetWaitingAskForTests();
  _resetGlanceablePersistForTests();
});

describe('the republish after an answered ask', () => {
  it('leaves no ask for the session it answered, even while the tray still reports it', async () => {
    const fetchRows = vi.fn(async () => [WAITING_ROW]);

    await refreshGlanceableSnapshot(
      { userId: 'u1', organizationId: null, answeredKiloSessionId: 'ses_1', askEnded: true },
      { fetchRows, ...oneTick }
    );

    expect(fetchRows).toHaveBeenCalled();
    expect(getWaitingAsk()).toBeNull();
  });

  it('keeps the ask a retryable failure left behind while its row is the only one waiting', async () => {
    // The tap failed retryably, so the record still names the session and the
    // surface keeps Approve for a second tap. The tray has not re-synced yet:
    // that answered row is the only asking one. The republish must re-select it,
    // or the surface loses the only action that can answer the ask.
    recordWaitingAsk(RETRYABLE_ASK);
    const fetchRows = vi.fn(async () => [WAITING_ROW]);

    await refreshGlanceableSnapshot(
      { userId: 'u1', organizationId: null, answeredKiloSessionId: 'ses_1', askEnded: false },
      { fetchRows, ...oneTick }
    );

    expect(getWaitingAsk()).toMatchObject({
      kiloSessionId: 'ses_1',
      status: 'permission',
      userId: 'u1',
      organizationId: null,
    });
  });

  it('keeps the failed session as the ask while another session also waits', async () => {
    // The retry has to answer the session the failure line named, so the row
    // the action already failed on stays the selection even though a newer
    // waiting row would win no selection at all: skipping the failed row would
    // move the second tap onto a different session silently.
    recordWaitingAsk(RETRYABLE_ASK);
    const fetchRows = vi.fn(async () => [
      WAITING_ROW,
      { id: 'ses_2', status: 'permission', statusUpdatedAt: '2026-01-01T00:00:01.000Z' },
    ]);

    await refreshGlanceableSnapshot(
      { userId: 'u1', organizationId: null, answeredKiloSessionId: 'ses_1', askEnded: false },
      { fetchRows, ...oneTick }
    );

    expect(getWaitingAsk()).toMatchObject({ kiloSessionId: 'ses_1' });
  });

  it('names the next waiting session once the answered ask ended', async () => {
    const fetchRows = vi.fn(async () => [
      WAITING_ROW,
      { id: 'ses_2', status: 'permission', statusUpdatedAt: '2026-01-01T00:00:01.000Z' },
    ]);

    await refreshGlanceableSnapshot(
      { userId: 'u1', organizationId: null, answeredKiloSessionId: 'ses_1', askEnded: true },
      { fetchRows, ...oneTick }
    );

    expect(getWaitingAsk()).toMatchObject({ kiloSessionId: 'ses_2' });
  });

  it("still names another session's ask, so the action reaches the right session", async () => {
    const fetchRows = vi.fn(async () => [{ ...WAITING_ROW, id: 'ses_2' }]);

    await refreshGlanceableSnapshot(
      { userId: 'u1', organizationId: null, answeredKiloSessionId: 'ses_1', askEnded: true },
      { fetchRows, ...oneTick }
    );

    expect(getWaitingAsk()).toMatchObject({
      kiloSessionId: 'ses_2',
      status: 'permission',
      userId: 'u1',
      organizationId: null,
    });
  });
});
