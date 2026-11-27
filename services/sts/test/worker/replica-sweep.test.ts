import { createScheduledController, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEASE_REPLICA_SWEEP_FAILURES_BEFORE_ERROR,
  LEASE_REPLICA_SWEEP_INTERVAL_MS,
} from '../../src/constants';
import { LeaseDO } from '../../src/dos/LeaseDO';
import { getLeaseStub } from '../../src/dos/stubs';
import type { Env } from '../../src/env';
import worker from '../../src/index';
import type { ReplicaSweep } from '../../src/leases/replica-sweep';
import { stubOfflineNetwork } from './manager';
import { resetLeaseObject } from './reset';
import { config, env } from './test-env';

const realSweep = LeaseDO.replicaSweep;

/** Each replica's Hyperdrive connection string, as the sweep receives it. */
const A = 'postgres://sweeper:hd-a@replica-a.invalid/postgres';
const B = 'postgres://sweeper:hd-b@replica-b.invalid/postgres';

/** The test env with two replicas to sweep, each a Hyperdrive binding. */
const sweepEnv = {
  ...env,
  LEASE_REPLICA_SWEEP_BINDINGS: 'LEASE_SWEEP_REPLICA_A,LEASE_SWEEP_REPLICA_B',
  LEASE_SWEEP_REPLICA_A: { connectionString: A },
  LEASE_SWEEP_REPLICA_B: { connectionString: B },
} as Env;

type Event = {
  type: string;
  data: { outcome: string; outcomeDetail?: string; attributes: Record<string, unknown> };
};

type Sweeps = { calls: string[]; answers: Map<string, number | Error> };

/** Replaces the sweep: each replica answers its configured count or throws its error. */
function fakeSweeps(): Sweeps {
  const sweeps: Sweeps = { calls: [], answers: new Map() };
  const fake: ReplicaSweep = async connectionString => {
    sweeps.calls.push(connectionString);
    const answer = sweeps.answers.get(connectionString) ?? 0;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  LeaseDO.replicaSweep = fake;
  return sweeps;
}

function refused(): Error {
  return Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
}

/** Runs `work` on a lease object built with `objectEnv`, on the environment's object storage. */
async function withObject<T>(
  objectEnv: Env,
  work: (object: LeaseDO, state: DurableObjectState) => Promise<T>
): Promise<T> {
  return await runInDurableObject(getLeaseStub(env, config), async (_instance, state) => {
    const object = new LeaseDO(state, objectEnv);
    return await work(object, state);
  });
}

async function sweepEvents(): Promise<Event[]> {
  return await runInDurableObject(getLeaseStub(env, config), (_instance, state) =>
    state.storage.sql
      .exec<{ event: string }>('SELECT event FROM audit_event ORDER BY seq')
      .toArray()
      .map(row => JSON.parse(row.event) as Event)
      .filter(event => event.type === 'ai.kilo.sts.lease.replica_swept')
  );
}

/** Makes every replica's next sweep due, as if a minute had passed. */
async function sweepsDue(): Promise<void> {
  await runInDurableObject(getLeaseStub(env, config), (_instance, state) => {
    state.storage.sql.exec('UPDATE lease_replica_sweep SET next_at = 0');
  });
}

beforeEach(async () => {
  stubOfflineNetwork();
  await resetLeaseObject(getLeaseStub(env, config));
});

afterEach(() => {
  LeaseDO.replicaSweep = realSweep;
  stubOfflineNetwork();
  vi.restoreAllMocks();
});

describe('replica sweep', () => {
  it('sweeps each replica through its own binding once a minute and audits a sweep that ended sessions', async () => {
    const sweeps = fakeSweeps();
    sweeps.answers.set(A, 2);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = Date.now();
    const alarm = await withObject(sweepEnv, async (object, state) => {
      await object.alarm();
      return await state.storage.getAlarm();
    });
    expect(sweeps.calls.sort()).toEqual([A, B]);
    const events = await sweepEvents();
    expect(events.map(event => [event.data.outcome, event.data.attributes])).toEqual([
      [
        'success',
        {
          environment: 'development',
          replica: 'LEASE_SWEEP_REPLICA_A',
          result: 'ended',
          sessions: 2,
          afterFailures: 0,
        },
      ],
    ]);
    expect(JSON.stringify(events)).not.toContain('postgres://');
    expect(log).toHaveBeenCalledWith('sts: replica sweep ended sessions of ended leases', {
      replica: 'LEASE_SWEEP_REPLICA_A',
      sessions: 2,
    });
    // The alarm comes back for the relay first, and at the latest for the next sweep.
    expect(alarm).not.toBeNull();
    expect(alarm).toBeLessThanOrEqual(Date.now() + LEASE_REPLICA_SWEEP_INTERVAL_MS);

    // Not due again within the minute: an alarm for the relay sweeps nothing.
    sweeps.answers.set(A, 0);
    await withObject(sweepEnv, async object => {
      await object.alarm();
    });
    expect(sweeps.calls).toHaveLength(2);
    const next = await runInDurableObject(getLeaseStub(env, config), (_instance, state) =>
      state.storage.sql
        .exec<{ replica: string; next_at: number; failures: number }>(
          'SELECT replica, next_at, failures FROM lease_replica_sweep ORDER BY replica'
        )
        .toArray()
    );
    expect(next.map(row => [row.replica, row.failures])).toEqual([
      ['LEASE_SWEEP_REPLICA_A', 0],
      ['LEASE_SWEEP_REPLICA_B', 0],
    ]);
    for (const row of next) {
      expect(row.next_at).toBeGreaterThanOrEqual(before + LEASE_REPLICA_SWEEP_INTERVAL_MS);
      expect(row.next_at).toBeLessThanOrEqual(Date.now() + LEASE_REPLICA_SWEEP_INTERVAL_MS);
    }

    // A minute later both are swept again; a sweep that ended nothing writes no row.
    await sweepsDue();
    await withObject(sweepEnv, async object => {
      await object.alarm();
    });
    expect(sweeps.calls).toHaveLength(4);
    expect(await sweepEvents()).toHaveLength(1);
  });

  it('retries a failing replica each minute, warns, audits the first and the 15th failure, logs one error, and audits the recovery', async () => {
    const sweeps = fakeSweeps();
    sweeps.answers.set(A, refused());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failures = LEASE_REPLICA_SWEEP_FAILURES_BEFORE_ERROR + 2;
    for (let attempt = 0; attempt < failures; attempt += 1) {
      await sweepsDue();
      await withObject(sweepEnv, async object => {
        await object.alarm();
      });
    }
    // One attempt per replica per due sweep: no retry inside a sweep.
    expect(sweeps.calls.filter(call => call === A)).toHaveLength(failures);
    expect(sweeps.calls.filter(call => call === B)).toHaveLength(failures);
    const sweepWarnings = warn.mock.calls.filter(
      ([message]) => message === 'sts: replica sweep failed; the next sweep retries it'
    );
    expect(sweepWarnings).toHaveLength(failures - 1);
    expect(sweepWarnings[0][1]).toEqual({
      replica: 'LEASE_SWEEP_REPLICA_A',
      consecutiveFailures: 1,
      detail: 'Error ECONNREFUSED',
    });
    expect(error.mock.calls).toEqual([
      [
        'sts: replica sweep keeps failing; replica sessions of ended leases may stay open',
        {
          replica: 'LEASE_SWEEP_REPLICA_A',
          consecutiveFailures: LEASE_REPLICA_SWEEP_FAILURES_BEFORE_ERROR,
          detail: 'Error ECONNREFUSED',
        },
      ],
    ]);

    sweeps.answers.set(A, 0);
    await sweepsDue();
    await withObject(sweepEnv, async object => {
      await object.alarm();
    });
    const events = await sweepEvents();
    expect(events.map(event => [event.data.outcome, event.data.attributes])).toEqual([
      [
        'failure',
        {
          environment: 'development',
          replica: 'LEASE_SWEEP_REPLICA_A',
          result: 'failed',
          consecutiveFailures: 1,
          detail: 'Error ECONNREFUSED',
        },
      ],
      [
        'failure',
        {
          environment: 'development',
          replica: 'LEASE_SWEEP_REPLICA_A',
          result: 'failed',
          consecutiveFailures: LEASE_REPLICA_SWEEP_FAILURES_BEFORE_ERROR,
          detail: 'Error ECONNREFUSED',
        },
      ],
      [
        'success',
        {
          environment: 'development',
          replica: 'LEASE_SWEEP_REPLICA_A',
          result: 'ended',
          sessions: 0,
          afterFailures: failures,
        },
      ],
    ]);
  });

  it('counts a listed replica without a Hyperdrive binding as a failing sweep, never every second', async () => {
    const sweeps = fakeSweeps();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const missing = { ...sweepEnv, LEASE_REPLICA_SWEEP_BINDINGS: 'LEASE_SWEEP_REPLICA_C' } as Env;
    const alarm = await withObject(missing, async (object, state) => {
      await object.alarm();
      await state.storage.deleteAlarm();
      await object.ensureSweeping();
      return await state.storage.getAlarm();
    });
    expect(sweeps.calls).toEqual([]);
    expect((await sweepEvents()).map(event => event.data.attributes)).toEqual([
      {
        environment: 'development',
        replica: 'LEASE_SWEEP_REPLICA_C',
        result: 'failed',
        consecutiveFailures: 1,
        detail: 'ReplicaBindingMissingError',
      },
    ]);
    // The failed row is relayed first; the sweep itself waits its minute.
    expect(alarm).not.toBeNull();
    const due = await runInDurableObject(
      getLeaseStub(env, config),
      (_instance, state) =>
        state.storage.sql.exec<{ next_at: number }>('SELECT next_at FROM lease_replica_sweep').one()
          .next_at
    );
    expect(due).toBeGreaterThan(Date.now() + LEASE_REPLICA_SWEEP_INTERVAL_MS - 5_000);
  });

  it('sweeps nothing, schedules nothing and forgets old replica rows when no replica is configured', async () => {
    const sweeps = fakeSweeps();
    await runInDurableObject(getLeaseStub(env, config), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO lease_replica_sweep (replica, next_at, failures) VALUES ('LEASE_SWEEP_OLD', 0, 3)`
      );
    });
    const alarm = await withObject(env, async (object, state) => {
      await object.ensureSweeping();
      const scheduled = await state.storage.getAlarm();
      await object.alarm();
      return scheduled;
    });
    expect(alarm).toBeNull();
    expect(sweeps.calls).toEqual([]);
    const rows = await runInDurableObject(getLeaseStub(env, config), (_instance, state) =>
      state.storage.sql.exec('SELECT replica FROM lease_replica_sweep').toArray()
    );
    expect(rows).toEqual([]);
  });

  it('starts the sweep from ensureSweeping with no lease call: the first sweep is due at once', async () => {
    fakeSweeps();
    const before = Date.now();
    const alarm = await withObject(sweepEnv, async (object, state) => {
      await object.ensureSweeping();
      return await state.storage.getAlarm();
    });
    expect(alarm).not.toBeNull();
    expect(alarm).toBeGreaterThanOrEqual(before + 1_000);
    expect(alarm).toBeLessThanOrEqual(Date.now() + 1_000);
  });
});

describe('scheduled handler and the sweep', () => {
  it('asks the lease object to keep sweeping only while replicas are configured', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ensureSweeping = vi.spyOn(LeaseDO.prototype, 'ensureSweeping');
    const controller = () =>
      createScheduledController({ cron: '*/5 * * * *', scheduledTime: Date.now() });
    await worker.scheduled(controller(), env);
    expect(ensureSweeping).not.toHaveBeenCalled();
    await worker.scheduled(controller(), sweepEnv);
    expect(ensureSweeping).toHaveBeenCalledTimes(1);
  });
});
