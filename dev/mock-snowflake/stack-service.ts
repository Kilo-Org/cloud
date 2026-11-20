// The local-stack entry for the Snowflake mock (the `mock-snowflake` service in
// `dev/local/services.ts` runs this with tsx). Beyond what the standalone
// `server.ts` does, it keeps a managed section of the repo-root `.env.local`
// current, so the web app the stack starts beside it picks the mock up without
// manual steps. A `SNOWFLAKE_ACCOUNT_HOST` the developer wrote outside that
// section is a real warehouse and wins: the entry leaves the file alone, or
// removes its own section when it finds one.
//
// Trusting the mock's certificate needs two things, because `scripts/dev.sh`
// resolves `NODE_EXTRA_CA_CERTS` as `shell value, else the first matching line`
// of the env files it walks:
//
// - the command: `dev/local/services.ts` exports the bundle into the web app's
//   command, which is the only thing that wins over a value the developer's own
//   shell exports — so the bundle carries every CA those files and the shell
//   name (`writeCaBundle`);
// - the file: a `pnpm dev` run without that export reads the env files itself,
//   so the first line `dev.sh` would read in the repo-root `.env.local` must
//   name the bundle (this module owns that, see
//   `pointShadowingCaLineAtBundle`); a line in an earlier env file still wins
//   there, because the entry writes no file it does not own.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseEnvEntries, stripEnvValue } from './env-file';
import { startMockSnowflake } from './server';
import { writeSecretsFile } from '../local/secrets-file';
import {
  MOCK_SNOWFLAKE_PORT,
  SNIPPET_ENV_KEYS,
  caBundlePath,
  caCertPath,
  loadTls,
  writeEnvSnippet,
} from './tls-env';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

// The markers delimit the section this entry owns: everything between them is
// rewritten whenever the desired block differs (a new port offset, most often),
// and nothing outside them is touched.
const SECTION_START = '# wired by dev/mock-snowflake/stack-service.ts';
const SECTION_END = '# end of dev/mock-snowflake wiring';

const CA_KEY = 'NODE_EXTRA_CA_CERTS';

// The env files `scripts/dev.sh` reads before the repo-root `.env.local`, in its
// order: `read_env_value` walks `.env.development.local` and `.env.local` from
// the directory it runs in (`apps/web`) and then the repo-root copies. The
// repo-root `.env.local` is missing on purpose: `wireEnvLocal` collects its
// entries itself, because only the lines outside the managed section are the
// developer's.
const EARLIER_ENV_FILES = [
  path.join('apps', 'web', '.env.development.local'),
  path.join('apps', 'web', '.env.local'),
  '.env.development.local',
] as const;

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
  // `removedSection` says this wire took its own section back out, so the file
  // did change: a real `SNOWFLAKE_ACCOUNT_HOST` outside the section wins.
  | { status: 'keptRealWarehouse'; removedSection: boolean };

type LineRange = { start: number; end: number };

/**
 * The key a `KEY=value` line defines, or the whole text of a line that has no
 * `=`. Only used to spot a second block inside a legacy section's run.
 */
function keyOf(line: string): string {
  const equality = line.indexOf('=');
  return (equality === -1 ? line : line.slice(0, equality)).trim();
}

/**
 * Locates the range this entry owns. With both markers that is the section; a
 * section written before the end marker existed is what the old writer appended
 * to the end of the file, so its range is the run it left there: blanks, the
 * writer's own `SNOWFLAKE_*` entries, one CA line and the recorded source
 * comments. The scan only continues over lines `writeEnvSnippet` could have
 * written — the keys `SNIPPET_ENV_KEYS` names, plus the CA line — so a key the
 * writer never emits (the app's optional tuning like `SNOWFLAKE_LOG_LEVEL`, for
 * instance) ends the run and keeps the developer's line out of this owned
 * range. Any other line is the developer's too: a real warehouse block, a
 * heading comment, an unrelated key. A second entry for a key the run already
 * holds ends it as well — the writer emits each key once, so a repeat means
 * another block starts there.
 */
function findManagedSection(lines: string[]): LineRange | undefined {
  const start = lines.findIndex(line => line.trim() === SECTION_START);
  if (start === -1) return undefined;
  const last = lines.findIndex((line, index) => index > start && line.trim() === SECTION_END);
  if (last !== -1) return { start, end: last + 1 };

  const snippetKeys = new Set<string>(SNIPPET_ENV_KEYS);
  const keys = new Set<string>();
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end] ?? '';
    if (line.trim() === '') {
      // A blank carries no key: it must not join the dedup set, or a second
      // blank would end the owned range and leave a writer line outside it.
      end++;
      continue;
    }
    if (line.startsWith(CA_SOURCE_PREFIX) || line.startsWith(`${CA_KEY}=`)) {
      const key = keyOf(line);
      if (keys.has(key)) break;
      keys.add(key);
      end++;
      continue;
    }
    const key = keyOf(line);
    if (!snippetKeys.has(key)) break;
    if (keys.has(key)) break;
    keys.add(key);
    end++;
  }
  return { start, end };
}

/**
 * The lines outside `section`, so the caller can tell the developer's own
 * entries from the ones this entry wrote.
 */
function linesOutsideOf(lines: string[], section: LineRange | undefined): string[] {
  if (!section) return lines;
  return [...lines.slice(0, section.start), ...lines.slice(section.end)];
}

/**
 * The path a candidate CA file has on disk, so two names for one file — a
 * symlinked env file's copy of a path, a link to the certificate — count once.
 * A missing path keeps its resolved form: the caller has already skipped it.
 */
function caFileIdentity(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

/**
 * The CA path an env file `scripts/dev.sh` would read, or `undefined` when the
 * file names none. `read_env_value` takes the first line of a file whose text
 * before the first `=` is the key and falls through to the next file when that
 * value is empty, so an empty line is no value at all.
 */
function caPathInEnvFile(envFilePath: string): string | undefined {
  if (!fs.statSync(envFilePath, { throwIfNoEntry: false })?.isFile()) return undefined;
  let content: string;
  try {
    content = fs.readFileSync(envFilePath, 'utf8');
  } catch {
    // `dev.sh` only tests for a regular file too; an unreadable one is no source.
    return undefined;
  }
  const value = parseEnvEntries(content).find(entry => entry.key === CA_KEY)?.value;
  return value === undefined || value === '' ? undefined : value;
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
  const seen = new Set([caFileIdentity(caCertPath()), caFileIdentity(bundlePath)]);

  for (const candidate of existingCaPaths) {
    if (candidate === '') continue;
    // A bundled CA that is a directory, missing, or unreadable is not one the
    // shell could have loaded either.
    if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) continue;
    const identity = caFileIdentity(candidate);
    if (seen.has(identity)) continue;
    seen.add(identity);
    try {
      const content = fs.readFileSync(candidate, 'utf8').trimEnd();
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
 * recorded them. A record the section holds as the bare prefix stands for the
 * empty value a wire displaced, and is carried through as `''` so the order of
 * the records is the order the values were displaced in.
 */
function readRecordedCaSources(lines: string[], section: LineRange | undefined): string[] {
  if (!section) return [];
  return lines
    .slice(section.start, section.end)
    .filter(line => line.startsWith(CA_SOURCE_PREFIX))
    .map(line => line.slice(CA_SOURCE_PREFIX.length).trim());
}

/**
 * Points the CA line of the repo-root `.env.local` that `dev.sh` would read
 * first at the bundle.
 *
 * `dev.sh` takes the value of the first line in a file that starts with
 * `NODE_EXTRA_CA_CERTS=` at column 0 — `export KEY=value` and `KEY = value`
 * never match — so a plain line above the managed section (`/corporate/ca.pem`
 * for a proxy, or an empty placeholder copied from an example) shadows the
 * section's own. Rewriting that one line's value keeps the first match correct
 * without moving anything, and drops nothing: `writeCaBundle` already carries
 * that file's bytes, and the displaced value is recorded in the section so the
 * bundle keeps re-reading it and removal can put the line back. An empty
 * placeholder is recorded too, as the bare `CA_SOURCE_PREFIX` line: removing
 * the section then restores the line to empty, so `.env.local` is left exactly
 * as the developer had it. Only a value a rewrite displaced is recorded — a
 * line that already names the bundle displaces nothing. Only this file is
 * rewritten: an earlier env file `dev.sh` walks still wins when no stack export
 * sets the value, which is the case the README's `pnpm dev` paragraph names.
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
  const folded = path.resolve(original) === path.resolve(bundlePath) ? undefined : original;
  const rewritten = [...lines];
  rewritten[index] = `${CA_KEY}=${bundlePath}`;
  return { lines: rewritten, folded };
}

/**
 * The section's CA sources: what it recorded already, plus what this wire
 * folded in (an empty record stands for the empty value it displaced, and is
 * kept as a record but names no file). A source that no longer exists is
 * dropped, so the section does not keep claiming a CA the bundle cannot load;
 * the empty record needs no file, so it always stays.
 *
 * The order is the displacement order: a folded value the records already hold
 * moves to the end, because the newest record is the value the CA line last
 * displaced and `removeManagedSection` restores exactly that record. A record
 * whose file is gone loses its place: it cannot be folded again, so keeping it
 * in front would make the next fold of the same path restore the wrong value.
 */
function mergeCaSources(recorded: readonly string[], folded: string | undefined): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  const withoutFolded =
    folded === undefined
      ? recorded
      : recorded.filter(source =>
          source === '' ? false : path.resolve(source) !== path.resolve(folded)
        );
  for (const source of folded === undefined ? withoutFolded : [...withoutFolded, folded]) {
    if (source === '') {
      if (!seen.has('')) {
        seen.add('');
        merged.push(source);
      }
      continue;
    }
    if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile()) continue;
    const resolved = path.resolve(source);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    merged.push(source);
  }
  return merged;
}

/**
 * Writes `lines` back to `.env.local`, keeping the file's own newline convention.
 */
function writeEnvLines(envLocalPath: string, lines: readonly string[], newline: boolean): void {
  const body = lines.join('\n');
  writeSecretsFile(envLocalPath, body === '' || !newline ? body : `${body}\n`);
}

/**
 * Takes this entry's section back out — with the blank line the insert put in
 * front of it — and restores the CA line the section's repointing displaced.
 * Every other line stays where the developer left it.
 *
 * The restore rule: the newest record is exactly what the wire wrote over, so
 * removal puts that value back verbatim — an empty record restores the empty
 * line the developer had. Restoring happens only while the line still names
 * the bundle: a line the developer has changed since is theirs, not ours. A
 * line that names the bundle with no record at all (a hand edit naming the
 * bundle) is left standing for the same reason.
 */
function removeManagedSection(
  lines: string[],
  section: LineRange,
  recordedCaSources: readonly string[],
  bundlePath: string
): string[] {
  const before = lines.slice(0, section.start);
  if (before[before.length - 1] === '') before.pop();
  const remaining = [...before, ...lines.slice(section.end)];

  const index = remaining.findIndex(line => line.startsWith(`${CA_KEY}=`));
  const displaced = recordedCaSources[recordedCaSources.length - 1];
  if (index === -1 || displaced === undefined) return remaining;
  const value = stripEnvValue((remaining[index] ?? '').slice(CA_KEY.length + 1));
  if (path.resolve(value) !== path.resolve(bundlePath)) return remaining;
  const restored = [...remaining];
  restored[index] = `${CA_KEY}=${displaced}`;
  return restored;
}

/**
 * Keeps one managed section of `.env.local` naming the mock's `SNOWFLAKE_*`
 * block, the CA bundle, and the port the server listens on.
 *
 * A `SNOWFLAKE_ACCOUNT_HOST` the developer wrote outside the range this entry
 * owns is a real warehouse configuration and wins, because `dotenv` keeps the
 * last definition: a section re-emitted below it would silently point the app at
 * the mock. With no section owned the file is left byte-identical; with one, the
 * section is removed and any CA line it repointed is restored.
 */
export function wireEnvLocal(): WireResult {
  const envLocalPath = path.join(REPO_ROOT, '.env.local');
  const current = fs.existsSync(envLocalPath) ? fs.readFileSync(envLocalPath, 'utf8') : '';
  const trailingNewline = current.endsWith('\n');
  const lines =
    current === '' ? [] : (trailingNewline ? current.slice(0, -1) : current).split('\n');
  const section = findManagedSection(lines);
  const outsideSection = linesOutsideOf(lines, section);
  const recordedCaSources = readRecordedCaSources(lines, section);
  const bundlePath = caBundlePath();

  // Everything the developer wrote — the shell's own CA, the repo-root
  // `.env.local` line, and whatever an env file only `scripts/dev.sh` reads
  // names — has to end up in the bundle, but the section's own line names the
  // bundle. The command prefix replaces those files' values, so a CA only they
  // named would stop being trusted without this. Collected before the
  // real-warehouse branch: that one writes the bundle too.
  const earlierCaPaths: string[] = [];
  for (const envFile of EARLIER_ENV_FILES) {
    const caPath = caPathInEnvFile(path.join(REPO_ROOT, envFile));
    if (caPath !== undefined) earlierCaPaths.push(caPath);
  }
  const developerCaPaths = [
    ...recordedCaSources,
    ...parseEnvEntries(outsideSection.join('\n'))
      .filter(entry => entry.key === CA_KEY)
      .map(entry => entry.value),
    ...earlierCaPaths,
    process.env.NODE_EXTRA_CA_CERTS ?? '',
  ];

  // An empty value is no warehouse: `getMissingSnowflakeEnvKeys` in the app
  // filters on falsy, so `SNOWFLAKE_ACCOUNT_HOST=` reports the key as missing
  // exactly like an absent one. The definition that counts is the last one
  // outside the section — dotenv keeps the last definition of a duplicated
  // key — so a real host above an emptied placeholder is unset for the app
  // too, and a placeholder above a real host still wins as a warehouse.
  const outsideEntries = parseEnvEntries(outsideSection.join('\n'));
  const lastOutsideHost = [...outsideEntries]
    .reverse()
    .find(entry => entry.key === 'SNOWFLAKE_ACCOUNT_HOST');
  const outsideHost =
    lastOutsideHost !== undefined && lastOutsideHost.value !== '' ? lastOutsideHost : undefined;
  if (outsideHost !== undefined) {
    // The bundle still gets written: `serviceCommand` prefixes the nextjs
    // command with `NODE_EXTRA_CA_CERTS=<bundle>` whenever the mock is in the
    // selection — the core group always has it — so a fresh checkout's first
    // wire must not leave `next dev` pointing at a path with no file behind it
    // (Node warns and ignores it, and the developer's own CA stops being
    // trusted). The mock's certificate changes nothing on this path: nothing
    // talks to the mock over TLS, and no section names the bundle.
    writeCaBundle(developerCaPaths);
    if (!section) return { status: 'keptRealWarehouse', removedSection: false };
    writeEnvLines(
      envLocalPath,
      removeManagedSection(lines, section, recordedCaSources, bundlePath),
      trailingNewline
    );
    return { status: 'keptRealWarehouse', removedSection: true };
  }

  writeCaBundle(developerCaPaths);

  const envBlock = fs
    .readFileSync(
      writeEnvSnippet(Number(process.env.MOCK_SNOWFLAKE_PORT ?? MOCK_SNOWFLAKE_PORT)),
      'utf8'
    )
    .trimEnd();
  const accountHost = parseEnvEntries(envBlock).find(
    entry => entry.key === 'SNOWFLAKE_ACCOUNT_HOST'
  )?.value;

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
    writeEnvLines(envLocalPath, wired, true);
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
  writeEnvLines(envLocalPath, wired, trailingNewline);
  return { status: 'rewritten', previousAccountHost, accountHost };
}

export async function main(): Promise<void> {
  const result = wireEnvLocal();
  if (result.status === 'keptRealWarehouse') {
    console.log(
      result.removedSection
        ? 'removed the mock-snowflake section of .env.local: a real SNOWFLAKE_* configuration outside it takes over'
        : 'keeping the existing real SNOWFLAKE_* configuration in .env.local'
    );
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
