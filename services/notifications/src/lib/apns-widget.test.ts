import { buildGlanceableSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';
import { describe, expect, it, vi } from 'vitest';
import { buildWidgetApnsRequest, sendWidgetApns } from './apns-widget';
import { toGlanceableContentState } from './glanceable-delivery';

vi.mock('./apns-live-activity', () => ({ signApnsJwt: vi.fn(async () => 'test-provider-jwt') }));
const credentials = {
  teamId: 'test-team',
  keyId: 'test-key',
  topic: 'com.kilocode.kiloapp',
  privateKeyPem: '',
};

describe('WidgetKit reload hints', () => {
  it('uses the widgets topic and carries no authoritative data', () => {
    const request = buildWidgetApnsRequest({
      token: 'test-widget',
      credentials,
      authorizationJwt: 'test-provider-jwt',
    });
    expect(request.headers['apns-push-type']).toBe('widgets');
    expect(request.headers['apns-topic']).toBe('com.kilocode.kiloapp.push-type.widgets');
    expect(JSON.parse(request.body)).toEqual({ aps: { 'content-changed': true } });
  });
  it('does not send after the durable scope fence changes', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await sendWidgetApns({
      credentials,
      tokens: ['test-widget'],
      isCurrent: async () => false,
      onGone: vi.fn(),
      fetchFn,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('retires only a confirmed gone token and preserves transient targets', async () => {
    const onGone = vi.fn(async () => undefined);
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 410 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    await sendWidgetApns({
      credentials,
      tokens: ['gone-widget', 'retained-widget'],
      onGone,
      fetchFn,
    });
    expect(onGone).toHaveBeenCalledExactlyOnceWith('gone-widget');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it('does not let Home titles enter Live Activity content state', () => {
    const snapshot = buildGlanceableSnapshot({
      userId: 'test-user',
      organizationId: null,
      sessions: [{ status: 'permission' }],
      now: 1_750_000_000_000,
    });
    const content = toGlanceableContentState({
      ...snapshot,
      type: 'active_agents_glanceable',
      homeWidgetDetails: {
        approvalKey: 'a'.repeat(64),
        primaryTitle: 'Private Home title',
        waitingAgents: [{ title: 'Private waiting title', kind: 'permission' }],
        scheduledAgents: [],
      },
    });
    expect(content.props).not.toContain('Private');
    expect(JSON.parse(content.props)).not.toHaveProperty('homeWidgetDetails');
    expect(content.props).not.toContain('a'.repeat(64));
  });
});
