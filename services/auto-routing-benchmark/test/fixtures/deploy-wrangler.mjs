import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';

const path = process.env.BENCHMARK_DEPLOY_FIXTURE_DB;
if (!path) throw new Error('The deployment fixture requires an isolated SQLite path');
const db = new DatabaseSync(path);
db.exec('PRAGMA busy_timeout = 5000');
const args = process.argv.slice(2);
const flag = name => args[args.indexOf(name) + 1];
const count = kind =>
  Number(db.prepare('SELECT COUNT(*) AS n FROM fixture_events WHERE kind = ?').get(kind).n);
const event = kind =>
  db.prepare('INSERT INTO fixture_events (kind, at) VALUES (?, ?)').run(kind, Date.now());
const assertArguments = () => {
  if (
    !args.includes('--config') ||
    !args.includes('--env') ||
    flag('--env') !== '' ||
    process.env.CI !== '1'
  ) {
    throw new Error(
      'The fixture requires explicit unnamed-environment configuration and noninteractive commands'
    );
  }
};
assertArguments();
const pauseAction = checkpoint => {
  if (process.env.BENCHMARK_DEPLOY_FIXTURE_PAUSE_CHANGE_AT !== checkpoint) return;
  if (count('pause_changed') > 0) return;
  event('pause_changed');
  if (process.env.BENCHMARK_DEPLOY_FIXTURE_PAUSE_CHANGE === 'replace') {
    db.prepare(
      "UPDATE scheduler_dispatch_lock SET token = 'operator-pause-replacement', lease_until = ? WHERE id = 1"
    ).run(Date.now() + 3_000_000_000);
  } else {
    db.exec(
      "UPDATE scheduler_dispatch_lock SET token = NULL, lease_until = 0 WHERE id = 1 AND token LIKE 'operator-pause-%'"
    );
  }
};

try {
  if (args.includes('execute')) {
    if (!args.includes('--remote') || !args.includes('--json') || !args.includes('BENCH_DB')) {
      throw new Error('Unexpected D1 command flags');
    }
    const sql = flag('--command');
    let kind;
    if (sql.startsWith('INSERT INTO scheduler_dispatch_lock')) kind = 'acquire';
    else if (sql.startsWith('UPDATE scheduler_dispatch_lock SET lease_until')) kind = 'renew';
    else if (sql.startsWith('UPDATE scheduler_dispatch_lock SET token = NULL')) kind = 'release';
    else if (sql.startsWith('SELECT token, lease_until FROM scheduler_dispatch_lock'))
      kind = 'owner';
    else if (sql.startsWith('SELECT lease_until FROM scheduler_dispatch_lock'))
      kind = 'verify_pause';
    else if (sql.includes('FROM scheduler_chunks')) kind = 'drain';
    else throw new Error('Unexpected fixture SQL');
    event(kind);
    if (kind === 'drain') {
      pauseAction('drain');
      const after = Number(process.env.BENCHMARK_DEPLOY_FIXTURE_DRAIN_AFTER ?? 0);
      if (after > 0 && count('drain') >= after) {
        db.exec(
          "UPDATE scheduler_chunks SET status = 'completed', slot = NULL, lease_until = 0 WHERE status IN ('queued', 'active')"
        );
      }
      const lock = db.prepare('SELECT lease_until FROM scheduler_dispatch_lock WHERE id = 1').get();
      if (!lock || lock.lease_until <= Date.now()) event('drain_without_lease');
    }
    if (
      kind === 'verify_pause' &&
      count('deploy_started') > 0 &&
      count('deploy_completed') === 0 &&
      count('deploy_aborted') === 0
    ) {
      pauseAction('deploy');
    }
    let output = 'result';
    if (kind === 'renew') {
      const loseAt = Number(process.env.BENCHMARK_DEPLOY_FIXTURE_LOSE_ON_RENEW ?? 0);
      const duringDeploy =
        count('deploy_started') > 0 &&
        process.env.BENCHMARK_DEPLOY_FIXTURE_LOSE_DURING_DEPLOY === '1';
      if ((loseAt > 0 && count('renew') === loseAt) || duringDeploy) {
        db.prepare(
          "UPDATE scheduler_dispatch_lock SET token = 'replacement-owner', lease_until = ? WHERE id = 1"
        ).run(Date.now() + 60_000);
      }
      const delay = Number(process.env.BENCHMARK_DEPLOY_FIXTURE_RENEW_DELAY_MS ?? 0);
      if (delay > 0 && count('deploy_started') > 0) await sleep(delay);
      const transient = Number(
        process.env.BENCHMARK_DEPLOY_FIXTURE_RENEW_FAILURES_DURING_DEPLOY ?? 0
      );
      if (count('deploy_started') > 0 && count('renew_transient') < transient) {
        event('renew_transient');
        output = count('renew_transient') % 2 === 1 ? 'failure' : 'malformed';
      }
    }
    if (process.env.BENCHMARK_DEPLOY_FIXTURE_BAD_JSON === kind) output = 'malformed';
    if (output === 'failure') {
      process.stderr.write('untrusted-stderr-canary');
      process.exitCode = 1;
    } else if (output === 'malformed') {
      process.stdout.write('untrusted-response-canary');
    } else {
      const results = db.prepare(sql).all();
      process.stdout.write(JSON.stringify([{ success: true, results }]));
    }
  } else if (args.includes('migrations')) {
    if (
      !args.includes('apply') ||
      !args.includes('BENCH_DB') ||
      !args.includes('--remote') ||
      args.includes('--yes')
    ) {
      throw new Error('Unexpected migration flags');
    }
    const lock = db
      .prepare('SELECT token, lease_until FROM scheduler_dispatch_lock WHERE id = 1')
      .get();
    const live = db
      .prepare("SELECT COUNT(*) AS n FROM scheduler_chunks WHERE status IN ('queued', 'active')")
      .get();
    if (!lock?.token || lock.lease_until <= Date.now() || live.n !== 0)
      event('unguarded_migrations');
    event('migrations');
    pauseAction('migrations');
    if (process.env.BENCHMARK_DEPLOY_FIXTURE_MIGRATION_FAIL === '1') {
      process.stderr.write('untrusted-stderr-canary');
      process.exitCode = 1;
    }
    if (process.env.BENCHMARK_DEPLOY_FIXTURE_LOSE_AFTER_MIGRATION === '1') {
      db.prepare(
        "UPDATE scheduler_dispatch_lock SET token = 'replacement-owner', lease_until = ? WHERE id = 1"
      ).run(Date.now() + 60_000);
    }
  } else if (args.includes('deploy')) {
    const lock = db
      .prepare('SELECT token, lease_until FROM scheduler_dispatch_lock WHERE id = 1')
      .get();
    const live = db
      .prepare("SELECT COUNT(*) AS n FROM scheduler_chunks WHERE status IN ('queued', 'active')")
      .get();
    if (!lock?.token || lock.lease_until <= Date.now() || live.n !== 0 || count('migrations') !== 1)
      event('unguarded_deploy');
    event('deploy_started');
    process.stdout.write('untrusted-stdout-canary');
    process.stderr.write('untrusted-stderr-canary');
    const onSignal = () => {
      event('deploy_aborted');
      db.close();
      process.exit(1);
    };
    process.on('SIGTERM', onSignal);
    await sleep(Number(process.env.BENCHMARK_DEPLOY_FIXTURE_DEPLOY_MS ?? 0));
    process.off('SIGTERM', onSignal);
    if (process.env.BENCHMARK_DEPLOY_FIXTURE_DEPLOY_FAIL === '1') {
      event('deploy_failed');
      process.exitCode = 1;
    } else {
      event('deploy_completed');
      pauseAction('after_deploy');
      if (process.env.BENCHMARK_DEPLOY_FIXTURE_LOSE_AFTER_DEPLOY === '1') {
        db.prepare(
          "UPDATE scheduler_dispatch_lock SET token = 'replacement-owner', lease_until = ? WHERE id = 1"
        ).run(Date.now() + 60_000);
      }
    }
  } else {
    throw new Error('Unexpected fixture command');
  }
} finally {
  db.close();
}
