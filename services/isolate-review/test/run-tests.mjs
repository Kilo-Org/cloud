import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const workerdPath = require.resolve('workerd/bin/workerd');
const vitestPath = resolve(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');

const child = spawn(process.execPath, [vitestPath, 'run', '--config', 'vitest.workers.config.ts'], {
  env: {
    ...process.env,
    MINIFLARE_WORKERD_PATH: workerdPath,
  },
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  }
  process.exit(code ?? 1);
});
