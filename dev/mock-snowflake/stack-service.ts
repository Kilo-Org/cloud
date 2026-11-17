// The local-stack entry for the Snowflake mock (the `mock-snowflake` service in
// `dev/local/services.ts` runs this with tsx). Beyond what the standalone
// `server.ts` does, it keeps a managed section of the repo-root `.env.local`
// current, so the web app the stack starts beside it picks the mock up without
// manual steps. `dev/local/services.ts` also exports the CA bundle from that
// section into the web app's command: `scripts/dev.sh` reads
// `NODE_EXTRA_CA_CERTS` from `.env.local` only when the shell does not already
// have one, so a line in the file alone loses to an earlier line or an exported
// value.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseEnvEntries } from './env-file';
import { startMockSnowflake } from './server';
import { MOCK_SNOWFLAKE_PORT, caBundlePath, caCertPath, loadTls, writeEnvSnippet } from './tls-env';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

// The markers delimit the section this entry owns: everything between them is
// rewritten whenever the desired block differs (a new port offset, most often),
// and nothing outside them is touched.
const SECTION_START = '# wired by dev/mock-snowflake/stack-service.ts';
const SECTION_END = '# end of dev/mock-snowflake wiring';

export type WireResult =
  | { status: 'inserted' }
  | {
      status: 'rewritten';
      previousAccountHost: string | undefined;
      accountHost: string | undefined;
    }
  | { status: 'unchanged' }
  | { status: 'keptRealWarehouse' };

type LineRange = { start: number; end: number };

/**
 * Locates the managed section. A section written before the end marker existed
 * runs to the end of the file, which is where that writer appended it.
 */
function findManagedSection(lines: string[]): LineRange | undefined {
  const start = lines.findIndex(line => line.trim() === SECTION_START);
  if (start === -1) return undefined;
  const last = lines.findIndex((line, index) => index > start && line.trim() === SECTION_END);
  return { start, end: last === -1 ? lines.length : last + 1 };
}

/**
 * Writes the CA bundle the managed section names: the mock's own certificate
 * first, then every CA file `existingCaPaths` names that it can read. Trusting
 * the bundle instead of one file keeps a CA the developer already exported —
 * `NODE_EXTRA_CA_CERTS` reaches `next dev` through the bundle now — while still
 * trusting the mock. Returns the bundle's absolute path.
 */
function writeCaBundle(existingCaPaths: readonly string[]): string {
  const bundlePath = caBundlePath();
  const certificates = [loadTls().cert.toString('utf8').trimEnd()];
  const seen = new Set([path.resolve(caCertPath()), path.resolve(bundlePath)]);

  for (const candidate of existingCaPaths) {
    if (candidate === '') continue;
    const resolved = path.resolve(candidate);
    // A bundled CA that is a directory, missing, or unreadable is not one the
    // shell could have loaded either.
    if (seen.has(resolved) || !fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
      continue;
    }
    seen.add(resolved);
    try {
      const content = fs.readFileSync(resolved, 'utf8').trimEnd();
      if (content !== '') certificates.push(content);
    } catch {
      // Unreadable now, so it is not a CA in effect; the mock's own still is.
    }
  }

  fs.writeFileSync(bundlePath, `${certificates.join('\n')}\n`, { mode: 0o600 });
  return bundlePath;
}

/**
 * Keeps one managed section of `.env.local` naming the mock's `SNOWFLAKE_*`
 * block, the CA bundle, and the port the server listens on. An existing
 * `SNOWFLAKE_ACCOUNT_HOST` outside that section is a real warehouse
 * configuration and is never replaced: the file stays byte-identical.
 */
export function wireEnvLocal(): WireResult {
  const envLocalPath = path.join(REPO_ROOT, '.env.local');
  const current = fs.existsSync(envLocalPath) ? fs.readFileSync(envLocalPath, 'utf8') : '';
  const trailingNewline = current.endsWith('\n');
  const lines =
    current === '' ? [] : (trailingNewline ? current.slice(0, -1) : current).split('\n');
  const section = findManagedSection(lines);

  // Everything the developer wrote — the shell's own CA included — has to end
  // up in the bundle, but the section's own line names the bundle.
  const outsideSection = [
    ...lines.slice(0, section?.start ?? lines.length),
    ...lines.slice(section?.end ?? lines.length),
  ];
  const bundlePath = writeCaBundle([
    ...parseEnvEntries(outsideSection.join('\n'))
      .filter(entry => entry.key === 'NODE_EXTRA_CA_CERTS')
      .map(entry => entry.value),
    process.env.NODE_EXTRA_CA_CERTS ?? '',
  ]);

  const envBlock = fs
    .readFileSync(
      writeEnvSnippet(Number(process.env.MOCK_SNOWFLAKE_PORT ?? MOCK_SNOWFLAKE_PORT)),
      'utf8'
    )
    .trimEnd();
  const accountHost = parseEnvEntries(envBlock).find(
    entry => entry.key === 'SNOWFLAKE_ACCOUNT_HOST'
  )?.value;
  const desired = [
    SECTION_START,
    ...envBlock.split('\n'),
    `NODE_EXTRA_CA_CERTS=${bundlePath}`,
    SECTION_END,
  ];

  if (!section) {
    if (parseEnvEntries(lines.join('\n')).some(entry => entry.key === 'SNOWFLAKE_ACCOUNT_HOST')) {
      return { status: 'keptRealWarehouse' };
    }
    const wired = lines.length === 0 ? desired : [...lines, '', ...desired];
    fs.writeFileSync(envLocalPath, `${wired.join('\n')}\n`);
    return { status: 'inserted' };
  }

  const existing = lines.slice(section.start, section.end);
  if (existing.length === desired.length && existing.every((line, i) => line === desired[i])) {
    return { status: 'unchanged' };
  }

  const previousAccountHost = parseEnvEntries(existing.join('\n')).find(
    entry => entry.key === 'SNOWFLAKE_ACCOUNT_HOST'
  )?.value;
  const wired = [...lines.slice(0, section.start), ...desired, ...lines.slice(section.end)];
  fs.writeFileSync(envLocalPath, `${wired.join('\n')}${trailingNewline ? '\n' : ''}`);
  return { status: 'rewritten', previousAccountHost, accountHost };
}

export async function main(): Promise<void> {
  const result = wireEnvLocal();
  if (result.status === 'keptRealWarehouse') {
    console.log('keeping the existing real SNOWFLAKE_* configuration in .env.local');
  } else if (result.status === 'inserted') {
    console.log(`wired .env.local for the mock warehouse (${caBundlePath()})`);
  } else if (result.status === 'rewritten') {
    console.log(
      `rewired .env.local: SNOWFLAKE_ACCOUNT_HOST ${result.previousAccountHost ?? '(none)'} -> ${result.accountHost ?? '(none)'}`
    );
  }
  await startMockSnowflake();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
