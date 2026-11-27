import { describe, expect, it } from 'vitest';
import { attested, withProxy, type Proxy } from './harness';
import { doneStatus, post, readyRun, repoFiles } from './scenario';

/** Every row of contract §4's POST and GET tables, and §5 steps 1-3. */

function markFinished(proxy: Proxy, state: 'succeeded' | 'failed', failure: unknown = null) {
  proxy.sql(
    `UPDATE runs SET state = '${state}', phase = 'done', failure = ${
      failure === null ? 'NULL' : `'${JSON.stringify(failure)}'`
    } WHERE state IN ('pending', 'running')`
  );
}

const retryable = { code: 'lock_busy', retryable: true, sqlstate: null, migrationTag: null };
const permanent = {
  code: 'migration_failed',
  retryable: false,
  sqlstate: '42P07',
  migrationTag: '0001_widgets',
};

describe('POST /v1/runs', () => {
  it('202 accepted: a new pending run in fetching, with its first alarm set for now', async () => {
    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      const before = Date.now();
      const { status, body } = await post(proxy, head);
      expect(status).toBe(202);
      expect(body.status).toBe('accepted');
      expect(body.run).toMatchObject({
        environment: 'production',
        state: 'pending',
        phase: 'fetching',
        sha: head,
        attestedSha: head,
        github: { runId: '1000', runAttempt: '1', eventName: 'workflow_run' },
        startedAt: null,
        finishedAt: null,
        pending: [],
        applied: [],
        failure: null,
        pollAfterSeconds: 20,
      });
      expect(proxy.alarmAt()).toBeGreaterThanOrEqual(before);
      expect(proxy.alarmAt()).toBeLessThanOrEqual(Date.now());
      expect(proxy.events().map(event => event.type)).toEqual([
        'ai.kilo.migration_proxy.run_started',
      ]);
      expect(proxy.events()[0]?.data.attributes).toMatchObject({
        sha: head,
        attestedSha: head,
        githubRunId: '1000',
        githubRunAttempt: '1',
        eventName: 'workflow_run',
        repositoryId: '1145038391',
      });
    });
  });

  it('200 existing: the same attempt while active, succeeded, or failed for good', async () => {
    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      const first = await post(proxy, head);
      const active = await post(proxy, head);
      expect(active.status).toBe(200);
      expect(active.body).toMatchObject({ status: 'existing', run: { id: first.body.run?.id } });
      markFinished(proxy, 'failed', permanent);
      const failed = await post(proxy, head);
      expect(failed.body).toMatchObject({
        status: 'existing',
        run: { state: 'failed', failure: permanent },
      });
      markFinished(proxy, 'succeeded');
      proxy.sql("UPDATE runs SET state = 'succeeded', failure = NULL");
      expect((await post(proxy, head)).body).toMatchObject({
        status: 'existing',
        run: { state: 'succeeded' },
      });
    });
  });

  it('202 again after a retryable failure, and 429 too_many_attempts after 3 runs of one attempt', async () => {
    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      const ids = new Set<string>();
      for (let run = 0; run < 3; run += 1) {
        const answer = await post(proxy, head);
        expect(answer.status).toBe(202);
        ids.add(answer.body.run?.id ?? '');
        markFinished(proxy, 'failed', retryable);
      }
      expect(ids.size).toBe(3);
      const fourth = await post(proxy, head);
      expect(fourth.status).toBe(429);
      expect(fourth.body).toMatchObject({ status: 'limited', reason: 'too_many_attempts' });
      expect(fourth.headers.get('Retry-After')).toBe(String(fourth.body.retryAfterSeconds));
    });
  });

  it('200 already_applied for the newest succeeded sha and any ancestor of it', async () => {
    await withProxy({}, async proxy => {
      const { base, head } = await readyRun(proxy);
      await post(proxy, head);
      markFinished(proxy, 'succeeded');
      for (const [token, sha, runId] of [
        ['same', head, '7'],
        ['older', base, '8'],
      ] as const) {
        proxy.sts.allow(token, attested({ sha: head, runId }));
        const answer = await post(proxy, sha, token);
        expect(answer.status).toBe(200);
        expect(answer.body).toMatchObject({
          status: 'already_applied',
          run: { sha: head, state: 'succeeded' },
        });
      }
      expect(proxy.sql<{ n: number }>('SELECT count(*) AS n FROM runs')[0]?.n).toBe(1);
    });
  });

  it('400 for a malformed body and 413 above 1 KB, before STS is asked', async () => {
    await withProxy({}, async proxy => {
      proxy.sts.attestThrows = true;
      for (const body of [
        'not json',
        '{}',
        '{"sha":"ABC"}',
        `{"sha":"${'a'.repeat(40)}","x":1}`,
        '[]',
      ]) {
        const response = await proxy.request('POST', '/v1/runs', { token: 'tok', body });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ status: 'invalid_request' });
      }
      const big = await proxy.request('POST', '/v1/runs', {
        token: 'tok',
        body: JSON.stringify({ sha: 'a'.repeat(40), pad: 'x'.repeat(1100) }),
      });
      expect(big.status).toBe(413);
    });
  });

  it('401 identity_rejected without a token and for a token STS rejects', async () => {
    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      const missing = await proxy.request('POST', '/v1/runs', {
        body: JSON.stringify({ sha: head }),
      });
      expect(missing.status).toBe(401);
      expect(await missing.json()).toEqual({ status: 'denied', reason: 'identity_rejected' });
      expect((await post(proxy, head, 'unknown-token')).status).toBe(401);
      // One run_denied per reason and actor per minute (§7).
      expect(proxy.events().filter(event => event.type.endsWith('run_denied'))).toHaveLength(1);
    });
  });

  it.each(['unknown_workload', 'environment_mismatch', 'grant_not_allowed'] as const)(
    '403 %s from STS',
    async reason => {
      await withProxy({}, async proxy => {
        const { head } = await readyRun(proxy);
        proxy.sts.attestations.set('tok', { status: 'denied', reason });
        const answer = await post(proxy, head);
        expect(answer.status).toBe(403);
        expect(answer.body).toEqual({ status: 'denied', reason });
      });
    }
  );

  it.each([
    ['another repository', { repositoryId: '1' }, 'ci-db-migrate'],
    ['another owner', { repositoryOwnerId: '2' }, 'ci-db-migrate'],
    ['a branch ref', { ref: 'refs/heads/feature' }, 'ci-db-migrate'],
    ['the staging environment', { environment: 'staging' }, 'ci-db-migrate'],
    [
      'the staging workflow',
      { jobWorkflowRef: 'Kilo-Org/cloud/.github/workflows/deploy-staging.yml@refs/heads/main' },
      'ci-db-migrate',
    ],
    ['a push event', { eventName: 'push' }, 'ci-db-migrate'],
    ['the staging workload', {}, 'ci-db-migrate-staging'],
  ])('403 claim_mismatch for %s', async (_label, claims, workload) => {
    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      proxy.sts.allow('tok', attested({ sha: head, ...claims }, workload));
      const answer = await post(proxy, head);
      expect(answer.status).toBe(403);
      expect(answer.body).toEqual({ status: 'denied', reason: 'claim_mismatch' });
      const denied = proxy.events().find(event => event.type.endsWith('run_denied'));
      expect(denied?.data.outcome).toBe('denied');
      expect(denied?.data.attributes).toMatchObject({
        reason: 'claim_mismatch',
        githubRunId: '1000',
      });
    });
  });

  it('403 sha_not_attested for a sha that is not the attested one nor its ancestor', async () => {
    await withProxy({}, async proxy => {
      const { base, head } = await readyRun(proxy);
      proxy.sts.allow('tok', attested({ sha: base }));
      expect((await post(proxy, head)).body).toEqual({
        status: 'denied',
        reason: 'sha_not_attested',
      });
    });
  });

  it('403 sha_not_on_main for an attested sha off main', async () => {
    await withProxy({}, async proxy => {
      const { base } = await readyRun(proxy);
      const side = await proxy.github.commit(repoFiles(['0000_base', '0001_side']), base);
      proxy.sts.allow('tok', attested({ sha: side }));
      expect((await post(proxy, side)).body).toEqual({
        status: 'denied',
        reason: 'sha_not_on_main',
      });
    });
  });

  it('409 busy while another attempt runs, with Retry-After', async () => {
    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      const first = await post(proxy, head);
      proxy.sts.allow('other', attested({ sha: head, runId: '2000' }));
      const busy = await post(proxy, head, 'other');
      expect(busy.status).toBe(409);
      expect(busy.body).toEqual({
        status: 'busy',
        activeRunId: first.body.run?.id,
        retryAfterSeconds: 30,
      });
      expect(busy.headers.get('Retry-After')).toBe('30');
    });
  });

  it('429 rate_limited past 12 creations an hour', async () => {
    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      for (let run = 0; run < 12; run += 1) {
        proxy.sts.allow(`t${run}`, attested({ sha: head, runId: String(3000 + run) }));
        expect((await post(proxy, head, `t${run}`)).status).toBe(202);
        markFinished(proxy, 'failed', retryable);
      }
      proxy.sts.allow('t12', attested({ sha: head, runId: '3012' }));
      const limited = await post(proxy, head, 't12');
      expect(limited.status).toBe(429);
      expect(limited.body.reason).toBe('rate_limited');
      expect(limited.body.retryAfterSeconds).toBeGreaterThan(3500);
    });
  });

  it('503 sts_unavailable when STS fails, and github_unavailable when GitHub does', async () => {
    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      proxy.sts.attestThrows = true;
      const sts = await post(proxy, head);
      expect(sts.status).toBe(503);
      expect(sts.body).toMatchObject({ status: 'unavailable', reason: 'sts_unavailable' });
      expect(sts.headers.get('Retry-After')).toBe('30');
      proxy.sts.attestThrows = false;
      proxy.github.outage = { status: 502 };
      const github = await post(proxy, head);
      expect(github.status).toBe(503);
      expect(github.body).toMatchObject({ status: 'unavailable', reason: 'github_unavailable' });
      proxy.github.outage = {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600),
        },
      };
      const limited = await post(proxy, head);
      expect(limited.body.retryAfterSeconds).toBeGreaterThan(500);
    });
  });

  it('500 config_invalid for a refused config, and nothing starts', async () => {
    await withProxy({ vars: { MIGRATION_DB_LOGIN_MODE: 'direct' } }, async proxy => {
      const { head } = await readyRun(proxy);
      const response = await proxy.request('POST', '/v1/runs', {
        token: 'tok',
        body: JSON.stringify({ sha: head }),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ status: 'config_invalid' });
      expect(
        await proxy.object.createRun({ attested: attested({ sha: head }), sha: head })
      ).toEqual({
        kind: 'config_invalid',
      });
      await proxy.object.alarm();
      expect(proxy.sql('SELECT * FROM runs')).toEqual([]);
      expect(proxy.sql('SELECT * FROM samples')).toEqual([]);
      expect(proxy.log.filter(entry => entry === 'start')).toEqual([]);
    });
  });
});

describe('the downgrade guard (§5 step 3)', () => {
  /** Runs `sha` to a final state as attempt `runId`. */
  async function finished(proxy: Proxy, sha: string, runId: string, state: 'succeeded' | 'failed') {
    proxy.sts.allow(runId, attested({ sha: proxy.github.main ?? sha, runId }));
    const answer = await post(proxy, sha, runId);
    expect(answer.status).toBe(202);
    markFinished(proxy, state, state === 'failed' ? retryable : null);
  }

  it('identical to the newest succeeded sha: already_applied', async () => {
    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      await finished(proxy, head, '1', 'succeeded');
      proxy.sts.allow('again', attested({ sha: head, runId: '2' }));
      expect((await post(proxy, head, 'again')).body.status).toBe('already_applied');
    });
  });

  it('behind the newest succeeded sha: already_applied', async () => {
    await withProxy({}, async proxy => {
      const { base, head } = await readyRun(proxy);
      await finished(proxy, head, '1', 'succeeded');
      proxy.sts.allow('old', attested({ sha: head, runId: '2' }));
      expect((await post(proxy, base, 'old')).body).toMatchObject({
        status: 'already_applied',
        run: { sha: head },
      });
    });
  });

  it('behind the newest attempted sha: sha_behind_attempted, naming it', async () => {
    await withProxy({}, async proxy => {
      const { base, head } = await readyRun(proxy);
      await finished(proxy, head, '1', 'failed');
      proxy.sts.allow('old', attested({ sha: head, runId: '2' }));
      expect((await post(proxy, base, 'old')).body).toEqual({
        status: 'denied',
        reason: 'sha_behind_attempted',
        attemptedSha: head,
      });
    });
  });

  it('diverged from the newest attempted sha: sha_diverged', async () => {
    await withProxy({}, async proxy => {
      const { base, head } = await readyRun(proxy);
      // An attempted sha that main no longer contains (main moved on another line).
      const side = await proxy.github.commit(repoFiles(['0000_base', '0001_side']), base);
      proxy.sts.allow('side', attested({ sha: side, runId: '1' }));
      proxy.github.main = side;
      expect((await post(proxy, side, 'side')).status).toBe(202);
      markFinished(proxy, 'failed', retryable);
      proxy.github.main = head;
      proxy.sts.allow('main', attested({ sha: head, runId: '2' }));
      expect((await post(proxy, head, 'main')).body).toMatchObject({
        status: 'denied',
        reason: 'sha_diverged',
      });
    });
  });

  it('ahead of or equal to the newest attempted sha proceeds', async () => {
    await withProxy({}, async proxy => {
      const { base, head } = await readyRun(proxy);
      await finished(proxy, base, '1', 'failed');
      proxy.sts.allow('newer', attested({ sha: head, runId: '2' }));
      expect((await post(proxy, head, 'newer')).status).toBe(202);
      markFinished(proxy, 'failed', retryable);
      proxy.sts.allow('same', attested({ sha: head, runId: '3' }));
      expect((await post(proxy, head, 'same')).status).toBe(202);
    });
  });
});

describe('GET /v1/runs/{id}', () => {
  it('200 with the run view for any run of the environment, 404 otherwise, 401 without identity', async () => {
    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      const created = await post(proxy, head);
      proxy.sts.allow('watcher', attested({ sha: head, runId: '9999' }));
      const id = created.body.run?.id ?? '';
      const found = await proxy.request('GET', `/v1/runs/${id}`, { token: 'watcher' });
      expect(found.status).toBe(200);
      expect(await found.json()).toMatchObject({ id, state: 'pending' });
      const missing = await proxy.request('GET', `/v1/runs/${crypto.randomUUID()}`, {
        token: 'watcher',
      });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ status: 'not_found' });
      expect((await proxy.request('GET', `/v1/runs/${id}`, { token: 'nope' })).status).toBe(401);
      expect((await proxy.request('GET', '/v1/runs/not-a-uuid', { token: 'watcher' })).status).toBe(
        404
      );
    });
  });

  it('serves the final view: succeeded with applied entries and a done phase', async () => {
    await withProxy({}, async proxy => {
      const { head } = await readyRun(proxy);
      proxy.container.status = runId => doneStatus(runId);
      const created = await post(proxy, head);
      await proxy.drive();
      const view = await proxy.request('GET', `/v1/runs/${created.body.run?.id}`, { token: 'tok' });
      expect(await view.json()).toMatchObject({
        state: 'succeeded',
        phase: 'done',
        pending: ['0001_widgets'],
        applied: [{ tag: '0001_widgets', hash: 'a'.repeat(64), createdAt: 1_769_695_992_111 }],
        failure: null,
      });
    });
  });
});
