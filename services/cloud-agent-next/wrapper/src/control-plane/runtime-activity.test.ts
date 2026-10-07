import { describe, expect, it } from 'bun:test';
import { CONTROL_PLANE_TIMERS } from '../../../src/shared/control-plane-timers.js';
import type { WrapperKiloClient } from '../kilo-api.js';
import {
  createRuntimeActivity,
  SESSION_CONTROL_REQUEST_MS,
  SESSION_SNAPSHOT_INTERVAL_MS,
  type RuntimeActivityOptions,
  type ActivityFault,
} from './runtime-activity.js';
import type { SessionObservation } from './session-supervisor.js';

const observation = (status: 'busy' | 'idle' = 'busy'): SessionObservation => ({
  id: 'ses_native',
  directory: '/workspace',
  status,
  messages: [],
  interactions: [],
});

function harness() {
  let now = 0;
  const snapshots: Array<Parameters<NonNullable<RuntimeActivityOptions['readSnapshot']>>[0]> = [];
  const aborts: Array<Parameters<WrapperKiloClient['abortSession']>[0]> = [];
  const faults: ActivityFault[] = [];
  const deadlines: string[] = [];
  let read: NonNullable<RuntimeActivityOptions['readSnapshot']> = async () => [];
  let abort: WrapperKiloClient['abortSession'] = async () => true;
  const activity = createRuntimeActivity({
    nativeRuntimeId: 'process-1',
    directory: '/workspace',
    timers: CONTROL_PLANE_TIMERS.wrapper,
    now: () => now,
    client: {
      abortSession: async input => {
        aborts.push(input);
        return abort(input);
      },
    } as WrapperKiloClient,
    readSnapshot: input => {
      snapshots.push(input);
      return read(input);
    },
    onDeadline: (_identity, reason) => deadlines.push(reason),
    onFault: reason => faults.push(reason),
    onChange: () => undefined,
  });
  return {
    activity,
    snapshots,
    aborts,
    faults,
    deadlines,
    advance(ms: number) {
      now += ms;
    },
    read(next: typeof read) {
      read = next;
    },
    abort(next: typeof abort) {
      abort = next;
    },
    event(
      type: string,
      properties: Record<string, unknown>,
      directory = '/workspace',
      nativeRuntimeId = 'process-1'
    ) {
      activity.observe({ type, properties, directory, nativeRuntimeId });
    },
  };
}

async function settle() {
  for (let index = 0; index < 30; index++) await Promise.resolve();
}

describe('runtime activity observation', () => {
  it.each(['snapshot', 'abort'] as const)(
    'bounds a hung %s request and aborts its transport',
    async kind => {
      const h = harness();
      try {
        h.read(async () => [observation()]);
        if (kind === 'snapshot') h.read(() => new Promise(() => undefined));
        h.activity.connected();
        const before = Date.now();
        await h.activity.refresh();
        if (kind === 'abort') {
          h.abort(() => new Promise(() => undefined));
          h.advance(CONTROL_PLANE_TIMERS.wrapper.noProgressMs);
          h.activity.tick();
          while (h.faults.length === 0 && Date.now() - before < SESSION_CONTROL_REQUEST_MS + 1_000)
            await Bun.sleep(20);
          expect(h.faults).toEqual(['abort_unconfirmed']);
          expect(h.aborts[0].signal?.aborted).toBe(true);
        } else {
          expect(h.activity.isReady()).toBe(false);
          expect(h.snapshots[0].signal.aborted).toBe(true);
        }
        expect(Date.now() - before).toBeLessThan(SESSION_CONTROL_REQUEST_MS + 1_000);
        expect(h.activity.needsCompute()).toBe(true);
      } finally {
        h.activity.dispose();
      }
    },
    SESSION_CONTROL_REQUEST_MS + 2_000
  );

  it('lets a blocked native session sleep without considering it idle for credential replacement', async () => {
    const h = harness();
    h.read(async () => [{ ...observation(), interactions: [{ id: 'question' }] }]);
    h.activity.connected();
    await h.activity.refresh();
    expect(h.activity.needsCompute()).toBe(false);
    expect(h.activity.isIdle()).toBe(false);
    h.read(async () => [observation('idle')]);
    await h.activity.refresh();
    expect(h.activity.isIdle()).toBe(true);
    h.activity.dispose();
  });
  it('subscribes before its initial snapshot, then reconciles once per named cadence', async () => {
    const h = harness();
    h.activity.tick();
    expect(h.snapshots).toHaveLength(0);
    expect(h.activity.needsCompute()).toBe(true);
    h.activity.connected();
    await h.activity.refresh();
    expect(h.activity.needsCompute()).toBe(false);
    h.advance(SESSION_SNAPSHOT_INTERVAL_MS - 1);
    h.activity.tick();
    expect(h.snapshots).toHaveLength(1);
    h.advance(1);
    h.activity.tick();
    await h.activity.refresh();
    expect(h.snapshots).toHaveLength(2);
    h.activity.dispose();
  });

  it('keeps snapshot requests single-flight and includes unrouted execution directories', async () => {
    const h = harness();
    const pending = Promise.withResolvers<SessionObservation[]>();
    h.read(() => pending.promise);
    h.event('session.status', { sessionID: 'ses_other', status: { type: 'busy' } }, '/other');
    h.activity.connected();
    const first = h.activity.refresh();
    expect(h.activity.refresh()).toBe(first);
    h.advance(SESSION_SNAPSHOT_INTERVAL_MS);
    h.activity.tick();
    expect(h.snapshots).toHaveLength(1);
    expect(h.snapshots[0].observedDirectories).toEqual(['/workspace', '/other']);
    pending.resolve([]);
    await first;
    expect(h.activity.state('ses_other')?.activity).toBe('running');
    h.activity.dispose();
  });

  it('rejects a pre-gap snapshot and refreshes the new feed without granting new clocks', async () => {
    const h = harness();
    h.read(async () => [observation()]);
    h.activity.connected();
    await h.activity.refresh();
    const started = h.activity.state('ses_native')?.startedAt;
    const pending = Promise.withResolvers<SessionObservation[]>();
    h.read(() => pending.promise);
    const old = h.activity.refresh();
    h.activity.lost();
    h.advance(40_000);
    h.activity.connected();
    h.read(async () => [observation()]);
    pending.resolve([observation('idle')]);
    await old;
    await settle();
    expect(h.activity.isReady()).toBe(true);
    expect(h.activity.state('ses_native')?.startedAt).toBe(started);
    expect(h.snapshots).toHaveLength(3);
    h.activity.dispose();
  });

  it('does not treat feed heartbeats as recovery from failed activity observations', async () => {
    const h = harness();
    h.read(async () => {
      throw new Error('partial snapshot');
    });
    h.activity.connected();
    await h.activity.refresh();
    h.advance(CONTROL_PLANE_TIMERS.wrapper.sseReconnectWindowMs);
    h.event('server.heartbeat', {});
    h.activity.tick();
    h.activity.tick();
    expect(h.faults).toEqual(['activity_observation']);
    expect(h.deadlines).toEqual([]);
    expect(h.activity.needsCompute()).toBe(true);
    h.activity.dispose();
    expect(h.activity.needsCompute()).toBe(false);
  });

  it('preserves known activity during an observation gap and suppresses native deadlines', async () => {
    const h = harness();
    h.read(async () => [observation()]);
    h.activity.connected();
    await h.activity.refresh();
    h.advance(CONTROL_PLANE_TIMERS.wrapper.noProgressMs - 1);
    h.activity.lost();
    h.advance(1);
    h.activity.tick();
    expect(h.deadlines).toEqual([]);
    expect(h.activity.needsCompute()).toBe(true);
    h.activity.connected();
    await h.activity.refresh();
    h.activity.tick();
    await settle();
    expect(h.deadlines).toEqual(['no_progress']);
    expect(h.aborts[0]).toMatchObject({ sessionId: 'ses_native', directory: '/workspace' });
    expect(h.activity.needsCompute()).toBe(false);
    h.activity.dispose();
  });

  it('retains stopping activity until confirmed abort and reports one failed-abort recovery', async () => {
    const h = harness();
    h.read(async () => [observation()]);
    h.activity.connected();
    await h.activity.refresh();
    const stopped = Promise.withResolvers<boolean>();
    h.abort(() => stopped.promise);
    h.advance(CONTROL_PLANE_TIMERS.wrapper.noProgressMs);
    h.activity.tick();
    expect(h.activity.state('ses_native')?.activity).toBe('stopping');
    expect(h.activity.needsCompute()).toBe(true);
    stopped.resolve(false);
    await settle();
    h.activity.tick();
    expect(h.faults).toEqual(['abort_unconfirmed']);
    expect(h.deadlines).toEqual(['no_progress']);
    expect(h.aborts).toHaveLength(1);
    h.activity.dispose();
  });

  it('aborts an outstanding snapshot and ignores late results and other process events on disposal', async () => {
    const h = harness();
    const pending = Promise.withResolvers<SessionObservation[]>();
    h.read(() => pending.promise);
    h.activity.connected();
    const result = h.activity.refresh();
    h.event(
      'session.status',
      { sessionID: 'ses_other', status: { type: 'busy' } },
      '/workspace',
      'process-old'
    );
    expect(h.activity.state('ses_other')).toBeUndefined();
    h.activity.dispose();
    expect(h.snapshots[0].signal.aborted).toBe(true);
    pending.resolve([observation()]);
    await result;
    expect(h.activity.state('ses_native')).toBeUndefined();
    expect(h.activity.needsCompute()).toBe(false);
    expect(h.faults).toEqual([]);
  });
});
