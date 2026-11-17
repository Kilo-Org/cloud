// The local-stack entry for the Snowflake mock (the `mock-snowflake` service in
// `dev/local/services.ts` runs this with tsx). Beyond what the standalone
// `server.ts` does, it wires the repo-root `.env.local` so the web app the
// stack starts beside it picks the mock up without manual steps:
// `scripts/dev.sh` exports `NODE_EXTRA_CA_CERTS` from `.env.local` before
// `next dev`, so that file must already carry the block and the CA — which is
// why this service sits in `nextjs.dependsOn`.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { startMockSnowflake } from './server';
import { MOCK_SNOWFLAKE_PORT, caCertPath, writeEnvSnippet } from './tls-env';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

// Marks the appended section so a restart can tell its own wiring from a real
// warehouse configuration without parsing the block itself.
const SNOWFLAKE_ENV_WIRE_MARKER = 'wired by dev/mock-snowflake/stack-service.ts';

/**
 * Appends the mock's `SNOWFLAKE_*` block and the absolute CA certificate path
 * to `.env.local`. Guarded by an existing `SNOWFLAKE_ACCOUNT_HOST` line: a real
 * warehouse configuration is never replaced. Idempotent — a second start adds
 * nothing.
 */
export function wireEnvLocal(): { appended: boolean; keptRealWarehouse?: boolean } {
  const envLocalPath = path.join(REPO_ROOT, '.env.local');
  const current = fs.existsSync(envLocalPath) ? fs.readFileSync(envLocalPath, 'utf8') : '';

  // `dotenv` keeps a multi-line value on one line, so an escaped PEM never
  // contains a newline and a line-based regex is safe.
  if (/^SNOWFLAKE_ACCOUNT_HOST=/m.test(current) && !current.includes(SNOWFLAKE_ENV_WIRE_MARKER)) {
    return { appended: false, keptRealWarehouse: true };
  }
  if (current.includes(SNOWFLAKE_ENV_WIRE_MARKER)) return { appended: false };

  const envBlock = fs
    .readFileSync(
      writeEnvSnippet(Number(process.env.MOCK_SNOWFLAKE_PORT ?? MOCK_SNOWFLAKE_PORT)),
      'utf8'
    )
    .trimEnd();
  const addition = [
    '',
    `# ${SNOWFLAKE_ENV_WIRE_MARKER}`,
    envBlock,
    `NODE_EXTRA_CA_CERTS=${caCertPath()}`,
    '',
  ].join('\n');
  fs.appendFileSync(envLocalPath, addition);
  return { appended: true };
}

export async function main(): Promise<void> {
  const result = wireEnvLocal();
  if (result.keptRealWarehouse) {
    console.log('keeping the existing real SNOWFLAKE_* configuration in .env.local');
  }
  await startMockSnowflake();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
