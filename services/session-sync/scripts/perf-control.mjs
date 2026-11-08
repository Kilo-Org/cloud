import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readConfig, populationMatches } from './perf-common.mjs';

export function assertGeneratorExits(statuses) {
  const failures = statuses.filter(status => status.code !== 0 || status.signal || status.error);
  assert.equal(failures.length, 0, `Generator exit failure: ${JSON.stringify(failures)}`);
}

async function control() {
  const [command, ...files] = process.argv.slice(2);
  assert(
    ['seed', 'run', 'wait', 'summarize'].includes(command) && files.length,
    'Usage: perf-control.mjs seed|run|wait|summarize config.json [...]'
  );
  const configs = files.map(readConfig);
  assert(
    configs.every(config => config.root === configs[0].root && config.runID === configs[0].runID)
  );
  assert.equal(new Set(configs.map(config => config.shard)).size, configs.length);
  if (command === 'run')
    assert(
      configs.every(config => config.mode === 'local'),
      'Cloud runs require the operator cluster controller and live watchdog monitoring'
    );
  const root = configs[0].root;
  const children = [];
  const statuses = [];
  const atomic = (file, value) => {
    writeFileSync(file + '.tmp', JSON.stringify(value));
    renameSync(file + '.tmp', file);
  };
  function spawn(role, file) {
    const child = fork(fileURLToPath(new URL('./perf-load.mjs', import.meta.url)), [role, file], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    children.push(child);
    const status = { role, file, code: undefined, signal: undefined, error: undefined };
    statuses.push(status);
    const result = new Promise(resolve => {
      const finish = () => {
        if (status.code !== 0 || status.signal || status.error)
          for (const peer of children)
            if (peer !== child && peer.exitCode === null && peer.signalCode === null)
              peer.kill('SIGTERM');
        resolve();
      };
      child.once('error', error => {
        status.error = error.message;
        finish();
      });
      child.once('exit', (code, signal) => {
        status.code = code;
        status.signal = signal;
        finish();
      });
    });
    return result;
  }
  async function liveBarrier() {
    while (Date.now() < Math.min(...configs.map(config => config.startAt)) - 2000) {
      if (statuses.some(status => status.code !== undefined || status.error)) {
        assertGeneratorExits(statuses);
        throw Error(`Generator exited before live barrier: ${JSON.stringify(statuses)}`);
      }
      const rows = [];
      for (const config of configs)
        for (const role of ['producer', 'raw', 'sdk']) {
          const path = `${root}/status-${role}-${config.shard}.json`;
          if (existsSync(path)) rows.push(JSON.parse(readFileSync(path, 'utf8')));
        }
      if (rows.some(row => row.failed)) throw Error('Generator failed before live barrier');
      if (
        rows.length === configs.length * 3 &&
        rows.every(row => row.ready && Date.now() - row.at < 1000)
      )
        return rows;
      await sleep(50);
    }
    throw Error('Fresh simultaneous live barrier deadline');
  }
  function summarize() {
    const results = [];
    const sources = new Map();
    for (const config of configs) {
      for (const s of JSON.parse(readFileSync(`${root}/sessions-${config.shard}.json`, 'utf8')))
        sources.set(s.index, s);
      for (const role of ['producer', 'raw', 'sdk'])
        results.push(
          JSON.parse(readFileSync(`${root}/result-${role}-${config.shard}.json`, 'utf8'))
        );
    }
    const issues = [];
    for (const result of results) {
      const owning = configs.find(config => config.shard === result.shard);
      const watchedCount = [...sources.values()].filter(
        s => s.index < owning.watched && s.index % owning.shards === result.shard
      ).length;
      const streamingCount = [...sources.values()].filter(
        s => s.index < owning.streamingSources && s.index % owning.shards === result.shard
      ).length;
      if (
        result.role === 'producer' &&
        [...sources.values()].some(
          s =>
            s.index % owning.shards === result.shard &&
            (s.counter !==
              (s.index < owning.streamingSources
                ? (owning.warmSeconds + owning.measuredSeconds) * owning.eventHz
                : 0) ||
              s.committed !== s.counter)
        )
      )
        issues.push(`producer/${result.shard}:source_schedule_or_durable_prefix`);
      if (
        result.role === 'producer' &&
        (result.checkpoints !==
          result.sessions.length *
            (Math.ceil((owning.warmSeconds + owning.measuredSeconds) / 5) + 1) ||
          result.reconciledReceipts !== result.sessions.length)
      )
        issues.push(`producer/${result.shard}:durable_cadence_or_receipt`);
      if (result.failure) issues.push(`${result.role}/${result.shard}:${result.failure}`);
      if (
        result.skipped ||
        result.projectionFailures ||
        result.resets ||
        result.outOfOrder ||
        result.duplicate ||
        result.afterDrain ||
        result.pending.expired ||
        result.pending.remaining
      )
        issues.push(`${result.role}/${result.shard}:integrity`);
      if (result.role !== 'producer')
        for (const row of result.sessions) {
          const source = sources.get(row.index);
          if (
            !source ||
            row.receivedThrough !== source.counter ||
            row.receivedCount !== source.counter ||
            (result.role === 'sdk' && row.projectedThrough !== source.counter)
          ) {
            const issue = `${result.role}/${result.shard}:source_reconciliation`;
            if (!issues.includes(issue)) issues.push(issue);
          }
        }
      if (result.role !== 'producer') {
        const expectedArrivals = result.sessions.length * owning.eventHz * owning.measuredSeconds;
        if (
          result.measuredReceived !== expectedArrivals ||
          (result.role === 'sdk' && result.callbackLatency.count !== expectedArrivals)
        )
          issues.push(`${result.role}/${result.shard}:fixed_window_arrivals`);
      }
      const measured = result.queue.filter(
        row => row.at >= result.window?.warmUntil && row.at <= result.window?.sendUntil
      );
      if (
        !measured.length ||
        measured.some(row =>
          result.role === 'producer'
            ? !populationMatches(row, {
                presence: result.sessions.length,
                runners: streamingCount,
                streamingSources: streamingCount,
                watched: watchedCount,
              })
            : row.viewers !== result.sessions.length
        )
      )
        issues.push(`${result.role}/${result.shard}:live_population`);
    }
    const config = configs[0];
    const producers = results.filter(result => result.role === 'producer');
    const sum = (rows, field) => rows.reduce((count, row) => count + row[field], 0);
    const expected =
      [...sources.values()].filter(s => s.index < config.streamingSources).length *
      config.eventHz *
      config.measuredSeconds;
    const offered = sum(producers, 'measuredSent');
    if (offered !== expected) issues.push('source_underproduction');
    const summary = {
      version: 1,
      runID: config.runID,
      mode: config.mode,
      disclosure:
        'Local signing at scale; real credential exchange is a separate service smoke. Local relay qualification is not service capacity proof. Callback latency is not UI rendering.',
      pinnedNativeSHA: config.nativeSHA,
      nativeModuleHash: config.nativeModuleHash,
      sdkModuleHash: config.sdkModuleHash,
      instrumentSDK: config.instrumentSDK,
      measuredSeconds: config.measuredSeconds,
      sourceTrafficMode: config.sourceTrafficMode,
      sessions: sources.size,
      streamingSources: [...sources.values()].filter(s => s.index < config.streamingSources).length,
      watched: [...sources.values()].filter(s => s.index < config.watched).length,
      sdkViewers: results
        .filter(result => result.role === 'sdk')
        .reduce((n, result) => n + result.sessions.length, 0),
      viewerConnections: results
        .filter(result => result.role !== 'producer')
        .reduce((n, result) => n + result.sessions.length, 0),
      offeredEventsPerSecond:
        [...sources.values()].filter(s => s.index < config.streamingSources).length *
        config.eventHz,
      expectedMeasuredEvents: expected,
      measuredProducerSends: offered,
      producerRate: offered / config.measuredSeconds,
      rawWireRate:
        sum(
          results.filter(result => result.role === 'raw'),
          'measuredReceived'
        ) / config.measuredSeconds,
      sdkWireRate:
        sum(
          results.filter(result => result.role === 'sdk'),
          'measuredReceived'
        ) / config.measuredSeconds,
      checkpoints: sum(producers, 'checkpoints'),
      reconciledReceipts: sum(producers, 'reconciledReceipts'),
      sourceUnsentEvents:
        config.eventHz *
          (config.warmSeconds + config.measuredSeconds) *
          [...sources.values()].filter(s => s.index < config.streamingSources).length -
        sum(producers, 'sent'),
      durableCommittedPrefixEvents: [...sources.values()]
        .filter(s => s.index < config.streamingSources)
        .reduce((sum, s) => sum + s.committed, 0),
      liveAcknowledgement:
        'RemoteSocket.send is local enqueue, not a server ACK. Per-viewer source reconciliation and durable receipt coverage are separate evidence.',
      missingLocallySentEvents: results
        .filter(result => result.role !== 'producer')
        .reduce(
          (count, result) =>
            count +
            result.sessions.reduce(
              (n, row) =>
                n + Math.max(0, (sources.get(row.index)?.counter ?? 0) - row.receivedCount),
              0
            ),
          0
        ),
      latencyDenominator:
        'Per-process latency histograms include received source-marked measured events before fixed drain. Missing/unsent samples are separate counts, not silently excluded from success.',
      crossProcessClock:
        'Same VM Date.now(); quantization <=1 ms, cross-host offset must be measured before distributed run.',
      issues,
      passed: issues.length === 0,
    };
    atomic(`${root}/summary.json`, summary);
    console.log(JSON.stringify(summary));
    assert(summary.passed, `Qualification failed: ${issues.join(', ')}`);
  }
  try {
    if (command === 'seed') {
      await Promise.all(files.map(file => spawn('seed', file)));
      assertGeneratorExits(statuses);
    }
    if (command === 'run' || command === 'wait') {
      assert(!existsSync(`${root}/window.json`), 'Run directory is single-use');
      const promises = files.flatMap(file =>
        ['producer', 'raw', 'sdk'].map(role => spawn(role, file))
      );
      if (command === 'run') {
        const readiness = await liveBarrier();
        const startAt = Date.now() + 2000;
        const config = configs[0];
        const sendUntil = startAt + (config.warmSeconds + config.measuredSeconds) * 1000;
        const window = {
          runID: config.runID,
          startAt,
          warmUntil: startAt + config.warmSeconds * 1000,
          sendUntil,
          drainAt: sendUntil + config.drainSeconds * 1000,
        };
        assert(window.drainAt < config.stopAt);
        atomic(`${root}/readiness.json`, readiness);
        atomic(`${root}/window.json`, window);
      }
      await Promise.all(promises);
      assertGeneratorExits(statuses);
      summarize();
    }
    if (command === 'summarize') summarize();
  } catch (error) {
    atomic(`${root}/controller-failure.json`, {
      failed: true,
      message: error.message,
      statuses,
    });
    throw error;
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await control();
