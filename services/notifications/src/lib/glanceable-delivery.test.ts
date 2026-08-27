import { describe, expect, it, vi } from 'vitest';

import type { ExpoPushMessage } from './expo-push';
import {
  apnsEventForTokenKind,
  buildAndroidGlanceableMessages,
  deliverGlanceableSnapshot,
  toGlanceableContentState,
  type ActiveAgentsGlanceable,
  type GlanceableApnsContentState,
  type GlanceableDeliveryDeps,
  type IosActivityToken,
} from './glanceable-delivery';

const snapshot: ActiveAgentsGlanceable = {
  type: 'active_agents_glanceable',
  schemaVersion: 1,
  revision: 3,
  scopeKey: 'deadbeef',
  organizationBound: false,
  status: 'happy',
  running: 2,
  needsInput: 1,
  reconnecting: 0,
  updatedAt: '2026-08-27T10:00:00.000Z',
  expiresAt: '2026-08-27T18:00:00.000Z',
  eligibleStartedAt: '2026-08-27T09:00:00.000Z',
};

function fakeDeps(overrides: Partial<GlanceableDeliveryDeps> = {}): {
  deps: GlanceableDeliveryDeps;
  calls: { iosSends: unknown[][]; androidSends: ExpoPushMessage[][] };
} {
  const calls = { iosSends: [] as unknown[][], androidSends: [] as ExpoPushMessage[][] };

  const deps: GlanceableDeliveryDeps = {
    buildSnapshot: vi.fn(async () => snapshot),
    listIosActivityTokens: vi.fn(async () => [] as IosActivityToken[]),
    sendIosLiveActivity: vi.fn(async (_tokens, _contentState) => {
      calls.iosSends.push([_tokens, _contentState]);
    }),
    listAndroidExpoTokens: vi.fn(async () => []),
    hasAndroidOngoingToken: vi.fn(async () => false),
    sendAndroidPush: vi.fn(async messages => {
      calls.androidSends.push(messages);
    }),
    ...overrides,
  };

  return { deps, calls };
}

describe('apnsEventForTokenKind', () => {
  it('maps the push-to-start token to the start event', () => {
    expect(apnsEventForTokenKind('ios_push_to_start')).toBe('start');
  });

  it('maps the activity token to the update event', () => {
    expect(apnsEventForTokenKind('ios_activity')).toBe('update');
  });
});

describe('toGlanceableContentState', () => {
  it('wraps the renderable counts + status in the expo-widgets name/props envelope', () => {
    const contentState = toGlanceableContentState(snapshot);
    expect(contentState.name).toBe('ActiveAgentsLiveActivity');
    const props = JSON.parse(contentState.props) as Record<string, unknown>;
    expect(props).toEqual({
      status: 'happy',
      running: 2,
      needsInput: 1,
      reconnecting: 0,
      eligibleStartedAt: '2026-08-27T09:00:00.000Z',
    });
  });

  it('never leaks snapshot bookkeeping, ids, or titles into the pushed content-state', () => {
    const contentState = toGlanceableContentState(snapshot);
    const raw = JSON.stringify(contentState);
    expect(raw).not.toContain('schemaVersion');
    expect(raw).not.toContain('revision');
    expect(raw).not.toContain('scopeKey');
    expect(raw).not.toContain('deadbeef');
    expect(raw).not.toContain('organizationBound');
    expect(raw).not.toContain('updatedAt');
    expect(raw).not.toContain('expiresAt');
    expect(raw).not.toContain('accountEpoch');
    expect(raw).not.toContain('title');
  });
});

describe('buildAndroidGlanceableMessages', () => {
  it('emits one low-interruption, tag-collapsed message per Expo token', () => {
    const messages = buildAndroidGlanceableMessages(
      [
        { token: 'ExponentPushToken[aaa]', locale: null },
        { token: 'ExponentPushToken[bbb]', locale: 'es' },
      ],
      snapshot
    );

    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message.data).toEqual(snapshot);
      expect(message.sound).toBeNull();
      expect(message.priority).toBe('default');
      expect(message.channelId).toBe('active-agents');
      expect(message.tag).toBe('deadbeef');
      expect(typeof message.title).toBe('string');
      expect(typeof message.body).toBe('string');
    }
    expect(messages.map(m => m.to)).toEqual(['ExponentPushToken[aaa]', 'ExponentPushToken[bbb]']);
  });
});

describe('deliverGlanceableSnapshot', () => {
  it('skips all delivery when the snapshot cannot be built', async () => {
    const { deps, calls } = fakeDeps({ buildSnapshot: vi.fn(async () => null) });

    await deliverGlanceableSnapshot({ userId: 'u1', organizationId: null }, deps);

    expect(deps.listIosActivityTokens).not.toHaveBeenCalled();
    expect(deps.hasAndroidOngoingToken).not.toHaveBeenCalled();
    expect(calls.iosSends).toHaveLength(0);
    expect(calls.androidSends).toHaveLength(0);
  });

  it('delivers the content-state to iOS tokens with the right start/update events', async () => {
    const iosTokens: IosActivityToken[] = [
      { token: 'ptt-token', kind: 'ios_push_to_start' },
      { token: 'activity-token', kind: 'ios_activity' },
    ];
    const { deps, calls } = fakeDeps({
      listIosActivityTokens: vi.fn(async () => iosTokens),
    });

    await deliverGlanceableSnapshot({ userId: 'u1', organizationId: 'org-1' }, deps);

    expect(calls.iosSends).toHaveLength(1);
    const [tokens, contentState] = calls.iosSends[0] as [
      { token: string; event: string }[],
      GlanceableApnsContentState,
    ];
    expect(tokens).toEqual([
      { token: 'ptt-token', event: 'start' },
      { token: 'activity-token', event: 'update' },
    ]);
    expect(contentState.name).toBe('ActiveAgentsLiveActivity');
    const props = JSON.parse(contentState.props) as Record<string, unknown>;
    expect(props.status).toBe('happy');
    expect(props.running).toBe(2);
    expect(props.needsInput).toBe(1);
    expect(props.reconnecting).toBe(0);
    expect(props).not.toHaveProperty('type');
    expect(props).not.toHaveProperty('accountEpoch');
    expect(props).not.toHaveProperty('scopeKey');
    expect(calls.androidSends).toHaveLength(0);
  });

  it('skips Android when no android_ongoing activity token exists', async () => {
    const { deps, calls } = fakeDeps({
      hasAndroidOngoingToken: vi.fn(async () => false),
      listAndroidExpoTokens: vi.fn(async () => [{ token: 'ExponentPushToken[aaa]', locale: null }]),
    });

    await deliverGlanceableSnapshot({ userId: 'u1', organizationId: null }, deps);

    expect(deps.listAndroidExpoTokens).not.toHaveBeenCalled();
    expect(calls.androidSends).toHaveLength(0);
  });

  it('sends the Android Expo push only when an ongoing token and Expo tokens both exist', async () => {
    const { deps, calls } = fakeDeps({
      hasAndroidOngoingToken: vi.fn(async () => true),
      listAndroidExpoTokens: vi.fn(async () => [{ token: 'ExponentPushToken[aaa]', locale: null }]),
    });

    await deliverGlanceableSnapshot({ userId: 'u1', organizationId: null }, deps);

    expect(calls.androidSends).toHaveLength(1);
    expect(calls.androidSends[0]).toHaveLength(1);
    expect(calls.androidSends[0][0].to).toBe('ExponentPushToken[aaa]');
    expect(calls.androidSends[0][0].tag).toBe('deadbeef');
  });

  it('sends nothing on Android when the user has no Expo tokens even with an ongoing token', async () => {
    const { deps, calls } = fakeDeps({
      hasAndroidOngoingToken: vi.fn(async () => true),
      listAndroidExpoTokens: vi.fn(async () => []),
    });

    await deliverGlanceableSnapshot({ userId: 'u1', organizationId: null }, deps);

    expect(deps.sendAndroidPush).not.toHaveBeenCalled();
    expect(calls.androidSends).toHaveLength(0);
  });
});
