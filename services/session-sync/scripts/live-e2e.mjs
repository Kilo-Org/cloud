import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';

// This proof deliberately uses only the local, synthetic wrangler.test.jsonc.
// It never exchanges a real credential, connects to PostgreSQL, or contacts production.
const cwd = fileURLToPath(new URL('..', import.meta.url));
const port = 18817;
const origin = `http://127.0.0.1:${port}`;
const secret = 'session-sync-test-secret-0123456789abcdef';
const userID = `relay-e2e-${crypto.randomUUID()}`;
const tenant = { type: 'user', id: userID };
const sessionID = `ses_${crypto.randomUUID().replaceAll('-', '')}`;
const sourceID = crypto.randomUUID();
const storage = await mkdtemp(join(tmpdir(), 'session-relay-e2e-'));
const sockets = [];
let assertions = 0;
const check = (actual, expected) => {
  assert.deepEqual(actual, expected);
  assertions++;
};

async function grant(expiresIn = 300) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ version: 1, tenant, env: 'development' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('session-sync')
    .setAudience('session-sync')
    .setSubject(userID)
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn)
    .sign(new TextEncoder().encode(secret));
}
async function request(path, method = 'GET', value, expectedStatus) {
  const response = await fetch(`${origin}/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${await grant()}`, 'content-type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  const json = await response.json();
  if (expectedStatus !== undefined) check(response.status, expectedStatus);
  assert(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(json)}`);
  return json;
}
async function ticket(role, presence = false) {
  return request(presence ? '/presence/ticket' : `/sessions/${sessionID}/live-ticket`, 'POST', {
    role,
  });
}
async function socket(role, presence = false) {
  const auth = await ticket(role, presence);
  const url = new URL(
    presence ? `${origin}/v1/presence` : `${origin}/v1/sessions/${sessionID}/live`
  );
  url.protocol = 'ws:';
  const selectedProtocol = `kilo-session-ticket.${auth.ticket}`;
  const ws = new WebSocket(url, [selectedProtocol]);
  sockets.push(ws);
  const queue = [];
  const pending = [];
  ws.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data));
    const index = pending.findIndex(waiter => waiter.predicate(frame));
    if (index < 0) queue.push(frame);
    else pending.splice(index, 1)[0].resolve(frame);
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  check(ws.protocol, selectedProtocol);
  const next = (type, predicate = () => true) => {
    const matches = frame => frame.type === type && predicate(frame);
    const index = queue.findIndex(matches);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = pending.indexOf(waiter);
        if (index >= 0) pending.splice(index, 1);
        reject(
          new Error(
            `Timed out waiting for ${role}/${presence ? 'presence' : 'relay'} ${type}; queued: ${JSON.stringify(queue)}`
          )
        );
      }, 10_000);
      const waiter = {
        predicate: matches,
        resolve: frame => {
          clearTimeout(timeout);
          resolve(frame);
        },
      };
      pending.push(waiter);
    });
  };
  return { ws, next, send: value => ws.send(JSON.stringify(value)) };
}

const server = spawn(
  join(cwd, 'node_modules/.bin/wrangler'),
  [
    'dev',
    '--config',
    'wrangler.test.jsonc',
    '--local',
    '--port',
    String(port),
    '--ip',
    '127.0.0.1',
    '--persist-to',
    storage,
  ],
  {
    cwd,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);
let output = '';
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Wrangler not ready: ${output}`)), 60_000);
    const data = chunk => {
      output += chunk.toString();
      if (output.includes(`127.0.0.1:${port}`) && output.includes('Ready')) {
        clearTimeout(timeout);
        resolve();
      }
    };
    server.stdout.on('data', data);
    server.stderr.on('data', data);
    server.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Wrangler exited ${code}: ${output}`));
    });
  });
  const presenceRunner = await socket('runner', true);
  const presenceViewer = await socket('viewer', true);
  const instanceID = crypto.randomUUID();
  const advertisement = {
    name: 'synthetic-runner',
    projectName: 'relay-proof',
    version: 'test',
    kind: 'cli',
    startedAt: Date.now(),
    gitBranch: 'test',
    capabilities: ['send_message', 'create_session', 'list_directories'],
    sessions: [sessionID],
  };
  presenceRunner.send({ type: 'heartbeat', instanceID, advertisement });
  presenceViewer.send({ type: 'subscribe' });
  const instances = await presenceViewer.next('instances', frame =>
    frame.body.instances.some(instance => instance.instanceID === instanceID)
  );
  check(
    instances.body.instances.some(instance => instance.online),
    true
  );
  const presenceController = await socket('controller', true);
  const createID = crypto.randomUUID();
  presenceController.send({
    channel: 'commands',
    type: 'create_session',
    commandID: createID,
    instanceID,
    body: { projectName: 'relay-proof' },
  });
  const create = await presenceRunner.next('create_session');
  check(create.body.commandID, createID);
  const registered = await request(`/sessions/${sessionID}`, 'PUT', { version: 1, sourceID });
  check(registered.creatorID, userID);
  presenceRunner.send({ type: 'reply', commandID: createID, body: { sessionID, created: true } });
  const created = await presenceController.next(
    'reply',
    frame => frame.body.commandID === createID
  );
  check(created.body.payload, { sessionID, created: true });
  const directoryID = crypto.randomUUID();
  const directoriesResponse = request(`/presence/instances/${instanceID}/commands`, 'POST', {
    type: 'list_directories',
    commandID: directoryID,
    body: { path: '.' },
  });
  const directories = await presenceRunner.next('list_directories');
  check(directories.body.commandID, directoryID);
  presenceRunner.send({ type: 'reply', commandID: directoryID, body: { directories: ['.'] } });
  check(await directoriesResponse, {
    commandID: directoryID,
    instanceID,
    status: 'replied',
    body: { directories: ['.'] },
  });
  const unansweredID = crypto.randomUUID();
  const unanswered = request(
    `/presence/instances/${instanceID}/commands`,
    'POST',
    {
      type: 'list_models',
      commandID: unansweredID,
    },
    202
  );
  await presenceRunner.next('list_models');
  check(await unanswered, { commandID: unansweredID, instanceID, status: 'unknown' });
  const viewer = await socket('viewer');
  const hello = await viewer.next('hello');
  check(hello.body.reconnectAfterMs >= 1000 && hello.body.reconnectAfterMs <= 60_000, true);
  viewer.send({ type: 'subscribe', afterSeq: hello.seq });
  const watched = await presenceRunner.next('watch', frame => frame.body.watching);
  check(watched.body.sessionID, sessionID);
  const controller = await socket('controller');
  const commandID = crypto.randomUUID();
  controller.send({
    channel: 'commands',
    type: 'send_message',
    commandID,
    body: { text: 'offline synthetic command' },
  });
  check(
    (await controller.next('command_status', frame => frame.body.commandID === commandID)).body
      .status,
    'queued'
  );
  const rejectID = crypto.randomUUID();
  controller.send({
    channel: 'commands',
    type: 'interrupt',
    commandID: rejectID,
    liveOnly: true,
    body: {},
  });
  const rejection = await controller.next('error');
  check(typeof rejection.body.code, 'string');
  const runner = await socket('runner');
  const queued = await runner.next('send_message', frame => frame.body.commandID === commandID);
  check(queued.body.payload.text, 'offline synthetic command');
  runner.send({ type: 'ack', commandID });
  check(
    (
      await controller.next(
        'command_status',
        frame => frame.body.commandID === commandID && frame.body.status === 'delivered'
      )
    ).body.status,
    'delivered'
  );
  check((await request(`/sessions/${sessionID}/commands/${commandID}`)).status, 'delivered');
  runner.send({
    channel: 'events',
    type: 'text.delta',
    body: { text: 'synthetic live delta', syncPosition: 0 },
  });
  const event = await viewer.next('text.delta');
  check(event.body, { text: 'synthetic live delta', syncPosition: 0 });
  check(
    { v: event.v, channel: event.channel, from: event.from },
    { v: 1, channel: 'events', from: userID }
  );
  check(Number.isSafeInteger(event.seq) && event.seq > hello.seq, true);
  const resume = await socket('viewer');
  resume.send({ type: 'subscribe', afterSeq: event.seq - 1 });
  check((await resume.next('text.delta')).seq, event.seq);
  const repeated = [];
  const repeatedDone = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Repeat subscribe did not finish: ${JSON.stringify(repeated)}`)),
      10_000
    );
    viewer.ws.addEventListener('message', function listener(message) {
      const frame = JSON.parse(String(message.data));
      repeated.push(frame);
      if (frame.type !== 'subscribed') return;
      clearTimeout(timeout);
      viewer.ws.removeEventListener('message', listener);
      resolve();
    });
    viewer.send({ type: 'subscribe', afterSeq: event.seq - 1 });
  });
  await repeatedDone;
  check(
    repeated.map(frame => frame.channel),
    ['control']
  );
  check(
    repeated.map(frame => frame.type),
    ['subscribed']
  );
  check(
    repeated.map(frame => frame.seq),
    [event.seq]
  );
  check(
    repeated.map(frame => frame.body),
    [{ seq: event.seq, cursor: event.seq }]
  );
  runner.send({
    channel: 'events',
    type: 'text.delta',
    body: { text: 'second synthetic delta', syncPosition: 1 },
  });
  const second = await viewer.next('text.delta', frame => frame.body.syncPosition === 1);
  check(second.seq, event.seq + 1);
  const catchingUp = await socket('viewer');
  const replayed = [];
  const caughtUp = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Catch-up subscribe did not finish: ${JSON.stringify(replayed)}`)),
      10_000
    );
    catchingUp.ws.addEventListener('message', function listener(message) {
      const frame = JSON.parse(String(message.data));
      if (frame.channel === 'events') replayed.push(frame);
      if (frame.type !== 'subscribed') return;
      clearTimeout(timeout);
      catchingUp.ws.removeEventListener('message', listener);
      resolve();
    });
    catchingUp.send({ type: 'subscribe', afterSeq: event.seq });
  });
  await caughtUp;
  check(
    replayed.map(frame => frame.seq),
    [event.seq + 1]
  );
  const httpID = crypto.randomUUID();
  const submitted = await request(`/sessions/${sessionID}/commands`, 'POST', {
    channel: 'commands',
    type: 'send_message',
    commandID: httpID,
    body: { text: 'HTTP shared handler' },
  });
  check(submitted.status, 'delivered');
  check(
    (await runner.next('send_message', frame => frame.body.commandID === httpID)).body.payload.text,
    'HTTP shared handler'
  );
  runner.send({ type: 'ack', commandID: httpID });
  const oldRunnerClosed = new Promise(resolve =>
    runner.ws.addEventListener('close', resolve, { once: true })
  );
  const replacement = await socket('runner');
  check((await oldRunnerClosed).code, 4009);
  const renewed = await ticket('runner');
  replacement.send({ type: 'reauth', ticket: renewed.ticket });
  const reauthorized = await replacement.next('reauthorized');
  check(typeof reauthorized.body.expiresAt, 'string');
  const listing = await request('/sessions');
  check(listing.items.find(item => item.sessionID === sessionID)?.live, true);
  viewer.ws.close();
  resume.ws.close();
  catchingUp.ws.close();
  controller.ws.close();
  check((await presenceRunner.next('watch', frame => !frame.body.watching)).body.watching, false);
  console.log(
    JSON.stringify({
      result: 'PASS',
      assertions,
      transport: 'real WebSocket',
      runtime: 'wrangler dev --local',
      syntheticOnly: true,
    })
  );
} finally {
  for (const ws of sockets) ws.close();
  server.kill('SIGTERM');
  await new Promise(resolve => {
    if (server.exitCode !== null) resolve();
    else server.once('exit', resolve);
  });
  await rm(storage, { recursive: true, force: true });
}
