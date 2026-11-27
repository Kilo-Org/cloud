import { describe, expect, it } from 'vitest';
import { INACTIVITY_TIMEOUT_MS } from '../../src/dos/MigrationRunDO';
import { attested, withProxy, type Proxy } from './harness';
import { MIGRATIONS, doneStatus, post, readyRun, repoFiles } from './scenario';

/** The object's run lifecycle (contract §1, §5 steps 4-5, §6, §7) with fake GitHub and container. */

const types = (proxy: Proxy) =>
  proxy.events().map(event => event.type.replace('ai.kilo.migration_proxy.', ''));
const run = (proxy: Proxy) =>
  proxy.sql<{
    state: string;
    phase: string;
    failure: string | null;
    stalled_alarms: number;
    lost_ticks: number;
  }>(
    'SELECT state, phase, failure, stalled_alarms, lost_ticks FROM runs ORDER BY seq DESC LIMIT 1'
  )[0];
const failureOf = (proxy: Proxy) =>
  JSON.parse(run(proxy)?.failure ?? 'null') as Record<string, unknown> | null;

describe('a run', () => {
  it('fetches, reviews, starts the container with the password in /apply only, and succeeds', async () => {
    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      proxy.container.status = runId => doneStatus(runId);
      const created = await post(proxy, head);
      await proxy.drive();
      expect(run(proxy)).toMatchObject({ state: 'succeeded', phase: 'done' });
      expect(types(proxy)).toEqual([
        'run_started',
        'review_check_passed',
        'session_terminated',
        'migration_applied',
        'run_finished',
      ]);
      const events = proxy.events();
      expect(events[1]?.data.attributes).toMatchObject({
        runId: created.body.run?.id,
        files: expect.arrayContaining([
          expect.stringMatching(/0001_widgets\.sql@[0-9a-f]{40}#7:eshurakov$/),
        ]),
      });
      expect(events[3]?.data.attributes).toMatchObject({
        tag: '0001_widgets',
        hash: 'a'.repeat(64),
        sha: head,
      });
      expect(events[4]?.data).toMatchObject({
        outcome: 'success',
        attributes: {
          result: 'succeeded',
          appliedCount: 1,
          pendingTags: ['0001_widgets'],
          unexpectedSessions: 0,
        },
      });
      for (const event of events) {
        const text = JSON.stringify(event);
        expect(text).not.toContain('sentinel-db-password');
        expect(text).not.toContain('db.test.invalid');
        expect(text).not.toContain('kilo_migration_proxy');
      }

      const [apply] = proxy.container.applyBodies;
      expect(apply).toMatchObject({
        runId: created.body.run?.id,
        target: { host: 'db.test.invalid', port: 5432, database: 'postgres' },
        user: 'kilo_migration_proxy',
        password: 'sentinel-db-password',
        loginMode: 'member',
        sessionKey: 'label',
      });
      expect(Object.keys((apply?.files ?? {}) as object).sort()).toEqual([
        '0000_base.sql',
        '0001_widgets.sql',
      ]);
      expect(apply?.reviewed).toEqual(
        expect.arrayContaining([
          {
            path: `${MIGRATIONS}/0001_widgets.sql`,
            blob: proxy.github.blobOf(head, `${MIGRATIONS}/0001_widgets.sql`),
          },
        ])
      );
      expect(JSON.stringify(proxy.container.startOptions)).not.toContain('sentinel');
      expect(proxy.log.at(-1)).toBe('destroy');
      // The run's own pair is recorded for later runs and samples.
      expect(proxy.sql('SELECT pid, backend_start FROM session_pairs')).toEqual([
        { pid: 4242, backend_start: '2026-11-27T10:00:00.123456Z' },
      ]);
    });
  });

  it('passes recorded pairs to the next run', async () => {
    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      proxy.sql(
        "INSERT INTO session_pairs (pid, backend_start, owner, recorded_at) VALUES (77, '2026-11-26T09:00:00.000001Z', 'old', " +
          `${Date.now()})`
      );
      proxy.container.status = runId => doneStatus(runId);
      await post(proxy, head);
      await proxy.drive();
      expect(proxy.container.applyBodies[0]?.recordedPairs).toEqual([
        { pid: 77, backendStart: '2026-11-26T09:00:00.000001Z' },
      ]);
    });
  });

  it('stores the failure the container reports, with its retryable judgement', async () => {
    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      proxy.container.status = runId =>
        doneStatus(runId, {
          applied: [],
          failure: {
            code: 'migration_failed',
            reason: null,
            sqlstate: '40P01',
            migrationTag: '0001_widgets',
            indexes: [],
          },
        });
      await post(proxy, head);
      await proxy.drive();
      expect(failureOf(proxy)).toEqual({
        code: 'migration_failed',
        retryable: true,
        sqlstate: '40P01',
        migrationTag: '0001_widgets',
      });
      expect(proxy.events().at(-1)?.data).toMatchObject({
        outcome: 'failure',
        attributes: {
          result: 'failed',
          failureCode: 'migration_failed',
          sqlstate: '40P01',
          retryable: true,
        },
      });
    });
  });

  it('reports probe_failed with its reason and invalid_index_present with its names', async () => {
    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      proxy.container.status = runId =>
        doneStatus(runId, {
          pair: null,
          applied: [],
          cleanup: null,
          failure: {
            code: 'probe_failed',
            reason: 'wrong_role',
            sqlstate: null,
            migrationTag: null,
            indexes: [],
          },
        });
      await post(proxy, head);
      await proxy.drive();
      expect(failureOf(proxy)).toEqual({
        code: 'probe_failed',
        reason: 'wrong_role',
        retryable: false,
        sqlstate: null,
        migrationTag: null,
      });
      // The probe never passed, so the run never ran.
      expect(
        proxy.sql<{ started_at: number | null }>('SELECT started_at FROM runs')[0]?.started_at
      ).toBeNull();

      proxy.sts.allow('again', attested({ sha: head, runId: '2' }));
      proxy.container.status = runId =>
        doneStatus(runId, {
          applied: [],
          failure: {
            code: 'invalid_index_present',
            reason: null,
            sqlstate: null,
            migrationTag: null,
            indexes: ['users_email_idx'],
          },
        });
      await post(proxy, head, 'again');
      await proxy.drive();
      expect(failureOf(proxy)).toMatchObject({
        code: 'invalid_index_present',
        retryable: false,
        indexes: ['users_email_idx'],
      });
      expect(proxy.events().at(-1)?.data.attributes).toMatchObject({
        invalidIndexes: ['users_email_idx'],
      });
    });
  });

  it('resumes a fetch across alarms, and gives up after 5 alarms without progress', async () => {
    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      await post(proxy, head);
      proxy.github.blobBudget = 1;
      await proxy.object.alarm();
      expect(run(proxy)).toMatchObject({ phase: 'fetching', stalled_alarms: 0 });
      const fetched = proxy.sql<{ n: number }>('SELECT count(*) AS n FROM blobs')[0]?.n;
      expect(fetched).toBe(1);
      proxy.github.blobBudget = null;
      await proxy.object.alarm();
      expect(run(proxy)?.phase).toBe('reviewing');
    });

    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      await post(proxy, head);
      proxy.github.outage = { status: 502 };
      for (let alarm = 0; alarm < 4; alarm += 1) await proxy.object.alarm();
      expect(run(proxy)).toMatchObject({ state: 'pending', stalled_alarms: 4 });
      await proxy.object.alarm();
      expect(failureOf(proxy)).toEqual({
        code: 'github_unavailable',
        retryable: true,
        sqlstate: null,
        migrationTag: null,
      });
    });
  });

  it('fails journal_invalid for a journal entry without its file', async () => {
    await withProxy({}, async proxy => {
      const base = await proxy.github.push(repoFiles(['0000_base']));
      const files: Record<string, string> = repoFiles(['0000_base', '0001_widgets']);
      delete files[`${MIGRATIONS}/0001_widgets.sql`];
      const head = await proxy.github.push(files);
      proxy.env.MIGRATION_REVIEW_BASELINE_SHA = base;
      proxy.sts.allow('tok', attested({ sha: head }));
      await post(proxy, head);
      await proxy.drive();
      expect(failureOf(proxy)?.code).toBe('journal_invalid');
    });
  });

  it('declares container_lost after 2 ticks with the container down and no status, not after 1', async () => {
    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      await post(proxy, head);
      for (let alarm = 0; alarm < 6 && run(proxy)?.phase !== 'migrating'; alarm += 1)
        await proxy.object.alarm();
      expect(run(proxy)?.phase).toBe('migrating');
      proxy.container.status = null;
      // Status failing while the container still runs is not a loss.
      await proxy.object.alarm();
      expect(run(proxy)).toMatchObject({ state: 'running', lost_ticks: 0 });
      proxy.container.running = false;
      await proxy.object.alarm();
      expect(run(proxy)).toMatchObject({ state: 'running', lost_ticks: 1 });
      await proxy.object.alarm();
      expect(failureOf(proxy)).toEqual({
        code: 'container_lost',
        retryable: true,
        sqlstate: null,
        migrationTag: null,
      });
    });
  });

  it('cancels at the run deadline and fails deadline_exceeded', async () => {
    await withProxy({ vars: { MIGRATION_RUN_DEADLINE_SECONDS: '60' } }, async proxy => {
      const { head } = await readyRun(proxy);
      await post(proxy, head);
      for (let alarm = 0; alarm < 6 && run(proxy)?.phase !== 'migrating'; alarm += 1)
        await proxy.object.alarm();
      proxy.sql(`UPDATE runs SET created_at = ${Date.now() - 61_000}`);
      await proxy.object.alarm();
      expect(proxy.log).toContain('POST /cancel');
      expect(failureOf(proxy)).toEqual({
        code: 'deadline_exceeded',
        retryable: false,
        sqlstate: null,
        migrationTag: null,
      });
      expect(proxy.log.at(-1)).toBe('destroy');
    });
  });

  it('keeps ticking every 15 seconds while a run is active', async () => {
    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      await post(proxy, head);
      for (let alarm = 0; alarm < 6 && run(proxy)?.phase !== 'migrating'; alarm += 1)
        await proxy.object.alarm();
      const before = Date.now();
      await proxy.object.alarm();
      expect(proxy.alarmAt()).toBeGreaterThanOrEqual(before + 14_000);
      expect(proxy.alarmAt()).toBeLessThanOrEqual(Date.now() + 15_000);
    });
  });
});

describe('the container (§1)', () => {
  it('fails container_start_failed after 5 refused starts instead of staying in starting', async () => {
    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      await post(proxy, head);
      proxy.container.startError = new TypeError('Invalid container instance type.');
      for (let alarm = 0; alarm < 10 && run(proxy)?.phase !== 'starting'; alarm += 1)
        await proxy.object.alarm();
      for (let alarm = 0; alarm < 4; alarm += 1) await proxy.object.alarm();
      expect(run(proxy)).toMatchObject({ state: 'pending', phase: 'starting', stalled_alarms: 4 });
      await proxy.object.alarm();
      expect(failureOf(proxy)).toEqual({
        code: 'container_start_failed',
        retryable: true,
        sqlstate: null,
        migrationTag: null,
      });
    });
  });

  it('registers both refusing intercepts before start(), then sets the 6-hour timeout', async () => {
    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      await post(proxy, head);
      await proxy.drive(6);
      const order = proxy.log.filter(entry =>
        /^(interceptAllOutboundHttp|interceptOutboundHttps|start$|setInactivityTimeout)/.test(entry)
      );
      expect(order.slice(0, 4)).toEqual([
        'interceptAllOutboundHttp',
        'interceptOutboundHttps:*',
        'start',
        `setInactivityTimeout:${INACTIVITY_TIMEOUT_MS}:free`,
      ]);
      expect(proxy.container.startOptions).toEqual({
        image: 'registry.test/migration-proxy:proxy',
        instance: 'basic',
        enableInternet: true,
      });
      expect(proxy.container.denyHandlers).toHaveLength(2);
      for (const handler of proxy.container.denyHandlers) {
        for (const url of ['http://example.com/', 'https://api.github.com/']) {
          const response = await handler.fetch(url);
          expect(response.status).toBe(403);
        }
      }
    });
  });

  it('re-applies the inactivity timeout inside blockConcurrencyWhile when the container runs', async () => {
    await withProxy({ containerRunning: true }, async proxy => {
      expect(proxy.log.slice(0, 2)).toEqual([
        'blockConcurrencyWhile',
        `setInactivityTimeout:${INACTIVITY_TIMEOUT_MS}:blocked`,
      ]);
      proxy.log.length = 0;
      await proxy.restart();
      expect(proxy.log).toEqual([
        'blockConcurrencyWhile',
        `setInactivityTimeout:${INACTIVITY_TIMEOUT_MS}:blocked`,
      ]);
    });
  });

  it('does not touch the timeout when no container runs', async () => {
    await withProxy({ containerRunning: false }, async proxy => {
      expect(proxy.log).toEqual(['blockConcurrencyWhile']);
    });
  });
});

describe('the owner-approval phase (§5 step 5)', () => {
  it('fails migration_not_approved, listing files, writing review_check_failed, starting nothing', async () => {
    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      proxy.github.reviews.set(7, [{ userId: 55_555, state: 'APPROVED', commitId: head }]);
      await post(proxy, head);
      await proxy.drive();
      expect(failureOf(proxy)).toMatchObject({
        code: 'migration_not_approved',
        retryable: false,
        files: expect.arrayContaining([
          { path: `${MIGRATIONS}/0001_widgets.sql`, reason: 'no_owner_approval', pr: 7 },
        ]),
      });
      expect(types(proxy)).toEqual(['run_started', 'review_check_failed', 'run_finished']);
      expect(proxy.events()[1]?.data).toMatchObject({
        outcome: 'failure',
        attributes: {
          failures: expect.arrayContaining([`${MIGRATIONS}/0001_widgets.sql#7:no_owner_approval`]),
        },
      });
      expect(proxy.log).not.toContain('start');
    });
  });

  it('fails owners_unreadable without CODEOWNERS and owners_mismatch for another owner set', async () => {
    for (const [codeowners, code] of [
      [null, 'owners_unreadable'],
      ['/packages/db/src/migrations/ @eshurakov @iscekic @chrarnoldus\n', 'owners_mismatch'],
    ] as const) {
      await withProxy({}, async proxy => {
        const base = await proxy.github.push(repoFiles(['0000_base']));
        const files: Record<string, string> = repoFiles(['0000_base', '0001_widgets']);
        if (codeowners === null) delete files['.github/CODEOWNERS'];
        else files['.github/CODEOWNERS'] = codeowners;
        const head = await proxy.github.push(files);
        proxy.env.MIGRATION_REVIEW_BASELINE_SHA = base;
        proxy.sts.allow('tok', attested({ sha: head }));
        await post(proxy, head);
        await proxy.drive();
        expect(failureOf(proxy)).toMatchObject({ code, retryable: false });
        expect(types(proxy)).toEqual(['run_started', 'review_check_failed', 'run_finished']);
      });
    }
  });

  it('defers a 429 with Retry-After to a later alarm, and fails github_unavailable after 30 minutes', async () => {
    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      await post(proxy, head);
      await proxy.object.alarm();
      expect(run(proxy)?.phase).toBe('reviewing');
      proxy.github.outage = { status: 429, headers: { 'retry-after': '120' } };
      await proxy.object.alarm();
      expect(run(proxy)).toMatchObject({ state: 'pending', phase: 'reviewing' });
      const retryAt = proxy.sql<{ github_retry_at: number }>('SELECT github_retry_at FROM runs')[0]
        ?.github_retry_at;
      expect(retryAt).toBeGreaterThan(Date.now() + 100_000);
      proxy.github.calls = [];
      await proxy.object.alarm();
      expect(proxy.github.calls).toEqual([]);
      proxy.sql(`UPDATE runs SET progress_at = ${Date.now() - 31 * 60_000}`);
      await proxy.object.alarm();
      expect(failureOf(proxy)?.code).toBe('github_unavailable');
    });
  });

  it('reuses a remembered pass: a later run asks GitHub nothing about an unchanged path', async () => {
    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      proxy.container.status = runId =>
        doneStatus(runId, {
          applied: [],
          failure: {
            code: 'lock_busy',
            reason: null,
            sqlstate: null,
            migrationTag: null,
            indexes: [],
          },
        });
      await post(proxy, head);
      await proxy.drive();
      proxy.github.calls = [];
      proxy.github.reviews.set(7, []);
      proxy.sts.allow('again', attested({ sha: head, runId: '2' }));
      proxy.container.status = runId => doneStatus(runId);
      await post(proxy, head, 'again');
      await proxy.drive();
      expect(run(proxy)?.state).toBe('succeeded');
      expect(
        proxy.github.calls.filter(call => /\/pulls|\/commits$|\/contents\//.test(call))
      ).toEqual([]);
    });
  });
});
