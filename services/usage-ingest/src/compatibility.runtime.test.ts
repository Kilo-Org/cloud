import { unstable_readConfig, unstable_startWorker } from 'wrangler';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// The STS canary verifies with JOSE (@kilocode/verify). A JOSE verification failure rejects a
// promise that its async caller adopts and then catches; workerd reports that handled rejection as
// unhandled unless it defers rejection processing to the microtask checkpoint (panva/jose#892).
// The compatibility date enables the deferral, so wrangler.jsonc does not name
// `unhandled_rejection_after_microtask_checkpoint`. The probe repeats the adopt-and-catch shape.
const PROBE = `
let reported = 0;
addEventListener('unhandledrejection', () => {
  reported++;
});
async function verifyFails() {
  throw new Error('signature verification failed');
}
async function adopts() {
  return verifyFails();
}
export default {
  async fetch() {
    await adopts().catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 0));
    return Response.json({
      flag: Cloudflare.compatibilityFlags.unhandled_rejection_after_microtask_checkpoint,
      reported,
    });
  },
};
`;

it.each([
  ['production', undefined],
  ['staging', 'staging'],
])(
  '%s defers unhandled rejection processing to the microtask checkpoint',
  async (_name, env) => {
    const service = unstable_readConfig({
      config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href),
      env,
    });
    const directory = await mkdtemp(join(tmpdir(), 'usage-compatibility-'));
    let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
    try {
      const main = join(directory, 'probe.mjs');
      await writeFile(main, PROBE);
      const config = join(directory, 'wrangler.json');
      await writeFile(
        config,
        JSON.stringify({
          name: 'usage-compatibility',
          main,
          compatibility_date: service.compatibility_date,
          compatibility_flags: service.compatibility_flags,
        })
      );
      worker = await unstable_startWorker({
        config,
        dev: {
          remote: false,
          persist: false,
          server: { hostname: '127.0.0.1', port: 0 },
          inspector: false,
          watch: false,
        },
      });
      const response = await worker.fetch('http://usage-compatibility.test/');
      expect(await response.json()).toEqual({ flag: true, reported: 0 });
    } finally {
      try {
        await worker?.dispose();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
  60_000
);
