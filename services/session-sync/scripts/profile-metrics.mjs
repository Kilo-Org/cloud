import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Generate isolated variants from the real implementation, not a parallel benchmark copy.
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = `${root}/test/metrics-profile`;
const source = readFileSync(`${root}/src/metrics.ts`, 'utf8').replace(
  "from './env'",
  "from '../../src/env'"
);
const variants = {
  on: source,
  off: source.replace('if (!env.SESSION_SYNC_METRICS)', 'if (true)'),
  noRequestCounting: source.replace(/request\.body\s*&&\s*requestBytes === undefined/, 'false'),
  noResponseWrapping: source.replace(
    'if (!response.body || declaredResponseBytes !== undefined)',
    'if (true)'
  ),
  noErrorClone: source.replace('response.status >= 400 &&', 'false &&'),
  noWriteDataPoint: source.replace('env.SESSION_SYNC_METRICS?.writeDataPoint({', 'void ({'),
};
mkdirSync(directory);
try {
  for (const [name, text] of Object.entries(variants))
    writeFileSync(`${directory}/${name}.ts`, text);
  writeFileSync(
    `${directory}/profile.test.ts`,
    `
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { it } from 'vitest';
import { testEnv } from '../helpers';
${Object.keys(variants)
  .map(name => `import { instrument as ${name} } from './${name}';`)
  .join('\n')}
const variants = { ${Object.keys(variants).join(', ')} };
const body = new Uint8Array(8192);
const blob = new Uint8Array(256 * 1024);
const chunked = (bytes: Uint8Array) => new ReadableStream({ start(c) {
  for (let i = 0; i < bytes.length; i += 16384) c.enqueue(bytes.subarray(i, i + 16384));
  c.close();
} });
it('profiles the same batch/state/error/blob mix', async () => {
  let points = 0;
  const env = { ...testEnv, SESSION_SYNC_METRICS: { writeDataPoint() { points++; } } };
  const results: Record<string, number[]> = {};
  for (let round = 0; round < 7; round++) {
    const entries = Object.entries(variants);
    for (const [name, instrument] of round % 2 ? entries.reverse() : entries) {
      const start = performance.now();
      for (let i = 0; i < 400; i++) {
        const kind = i % 20;
        const request = new Request('https://profile.test/v1/sessions/ses_profile/batches', {
          method: 'POST', body: chunked(body), headers: { 'content-length': String(body.length) },
        });
        const ctx = createExecutionContext();
        const response = await instrument(request, env, ctx, async req => {
          await req.arrayBuffer();
          if (kind === 0) return Response.json({ error: { code: 'conflict' } }, { status: 409 });
          const bytes = kind === 1 ? blob : new Uint8Array(kind < 4 ? 2048 : 256);
          return new Response(chunked(bytes), { headers: { 'content-length': String(bytes.length) } });
        });
        await response.arrayBuffer();
        await waitOnExecutionContext(ctx);
      }
      if (round) (results[name] ??= []).push((performance.now() - start) / 400);
    }
  }
  for (const [name, samples] of Object.entries(results)) {
    samples.sort((a, b) => a - b);
    console.log('METRICS_PROFILE', name, JSON.stringify({ msPerRequest: samples[3], samples }));
  }
  console.log('METRICS_PROFILE points', points);
}, 120000);
`
  );
  const result = spawnSync(
    `${root}/node_modules/.bin/vitest`,
    ['run', 'test/metrics-profile/profile.test.ts'],
    { cwd: root, stdio: 'inherit' }
  );
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
