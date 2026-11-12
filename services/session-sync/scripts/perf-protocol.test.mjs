import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { grant, session } from './perf-common.mjs';
import { assertGeneratorExits } from './perf-control.mjs';

test('controller reports child exit codes and signals before summary reads', () => {
  assert.doesNotThrow(() => assertGeneratorExits([{ role: 'sdk', code: 0 }]));
  assert.throws(
    () => assertGeneratorExits([{ role: 'sdk', file: 'config.json', code: 17 }]),
    /Generator exit failure:.*"role":"sdk".*"code":17/
  );
  assert.throws(
    () => assertGeneratorExits([{ role: 'producer', code: null, signal: 'SIGKILL' }]),
    /Generator exit failure:.*SIGKILL/
  );
  assert.throws(
    () => assertGeneratorExits([{ role: 'raw', error: 'spawn failed' }]),
    /Generator exit failure:.*spawn failed/
  );
});

test(
  'synthetic relay validates grants, heartbeat scope and consumed expiring renewal tickets',
  { timeout: 20000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-protocol-'));
    const secret = 'synthetic-protocol-test-signing-key';
    const keysFile = join(root, 'keys.json');
    const configFile = join(root, 'config.json');
    writeFileSync(keysFile, JSON.stringify({ SESSION_SYNC_SECRET: secret }), { mode: 0o600 });
    writeFileSync(
      configFile,
      JSON.stringify({
        root,
        keysFile,
        baseURL: 'http://127.0.0.1:0/',
        mode: 'local',
        audience: 'development',
        stopAt: Date.now() + 18000,
      })
    );
    const relay = fork(fileURLToPath(new URL('./perf-relay.mjs', import.meta.url)), [configFile], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv: [
        ...process.execArgv,
        '--import',
        'data:text/javascript,' +
          encodeURIComponent(`
            const realNow = Date.now.bind(Date);
            let offset = 0;
            Date.now = () => realNow() + offset;
            process.on('message', message => {
              if (message?.type !== 'test-clock') return;
              offset = message.offset;
              process.send({ type: 'test-clock', offset });
            });
          `),
      ],
    });
    const exited = once(relay, 'exit');
    const sockets = [];
    let logs = '';
    relay.stderr.on('data', chunk => {
      logs += chunk;
    });
    try {
      const port = await new Promise((resolve, reject) => {
        let output = '';
        relay.stdout.on('data', chunk => {
          output += chunk;
          const match = /LOCAL_RELAY_READY (\d+)/.exec(output);
          if (match) resolve(Number(match[1]));
        });
        relay.once('exit', () => reject(Error(`Relay exited: ${logs}`)));
      });
      const setClock = async offset => {
        const acknowledged = once(relay, 'message');
        relay.send({ type: 'test-clock', offset });
        assert.deepEqual((await acknowledged)[0], { type: 'test-clock', offset });
      };
      const baseURL = `http://127.0.0.1:${port}`;
      const a = session({ runID: 'protocol' }, 0);
      const b = session({ runID: 'protocol' }, 1);
      const token = (s, ttl = 300, key = secret, env = 'development') =>
        grant(s, key, env, undefined, ttl);
      const request = async (s, path, body, bearer = token(s), method = 'POST') =>
        fetch(baseURL + path, {
          method,
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      const mint = async (s, role = 'runner', presence = true, ttl = 300) => {
        const response = await request(
          s,
          presence ? '/v1/presence/ticket' : `/v1/sessions/${s.id}/live-ticket`,
          { role },
          token(s, ttl)
        );
        assert.equal(response.status, 200);
        return response.json();
      };
      const connect = async (s, ticket, presence = true) => {
        const socket = new WebSocket(
          baseURL.replace('http:', 'ws:') +
            (presence ? '/v1/presence' : `/v1/sessions/${s.id}/live`),
          ['kilo-session-ticket.' + ticket.ticket]
        );
        sockets.push(socket);
        const closed = new Promise(resolve => socket.once('close', (...args) => resolve(args)));
        const frames = [];
        socket.on('message', data => frames.push(JSON.parse(data.toString())));
        socket.on('error', () => {});
        const next = async type => {
          const until = Date.now() + 3000;
          while (Date.now() < until) {
            const index = frames.findIndex(frame => frame.type === type);
            if (index >= 0) return frames.splice(index, 1)[0];
            await sleep(5);
          }
          throw Error(`Missing ${type}: ${JSON.stringify(frames)}`);
        };
        await next('hello');
        return { socket, closed, next, send: body => socket.send(JSON.stringify(body)) };
      };
      for (const s of [a, b])
        assert.equal(
          (await request(s, `/v1/sessions/${s.id}`, { sourceID: s.source }, token(s), 'PUT'))
            .status,
          200
        );
      for (const bearer of [
        token(a, 300, 'wrong-signing-key'),
        token(a, 300, secret, 'staging'),
        token(a, -1),
      ])
        assert.equal(
          (await request(a, '/v1/presence/ticket', { role: 'runner' }, bearer)).status,
          401
        );
      const runner = await connect(a, await mint(a));
      const advertisement = {
        name: 'synthetic',
        projectName: 'synthetic-load',
        version: 'test',
        kind: 'cli',
        startedAt: Date.now(),
        gitBranch: null,
        capabilities: ['native-live-v1'],
        sessions: [a.id],
      };
      const heartbeat = { type: 'heartbeat', instanceID: 'test', advertisement };
      const { projectName, ...incomplete } = advertisement;
      assert.equal(projectName, 'synthetic-load');
      runner.send({ ...heartbeat, advertisement: incomplete });
      assert.equal((await runner.next('error')).body.code, 'invalid_request');
      runner.send({ ...heartbeat, advertisement: { ...advertisement, sessions: [b.id] } });
      assert.equal((await runner.next('error')).body.code, 'invalid_request');
      runner.send(heartbeat);
      assert.equal((await runner.next('watch')).body.watching, false);
      const viewer = await connect(a, await mint(a, 'viewer', false), false);
      assert.equal((await runner.next('watch')).body.watching, true);
      viewer.socket.close();
      assert.equal((await runner.next('watch')).body.watching, false);
      const renewal = await mint(a);
      runner.send({ type: 'reauth', ticket: renewal.ticket });
      assert.equal((await runner.next('reauthorized')).body.expiresAt, renewal.expiresAt);
      runner.send({ type: 'reauth', ticket: renewal.ticket });
      assert.equal((await runner.next('error')).body.code, 'invalid_ticket');
      for (const next of [
        await mint(b),
        await mint(a, 'viewer'),
        await mint(a, 'runner', false),
        { ticket: 'invalid' },
      ]) {
        const connection = await connect(a, await mint(a));
        connection.send({ type: 'reauth', ticket: next.ticket });
        assert.equal((await connection.next('error')).body.code, 'invalid_ticket');
        connection.socket.close();
      }
      const expired = await mint(a, 'runner', true, 1);
      await sleep(Math.max(0, Date.parse(expired.expiresAt) - Date.now()) + 30);
      const connection = await connect(a, await mint(a));
      connection.send({ type: 'reauth', ticket: expired.ticket });
      assert.equal((await connection.next('error')).body.code, 'invalid_ticket');
      const late = await connect(a, await mint(a));
      await setClock(121000);
      const replacement = await mint(a);
      late.send({ type: 'reauth', ticket: replacement.ticket });
      assert.equal((await late.next('error')).body.code, 'invalid_ticket');
      assert.equal((await late.closed)[0], 1008);
      const fresh = await connect(a, replacement);
      fresh.socket.close();
      await fresh.closed;
      await setClock(0);
      const expiring = await connect(a, await mint(a, 'runner', true, 5));
      assert.equal((await expiring.closed)[0], 1008);
    } finally {
      for (const socket of sockets) socket.terminate();
      if (relay.connected) relay.disconnect();
      relay.kill('SIGTERM');
      await exited;
      const stats = JSON.parse(readFileSync(join(root, 'relay.json'), 'utf8'));
      rmSync(root, { recursive: true, force: true });
      assert.equal(stats.ticketsRemaining, 0);
    }
  }
);

async function socketFailureResult(scenario) {
  const root = mkdtempSync(join(tmpdir(), 'sync-socket-failure-'));
  const configFile = join(root, 'config.json');
  const nativeModule = join(root, 'native.mjs');
  const config = {
    root,
    nativeModule,
    keysFile: join(root, 'keys.json'),
    runID: 'socket-failure',
    mode: 'local',
    baseURL: 'http://127.0.0.1:9/',
    audience: 'development',
    shard: 0,
    shards: 1,
    sessions: 1,
    streamingSources: 1,
    sourceTrafficMode: 'all-streaming-sources',
    watched: 1,
    warmSeconds: 1,
    measuredSeconds: 1,
    drainSeconds: 1,
    eventHz: 1,
    requestConcurrency: 65,
    maxRequests: 10,
    pendingLimit: 10,
    pendingTTLms: 1000,
    grantTTLseconds: 300,
    startAt: Date.now() + 3000,
    stopAt: Date.now() + 10000,
  };
  writeFileSync(configFile, JSON.stringify(config));
  writeFileSync(config.keysFile, JSON.stringify({ SESSION_SYNC_SECRET: 'synthetic-signing-key' }), {
    mode: 0o600,
  });
  writeFileSync(join(root, 'sessions-0.json'), JSON.stringify([session(config, 0)]));
  writeFileSync(
    join(root, 'window.json'),
    JSON.stringify({
      runID: config.runID,
      startAt: config.startAt,
      warmUntil: config.startAt + 1000,
      sendUntil: config.startAt + 2000,
      drainAt: config.startAt + 3000,
    })
  );
  writeFileSync(
    nativeModule,
    `export class RemoteSocket {
      constructor(options) { this.options = options; this.connected = false; }
      async start() {
        const ticket = await this.options.ticket();
        this.wire = new this.options.socket(this.options.url, {
          headers: { Authorization: 'Bearer ' + ticket.ticket }
        });
        this.wire.addEventListener('open', () => {
          this.connected = true;
          this.options.onState(true);
        });
        this.wire.addEventListener('error', () => this.disconnect(1011));
      }
      disconnect(internalCode) {
        this.internalCode = internalCode;
        this.connected = false;
        this.options.onState(false);
        this.wire.close(1000);
      }
      send() { return true; }
      stop() { this.wire?.close(1000); }
    }`
  );
  const loadURL = new URL('./perf-load.mjs', import.meta.url);
  const commonURL = new URL('./perf-common.mjs', import.meta.url).href;
  // Isolate diagnostics from source-pin validation, without exporting production internals.
  const commonFixture =
    'data:text/javascript,' +
    encodeURIComponent(`
    export * from ${JSON.stringify(commonURL)};
    import { readFileSync } from 'node:fs';
    export const readConfig = path => JSON.parse(readFileSync(path, 'utf8'));
  `);
  const preload = `
    import { registerHooks } from 'node:module';
    registerHooks({
      resolve(specifier, context, next) {
        if (specifier === './perf-common.mjs' && context.parentURL === ${JSON.stringify(loadURL.href)})
          return { url: ${JSON.stringify(commonFixture)}, shortCircuit: true };
        return next(specifier, context);
      }
    });
    const scenario = ${JSON.stringify(scenario)};
    const dispatch = (socket, type, fields = {}) => {
      const event = new Event(type);
      for (const [key, value] of Object.entries(fields))
        Object.defineProperty(event, key, { value });
      socket.dispatchEvent(event);
    };
    globalThis.fetch = async url => {
      if (!new URL(url).pathname.endsWith('ticket')) throw Error('Unexpected fixture request');
      return Response.json({ ticket: 'synthetic-ticket', expiresAt: new Date(Date.now() + 60000).toISOString() });
    };
    globalThis.WebSocket = class extends EventTarget {
      readyState = 0;
      constructor(url) {
        super();
        queueMicrotask(() => { this.readyState = 1; dispatch(this, 'open'); });
        if (scenario.benignOtherClose &&
            (new URL(url).pathname === '/v1/presence') !== scenario.presence)
          setTimeout(() => dispatch(this, 'close', {
            code: 1000, wasClean: true, reason: 'benign startup close'
          }), 0);
        if ((new URL(url).pathname === '/v1/presence') === scenario.presence)
          setTimeout(() => {
            for (let index = 0; index < 128; index++)
              dispatch(this, 'error', {
                message: 'unused-event-secret',
                error: {
                  message: index ? 'later failure ' + index : scenario.message,
                  code: scenario.errorCode,
                  cause: { code: scenario.causeCode, private: 'unused-cause-secret' },
                  stack: 'unused-stack-secret'
                }
              });
          }, Math.max(0, ${config.startAt - 100} - Date.now()));
      }
      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        dispatch(this, 'close', scenario.close);
        dispatch(this, 'close', { code: 4999, wasClean: true, reason: 'later close' });
      }
    };
  `;
  const child = fork(fileURLToPath(loadURL), ['producer', configFile], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    execArgv: [
      ...process.execArgv,
      '--import',
      'data:text/javascript,' + encodeURIComponent(preload),
    ],
  });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', chunk => {
    output += chunk;
  });
  child.stderr.on('data', chunk => {
    output += chunk;
  });
  try {
    const [code, signal] = await exited;
    assert.equal(code, 1, output);
    assert.equal(signal, null, output);
    return {
      result: JSON.parse(readFileSync(join(root, 'result-producer-0.json'), 'utf8')),
      output,
    };
  } finally {
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }
}

test(
  'socket failure report retains bounded sanitized first native events',
  { timeout: 20000 },
  async () => {
    const secrets = [
      'url-secret',
      'protocol-secret',
      'ticket-secret',
      'bearer-secret',
      'wire-secret',
      'eyJheader.eyJpayload.jwt-signature',
      'x'.repeat(80),
      'unused-event-secret',
      'unused-cause-secret',
      'unused-stack-secret',
    ];
    const reason =
      'first failure Unexpected server response: 503 ' +
      'https://private.invalid/path?ticket=url-secret protocol="protocol-secret" ' +
      'ticket=ticket-secret Bearer "bearer-secret" kilo-session-ticket.wire-secret ' +
      'eyJheader.eyJpayload.jwt-signature ' +
      'x'.repeat(80) +
      ' diagnostic'.repeat(400);
    const { result, output } = await socketFailureResult({
      presence: true,
      benignOtherClose: true,
      message: reason,
      errorCode: 'UND_ERR_SOCKET',
      causeCode: 'ECONNRESET',
      close: { code: 1006, wasClean: false, reason },
    });
    assert.equal(result.failure, 'unexpected_socket_close');
    assert.equal(result.firstSocketError.httpStatus, 503);
    assert.equal(result.firstSocketError.errorCode, 'UND_ERR_SOCKET');
    assert.equal(result.firstSocketError.causeCode, 'ECONNRESET');
    assert.equal(result.firstSocketClose.nativeCloseCode, 1006);
    for (const event of [result.firstSocketError, result.firstSocketClose]) {
      assert(event.at >= result.started && event.at <= result.finished);
      assert.match(event.reason, /^first failure Unexpected server response: 503 /);
      assert(event.reason.length <= 256);
    }
    const retained = JSON.stringify([result.firstSocketError, result.firstSocketClose]);
    assert(retained.length < 1024);
    for (const secret of secrets) assert(!JSON.stringify({ result, output }).includes(secret));
    assert(!retained.includes('benign startup close'));
    assert(!retained.includes('later failure') && !retained.includes('later close'));
  }
);

test(
  'runner failure context omits unknown codes and unrelated HTTP-like numbers',
  { timeout: 20000 },
  async () => {
    const { result } = await socketFailureResult({
      presence: false,
      message:
        'transport failed after 503 bytes and 401 frames https://private.invalid/status=429 ' +
        'protocol="' +
        'private protocol words '.repeat(200),
      errorCode: 'private-error-code',
      causeCode: 'private-cause-code',
      close: { code: 4009, wasClean: true, reason: 'terminal replacement' },
    });
    assert.equal(result.failure, 'unexpected_socket_close');
    for (const field of ['httpStatus', 'errorCode', 'causeCode'])
      assert.equal(Object.hasOwn(result.firstSocketError, field), false);
    assert(!JSON.stringify(result).includes('private-error-code'));
    assert(!JSON.stringify(result).includes('private-cause-code'));
    assert(!JSON.stringify(result).includes('private protocol words'));
    assert(!JSON.stringify(result).includes('private.invalid'));
  }
);

test(
  'authorization diagnostics conceal short and folded credentials',
  { timeout: 20000 },
  async () => {
    const message =
      'Unexpected server response: 503\nAuthorization: Basic dTpw\n  folded-credential\ntrailing diagnostic';
    const { result, output } = await socketFailureResult({
      presence: true,
      message,
      errorCode: 'UND_ERR_SOCKET',
      close: { code: 1006, wasClean: false, reason: message },
    });
    assert.equal(result.failure, 'unexpected_socket_close');
    assert.equal(result.firstSocketError.httpStatus, 503);
    for (const event of [result.firstSocketError, result.firstSocketClose]) {
      assert(event.reason.includes('Unexpected server response'));
      assert(event.reason.length <= 256);
    }
    const report = JSON.stringify({ result, output });
    assert(!report.includes('dTpw'));
    assert(!report.includes('folded-credential'));
    assert(!report.includes('trailing diagnostic'));
  }
);
