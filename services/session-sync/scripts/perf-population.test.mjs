import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { populationMatches, session } from './perf-common.mjs';

// Run the actual producer CLI and scheduler against deterministic in-memory I/O.
// No relay, socket, credentials, resource operation or wall-clock load is used.
function producerFixture(runnerLimit = 3) {
  const root = mkdtempSync(join(tmpdir(), 'sync-population-'));
  const now = 1793961200000;
  const config = {
    root,
    runID: 'population-regression',
    mode: 'local',
    baseURL: 'http://127.0.0.1:9/',
    audience: 'development',
    shard: 0,
    shards: 1,
    sessions: 4,
    streamingSources: 3,
    sourceTrafficMode: 'all-streaming-sources',
    watched: 1,
    sdkViewers: 1,
    rawViewers: 0,
    rawCopies: 1,
    eventHz: 10,
    warmSeconds: 1,
    measuredSeconds: 5,
    drainSeconds: 1,
    requestConcurrency: 65,
    maxRequests: 1000,
    pendingLimit: 100,
    pendingTTLms: 1000,
    maxBufferedBytes: 1048576,
    startAt: now + 1000,
    stopAt: now + 60000,
    keysFile: join(root, 'keys.json'),
    nativeModule: join(root, 'native.mjs'),
  };
  const file = join(root, 'config.json');
  writeFileSync(file, JSON.stringify(config));
  writeFileSync(config.keysFile, JSON.stringify({ SESSION_SYNC_SECRET: 'offline-fixture-only' }), {
    mode: 0o600,
  });
  writeFileSync(
    join(root, 'sessions-0.json'),
    JSON.stringify(Array.from({ length: config.sessions }, (_, index) => session(config, index)))
  );
  writeFileSync(
    join(root, 'window.json'),
    JSON.stringify({
      runID: config.runID,
      startAt: config.startAt,
      warmUntil: config.startAt + 1000,
      sendUntil: config.startAt + 6000,
      drainAt: config.startAt + 7000,
    })
  );
  writeFileSync(
    config.nativeModule,
    `export class RemoteSocket {
      constructor(options) { this.options = options; }
      start() {
        const path = new URL(this.options.url).pathname;
        const presence = path === '/v1/presence';
        const index = presence ? undefined : Number(path.split('/')[3].split('_').at(-1));
        this.connected = true;
        this.options.onState(presence || index < ${runnerLimit});
      }
      send(frame) {
        if (frame.type === 'heartbeat') {
          const id = frame.advertisement.sessions[0];
          const index = Number(id.split('_').at(-1));
          this.options.onFrame({ type: 'watch', body: { sessionID: id, watching: index < 1 } });
        } else globalThis.producerFrames.push(frame);
        return true;
      }
      stop() {}
    }`
  );
  const loadURL = new URL('./perf-load.mjs', import.meta.url);
  const commonURL = new URL('./perf-common.mjs', import.meta.url).href;
  const fixtureCommon =
    'data:text/javascript,' +
    encodeURIComponent(`
      export * from ${JSON.stringify(commonURL)};
      import { readFileSync } from 'node:fs';
      export const readConfig = path => JSON.parse(readFileSync(path, 'utf8'));
    `);
  const fixtureTimers =
    'data:text/javascript,' +
    encodeURIComponent('export async function setTimeout(ms) { globalThis.advanceClock(ms); }');
  const preload = `
    import { registerHooks } from 'node:module';
    import { createHash } from 'node:crypto';
    import { writeFileSync } from 'node:fs';
    registerHooks({ resolve(specifier, context, next) {
      if (context.parentURL === ${JSON.stringify(loadURL.href)}) {
        if (specifier === './perf-common.mjs')
          return { url: ${JSON.stringify(fixtureCommon)}, shortCircuit: true };
        if (specifier === 'node:timers/promises')
          return { url: ${JSON.stringify(fixtureTimers)}, shortCircuit: true };
      }
      return next(specifier, context);
    }});
    let now = ${now};
    Date.now = () => now;
    const timers = new Map();
    let nextTimer = 0;
    globalThis.setInterval = (fn, ms) => {
      const id = ++nextTimer;
      timers.set(id, { fn, ms, at: now + ms });
      return id;
    };
    globalThis.setTimeout = (fn, ms) => {
      const id = ++nextTimer;
      timers.set(id, { fn, at: now + ms });
      return id;
    };
    globalThis.clearInterval = globalThis.clearTimeout = id => timers.delete(id);
    globalThis.advanceClock = ms => {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now && timers.has(id)) {
        if (timer.ms) timer.at += timer.ms;
        else timers.delete(id);
        timer.fn();
      }
    };
    globalThis.producerFrames = [];
    process.on('exit', () => writeFileSync(${JSON.stringify(join(root, 'frames.json'))}, JSON.stringify(globalThis.producerFrames)));
    const states = new Map();
    globalThis.fetch = async (url, init) => {
      const parts = new URL(url).pathname.split('/');
      const id = parts[3];
      let state = states.get(id);
      if (!state) states.set(id, state = { position: 0, revision: 0, receipts: new Map() });
      let result;
      if (parts[4] === 'batches') {
        const batch = JSON.parse(init.body);
        result = state.receipts.get(batch.batchID);
        if (!result) {
          state.position = batch.through;
          state.revision++;
          state.entity = batch.changes[0];
          result = {
            version: 1, sessionID: id, batchID: batch.batchID,
            after: batch.after, through: batch.through, changes: batch.changes.length,
            revision: state.revision,
            digest: createHash('sha256').update(JSON.stringify(batch)).digest('hex'),
            committedAt: now,
          };
          state.receipts.set(batch.batchID, result);
        }
      } else if (parts[4] === 'entities') result = { entities: [state.entity] };
      else result = { position: state.position, revision: state.revision };
      return Response.json(result);
    };
  `;
  try {
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'data:text/javascript,' + encodeURIComponent(preload),
        fileURLToPath(loadURL),
        'producer',
        file,
      ],
      { encoding: 'utf8', timeout: 10000 }
    );
    const readArtifact = name => {
      try {
        return JSON.parse(readFileSync(join(root, name), 'utf8'));
      } catch (cause) {
        throw new Error(
          `Producer fixture did not write valid ${name}: ${JSON.stringify({
            status: child.status,
            signal: child.signal,
            error: child.error?.message,
            output: `${child.stdout ?? ''}${child.stderr ?? ''}`.slice(-8000),
          })}`,
          { cause }
        );
      }
    };
    return {
      code: child.status,
      output: child.stdout + child.stderr,
      result: readArtifact('result-producer-0.json'),
      status: readArtifact('status-producer-0.json'),
      frames: readArtifact('frames.json'),
      sessions: readArtifact('sessions-0.json'),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('producer CLI emits every source slot, including unwatched sources, and reconciles all prefixes', () => {
  const { code, output, result, status, frames, sessions } = producerFixture();
  assert.equal(code, 0, output);
  assert.equal(result.sourceTrafficMode, 'all-streaming-sources');
  assert.equal(result.streamingSources, 3);
  assert.equal(result.watchedSessions, 1);
  assert.equal(result.offeredEventsPerSecond, 30);
  assert.equal(result.measuredSent, 150);
  assert.equal(result.warmSent, 30);
  assert.equal(result.sent, 180);
  assert.equal(result.reconciledReceipts, 4);
  assert.equal(status.ready, true);
  assert.equal(status.presence, 4);
  assert.equal(status.runners, 3);
  assert.equal(status.streamingSources, 3);
  assert.equal(status.watched, 1);
  assert.equal(status.viewers, 0, 'Producers never count as viewers');
  for (let index = 0; index < 4; index++) {
    const sourceFrames = frames.filter(frame => frame.body.data.id.startsWith(`${index}:`));
    assert.equal(sourceFrames.length, index < 3 ? 60 : 0);
    assert.deepEqual(
      sourceFrames.map(frame => frame.body.load.sequence),
      Array.from({ length: sourceFrames.length }, (_, n) => n + 1)
    );
    assert(sourceFrames.every(frame => Buffer.byteLength(JSON.stringify(frame.body)) === 512));
    assert.equal(sessions[index].counter, index < 3 ? 60 : 0);
    assert.equal(sessions[index].committed, sessions[index].counter);
  }
});

test('producer readiness and sends reject a missing unwatched runner even when watched/viewer targets are unchanged', () => {
  const { code, result, status } = producerFixture(2);
  assert.equal(code, 1);
  assert.equal(status.ready, false);
  assert.equal(status.watched, 1);
  assert.equal(status.presence, 4);
  assert.equal(status.runners, 2);
  assert.equal(result.failure, 'source_unavailable_or_backpressure');
  assert.equal(
    populationMatches(status, { presence: 4, runners: 3, streamingSources: 3, watched: 1 }),
    false
  );
});
