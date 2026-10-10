import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshotStatus,
  type GlanceableSessionRow,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveIncomingUrl } from '@kilocode/app-shared/universal-links';

import { type WaitingAsk } from '@/lib/glanceable/waiting-ask';

import { type LiveUpdateCard } from './live-update';

const mocks = vi.hoisted(() => ({
  native: {
    isPromotionCapable: vi.fn(() => true),
    start: vi.fn(),
    update: vi.fn(),
    end: vi.fn(),
    setWidgetSnapshot: vi.fn(),
    getWidgetSnapshot: vi.fn<() => string | null>(() => null),
  },
}));

vi.mock('expo', () => ({
  requireOptionalNativeModule: () => mocks.native,
}));

const {
  buildNotificationActions,
  end: endLiveUpdate,
  getStoredWidgetSnapshot,
  setWidgetSnapshot,
  start,
  update,
} = await import('./live-update');

const NOW = 1_750_000_000_000;

function snapshot(
  overrides: {
    status?: GlanceableAgentsSnapshotStatus;
    sessions?: readonly GlanceableSessionRow[];
  } = {}
) {
  return buildGlanceableSnapshot({
    sessions: overrides.sessions ?? [{ status: 'busy' }],
    userId: 'u1',
    organizationId: null,
    now: NOW,
    ...(overrides.status === undefined ? {} : { status: overrides.status }),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.native.isPromotionCapable.mockReturnValue(true);
  mocks.native.start.mockClear();
  mocks.native.update.mockClear();
  mocks.native.end.mockClear();
  mocks.native.setWidgetSnapshot.mockClear();
  mocks.native.getWidgetSnapshot.mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('notification Open destination', () => {
  it.each(['ses_1', 'ses_1/2 3', 'ses_1?tab=2', 'ses_1#part', 'ses_%2F'])(
    'preserves the entire recorded session id %s',
    kiloSessionId => {
      const ask: WaitingAsk = {
        kiloSessionId,
        status: 'permission',
        isCloudAgent: true,
        scopeKey: 'scope',
        organizationId: null,
        userId: 'u1',
        recordedAt: NOW,
      };
      const actions = buildNotificationActions(ask, key => key);

      expect(resolveIncomingUrl(actions.openUrl)).toBe(
        `/(app)/agent-chat/${encodeURIComponent(kiloSessionId)}`
      );
      expect(actions.approveLabel).toBe('common.approve');
    }
  );

  it('opens the Agents tab without offering Approve when no ask is recorded', () => {
    const actions = buildNotificationActions(null, key => key);

    expect(resolveIncomingUrl(actions.openUrl)).toBe('/(app)/(tabs)/(2_agents)');
    expect(actions.approveLabel).toBeNull();
  });
});

const CARD: LiveUpdateCard = {
  title: '2 Needs input',
  text: '3 Working · 1 Scheduled',
  textIsError: false,
  subText: 'Checked 4:32 PM',
  compactText: '2',
  openLabel: 'Open',
  openUrl: 'kiloapp:///cloud/sessions/ses_1',
  approveLabel: 'Approve',
  newAgentLabel: null,
  newAgentUrl: 'kiloapp:///cloud/sessions/new',
};

describe('live-update bridge argument shape', () => {
  it('forwards the card record, channel, alert and promotion gate on start', () => {
    start(CARD, 'needs-input', true);

    expect(mocks.native.start).toHaveBeenCalledTimes(1);
    expect(mocks.native.start).toHaveBeenCalledWith(CARD, 'needs-input', true, true);
  });

  it('defaults the update timeout to zero and forwards an explicit one', () => {
    update(CARD, 'agent-progress', false);
    expect(mocks.native.update).toHaveBeenLastCalledWith(CARD, 'agent-progress', false, 0);

    update(CARD, 'needs-input', true, 8000);
    expect(mocks.native.update).toHaveBeenLastCalledWith(CARD, 'needs-input', true, 8000);
  });

  it('mirrors the native promotion gate on start and leaves it to the native update', () => {
    mocks.native.isPromotionCapable.mockReturnValue(false);
    start(CARD, 'agent-progress', false);
    update(CARD, 'agent-progress', false);

    expect(mocks.native.start).toHaveBeenCalledWith(CARD, 'agent-progress', false, false);
    // The native `update` carries the terminal timeout and reads the promotion
    // gate from its own `isPromotionCapable()`.
    expect(mocks.native.update).toHaveBeenCalledWith(CARD, 'agent-progress', false, 0);
  });

  it('ends the notification through the native module', () => {
    endLiveUpdate();

    expect(mocks.native.end).toHaveBeenCalledTimes(1);
  });
});

describe('live-update widget snapshot handoff', () => {
  it('persists the serialized snapshot with its native expiry for eligible happy work', () => {
    const happy = snapshot();

    setWidgetSnapshot(happy);

    expect(mocks.native.setWidgetSnapshot).toHaveBeenCalledWith(
      JSON.stringify(happy),
      Date.parse(happy.expiresAt)
    );
  });

  it.each(['empty', 'stale'] as const)(
    'persists a %s snapshot with no deadline unless it carries eligible work',
    status => {
      const ineligible = snapshot({ status, sessions: [] });

      setWidgetSnapshot(ineligible);

      expect(mocks.native.setWidgetSnapshot).toHaveBeenCalledWith(JSON.stringify(ineligible), 0);
    }
  );

  it('drops an expired eligible snapshot deadline before handing it to Android', () => {
    const happy = snapshot();
    vi.setSystemTime(NOW + 28_800_001);

    setWidgetSnapshot(happy);

    expect(mocks.native.setWidgetSnapshot).toHaveBeenCalledWith(JSON.stringify(happy), 0);
  });

  it('round-trips a stored snapshot and rejects unparseable or invalid storage', () => {
    const happy = snapshot();
    mocks.native.getWidgetSnapshot.mockReturnValueOnce(JSON.stringify(happy));
    expect(getStoredWidgetSnapshot()).toEqual(happy);

    mocks.native.getWidgetSnapshot.mockReturnValueOnce('{ not json');
    expect(getStoredWidgetSnapshot()).toBeNull();

    mocks.native.getWidgetSnapshot.mockReturnValueOnce(JSON.stringify({ schemaVersion: 1 }));
    expect(getStoredWidgetSnapshot()).toBeNull();

    expect(getStoredWidgetSnapshot()).toBeNull();
  });
});
