// The local-stack entry for the Snowflake mock (the `mock-snowflake` service in
// `dev/local/services.ts` runs this with tsx). Beyond what the standalone
// `server.ts` does, it keeps a managed section of the repo-root `.env.local`
// current, so the web app the stack starts beside it picks the mock up without
// manual steps.
//
// Trusting the mock's certificate needs two things, because `scripts/dev.sh`
// resolves `NODE_EXTRA_CA_CERTS` as `shell value, else the first matching line
// in .env.local`:
//
// - the file: the first line `dev.sh` would read must name the bundle (this
//   module owns that, see `pointShadowingCaLineAtBundle`);
// - the command: `dev/local/services.ts` exports the bundle into the web app's
//   command, which is the only thing that wins over a value the developer's own
//   shell exports.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseEnvEntries, stripEnvValue } from './env-file';
import { startMockSnowflake } from './server';
import { MOCK_SNOWFLAKE_PORT, caBundlePath, caCertPath, loadTls, writeEnvSnippet } from './tls-env';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

// The markers delimit the section this entry owns: everything between them is
// rewritten whenever the desired block differs (a new port offset, most often),
// and nothing outside them is touched.
const SECTION_START = '# wired by dev/mock-snowflake/stack-service.ts';
const SECTION_END = '# end of dev/mock-snowflake wiring';

const CA_KEY = 'NODE_EXTRA_CA_CERTS';

// A CA line that had to be pointed at the bundle keeps its own path here, so
// the bundle re-reads that file on every wire and a rotated certificate keeps
// taking effect. A comment cannot shadow the section's line: `scripts/dev.sh`
// only matches a line that starts with the key, and Next.js skips comments.
const CA_SOURCE_PREFIX = '# mock-snowflake CA: ';

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
 * The CA files earlier wires folded into the bundle, in the order the section
 * recorded them.
 */
function readRecordedCaSources(lines: string[], section: LineRange | undefined): string[] {
  if (!section) return [];
  return lines
    .slice(section.start, section.end)
    .filter(line => line.startsWith(CA_SOURCE_PREFIX))
    .map(line => line.slice(CA_SOURCE_PREFIX.length).trim())
    .filter(source => source !== '');
}

/**
 * Points the CA line that `scripts/dev.sh` would read first at the bundle.
 *
 * `dev.sh` takes the value of the first line in `.env.local` that starts with
 * `NODE_EXTRA_CA_CERTS=` at column 0 — `export KEY=value` and `KEY = value`
 * never match — so a plain line above the managed section (`/corporate/ca.pem`
 * for a proxy, or an empty placeholder copied from an example) shadows the
 * section's own. Rewriting that one line's value keeps the first match correct
 * without moving anything, and drops nothing: `writeCaBundle` already carries
 * that file's bytes, and the returned path is recorded in the section so the
 * bundle keeps re-reading it.
 */
function pointShadowingCaLineAtBundle(
  lines: string[],
  section: LineRange | undefined,
  bundlePath: string
): { lines: string[]; folded: string | undefined } {
  const limit = section?.start ?? lines.length;
  const index = lines.findIndex((line, i) => i < limit && line.startsWith(`${CA_KEY}=`));
  if (index === -1) return { lines, folded: undefined };

  const original = stripEnvValue((lines[index] ?? '').slice(CA_KEY.length + 1));
  const folded =
    original === '' || path.resolve(original) === path.resolve(bundlePath) ? undefined : original;
  const rewritten = [...lines];
  rewritten[index] = `${CA_KEY}=${bundlePath}`;
  return { lines: rewritten, folded };
}

/**
 * The section's CA sources: what it recorded already, plus a path this wire
 * folded in. A source that no longer exists is dropped, so the section does not
 * keep claiming a CA the bundle cannot load.
 */
function mergeCaSources(recorded: readonly string[], folded: string | undefined): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const source of folded === undefined ? recorded : [...recorded, folded]) {
    if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile()) continue;
    const resolved = path.resolve(source);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    merged.push(source);
  }
  return merged;
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
  const recordedCaSources = readRecordedCaSources(lines, section);
  const outsideSection = [
    ...lines.slice(0, section?.start ?? lines.length),
    ...lines.slice(section?.end ?? lines.length),
  ];
  const bundlePath = writeCaBundle([
    ...recordedCaSources,
    ...parseEnvEntries(outsideSection.join('\n'))
      .filter(entry => entry.key === CA_KEY)
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

  // A file with a real warehouse configuration is left alone entirely: the
  // guard runs before the CA line below is rewritten, so nothing this module
  // does to the file can reach it.
  if (
    !section &&
    parseEnvEntries(lines.join('\n')).some(entry => entry.key === 'SNOWFLAKE_ACCOUNT_HOST')
  ) {
    return { status: 'keptRealWarehouse' };
  }

  const rewritten = pointShadowingCaLineAtBundle(lines, section, bundlePath);
  const caSources = mergeCaSources(recordedCaSources, rewritten.folded);
  const desired = [
    SECTION_START,
    ...envBlock.split('\n'),
    ...caSources.map(source => `${CA_SOURCE_PREFIX}${source}`),
    `${CA_KEY}=${bundlePath}`,
    SECTION_END,
  ];

  if (!section) {
    const wired = rewritten.lines.length === 0 ? desired : [...rewritten.lines, '', ...desired];
    fs.writeFileSync(envLocalPath, `${wired.join('\n')}\n`);
    return { status: 'inserted' };
  }

  const outsideUnchanged = rewritten.lines.every((line, i) => line === lines[i]);
  const existing = lines.slice(section.start, section.end);
  if (
    outsideUnchanged &&
    existing.length === desired.length &&
    existing.every((line, i) => line === desired[i])
  ) {
    return { status: 'unchanged' };
  }

  const previousAccountHost = parseEnvEntries(existing.join('\n')).find(
    entry => entry.key === 'SNOWFLAKE_ACCOUNT_HOST'
  )?.value;
  const wired = [
    ...rewritten.lines.slice(0, section.start),
    ...desired,
    ...rewritten.lines.slice(section.end),
  ];
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
