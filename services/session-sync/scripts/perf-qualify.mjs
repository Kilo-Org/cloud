import { profiles } from './perf-profiles.mjs';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeSHA, sha256 } from './perf-common.mjs';

const [profile, nativeFile, sdkFile, directory, observation = 'plain'] = process.argv.slice(2);
assert(
  [
    'smoke',
    'local2x',
    'raw2x',
    'sdk625',
    'cold',
    'renewal',
    'hot100',
    'slowreader',
    'organization',
  ].includes(profile) &&
    directory &&
    ['plain', 'instrumented'].includes(observation),
  'Usage: perf-qualify.mjs <profile> native-socket.mjs native-sync.ts output-dir [plain|instrumented]'
);
const root = resolve(directory);
mkdirSync(root, { recursive: false, mode: 0o700 });
const shape = profiles[profile];
const config = {
  version: 1,
  mode: 'local',
  runID: `q-${profile}`,
  root,
  baseURL: 'http://127.0.0.1:18829/',
  nativeSHA,
  nativeModule: resolve(nativeFile),
  nativeModuleHash: sha256(readFileSync(nativeFile)),
  sdkModule: resolve(sdkFile),
  sdkModuleHash: sha256(readFileSync(sdkFile)),
  instrumentSDK: observation === 'instrumented',
  keysFile: `${root}/keys.json`,
  ...shape,
  sourceTrafficMode: 'all-streaming-sources',
  shard: 0,
  shards: 1,
  warmSeconds: profile === 'smoke' ? 1 : 10,
  measuredSeconds: profile === 'smoke' ? 5 : 45,
  drainSeconds: profile === 'smoke' ? 2 : 10,
  checkpointSeconds: 5,
  startAt: Date.now() + 180000,
  stopAt: Date.now() + 300000,
  maxRequests: 1000000,
  requestConcurrency: 512,
  pendingLimit: 100000,
  pendingTTLms: 10000,
  maxBufferedBytes: 1048576,
  audience: 'development',
};
writeFileSync(
  config.keysFile,
  JSON.stringify({ SESSION_SYNC_SECRET: 'local-qualification-secret-not-a-real-credential' }),
  { mode: 0o600 }
);
const file = `${root}/config.json`;
writeFileSync(file, JSON.stringify(config, null, 2));
const relay = fork(fileURLToPath(new URL('./perf-relay.mjs', import.meta.url)), [file], {
  stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
});
async function command(mode) {
  const child = fork(fileURLToPath(new URL('./perf-control.mjs', import.meta.url)), [mode, file], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 0, `Qualification ${mode} failed`);
}
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Local relay deadline')), 15000);
    relay.stdout.on('data', chunk => {
      if (chunk.toString().includes('LOCAL_RELAY_READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    relay.once('exit', () => {
      clearTimeout(timer);
      reject(Error('Local relay exited'));
    });
  });
  await command('seed');
  await command('run');
} finally {
  relay.kill('SIGTERM');
}
