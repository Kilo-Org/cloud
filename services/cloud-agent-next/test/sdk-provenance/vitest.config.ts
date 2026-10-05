import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const sandbox = require.resolve('@cloudflare/sandbox');
const containers = createRequire(sandbox).resolve('@cloudflare/containers');
const versionSchema = z.object({ version: z.string() });
const sandboxPackage = versionSchema.parse(
  JSON.parse(readFileSync(resolve(dirname(sandbox), '../package.json'), 'utf8'))
);
const containersPackage = versionSchema.parse(
  JSON.parse(readFileSync(resolve(dirname(containers), '../package.json'), 'utf8'))
);
console.info('SDK provenance resolution', {
  sandbox,
  containers,
  sandboxVersion: sandboxPackage.version,
  containersVersion: containersPackage.version,
});

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './test/sdk-provenance/worker.ts',
      miniflare: {
        compatibilityDate: '2026-07-21',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: { PROVENANCE_STORAGE: { className: 'ProvenanceStorage', useSQLite: true } },
      },
    }),
  ],
  test: { include: ['test/sdk-provenance/*.test.ts'] },
});
