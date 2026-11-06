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
