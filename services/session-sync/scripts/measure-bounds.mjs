import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

// Run from services/session-sync after installing dependencies. This never
// deploys a Worker or connects to Cloudflare; fixtures use wrangler.test.jsonc.
const inspectorPort = Number(process.env.SESSION_SYNC_INSPECTOR_PORT ?? 9238);
const rows = [];
let socket;
let requestID = 0;
const pending = new Map();
let current;
let sampler;
let sampling = false;
let child;

function command(method, params = {}) {
  const id = ++requestID;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Inspector timed out: ${method}`));
    }, 10_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function connect() {
  if (socket) return;
  const response = await fetch(`http://127.0.0.1:${inspectorPort}/json/list`);
  assert(response.ok, 'Inspector target discovery failed');
  const targets = await response.json();
  const target = targets.find(
    item => item.id?.includes('vitest') || item.title?.includes('vitest')
  );
  assert(
    target?.webSocketDebuggerUrl,
    `No Workers-pool inspector target: ${JSON.stringify(targets)}`
  );
  socket = new WebSocket(target.webSocketDebuggerUrl);
  socket.addEventListener('message', event => {
    const reply = JSON.parse(String(event.data));
    const entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id);
    clearTimeout(entry.timer);
    if (reply.error) entry.reject(new Error(JSON.stringify(reply.error)));
    else entry.resolve(reply.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  await command('Profiler.enable');
  await command('Profiler.setSamplingInterval', { interval: 100 });
}

async function sample() {
  const heap = await command('Runtime.getHeapUsage');
  current.peakUsedHeapBytes = Math.max(current.peakUsedHeapBytes, heap.usedSize);
  current.peakTotalHeapBytes = Math.max(current.peakTotalHeapBytes, heap.totalSize);
  current.heapSamples++;
}

async function start(name) {
  assert(!current, 'Measurements must not overlap');
  await connect();
  await command('HeapProfiler.collectGarbage');
  current = { name, peakUsedHeapBytes: 0, peakTotalHeapBytes: 0, heapSamples: 0 };
  await sample();
  current.baselineUsedHeapBytes = current.peakUsedHeapBytes;
  current.baselineTotalHeapBytes = current.peakTotalHeapBytes;
  await command('Profiler.start');
  sampling = true;
  sampler = (async () => {
    while (sampling) {
      await sample();
      await sleep(5);
    }
  })();
}

async function stop() {
  assert(current, 'No active measurement');
  sampling = false;
  await sampler;
  await sample();
  const { profile } = await command('Profiler.stop');
  const names = new Map(profile.nodes.map(node => [node.id, node.callFrame.functionName]));
  let activeUs = 0;
  for (let index = 0; index < (profile.samples?.length ?? 0); index++) {
    if (names.get(profile.samples[index]) !== '(idle)') activeUs += profile.timeDeltas[index];
  }
  const row = {
    ...current,
    incrementalUsedHeapBytes: current.peakUsedHeapBytes - current.baselineUsedHeapBytes,
    sampledCpuMs: activeUs / 1000,
    profileWindowMs: (profile.endTime - profile.startTime) / 1000,
  };
  assert(
    row.incrementalUsedHeapBytes < 32 * 1024 * 1024,
    'Boundary fixture added at least 32 MiB sampled heap'
  );
  rows.push(row);
  console.log(`BOUNDS_MEASUREMENT ${JSON.stringify(row)}`);
  current = undefined;
}

const server = createServer(async (request, response) => {
  try {
    if (request.url?.startsWith('/start/')) await start(request.url.slice('/start/'.length));
    else if (request.url === '/stop') await stop();
    else throw new Error('Unknown measurement endpoint');
    response.writeHead(200).end('ok');
  } catch (error) {
    console.error(error);
    response.writeHead(500).end(String(error));
  }
});

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  child = spawn(
    './node_modules/.bin/vitest',
    [
      'run',
      '--no-file-parallelism',
      '--testTimeout=60000',
      `--inspect=127.0.0.1:${inspectorPort}`,
      'test/integration/large-entity.test.ts',
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, SESSION_SYNC_MEASURE_URL: `http://127.0.0.1:${address.port}` },
    }
  );
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 0, 'Workers-pool bounds tests failed');
  assert(rows.length >= 9, 'Every boundary scenario must be measured');
  console.log(
    JSON.stringify(
      {
        runtime: 'local workerd Workers test pool',
        cpu: '100us sampled whole-isolate active CPU, including test/RPC overhead, excluding idle samples',
        memory:
          '5ms sampled V8 used/total heap high-water observations, including pool fixtures; not exact instantaneous peak, process RSS, or production billing metrics',
        rows,
      },
      null,
      2
    )
  );
} finally {
  sampling = false;
  if (sampler) await sampler.catch(() => {});
  if (child && child.exitCode === null) child.kill('SIGTERM');
  socket?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
