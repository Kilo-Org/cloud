import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';

export const scanner = 'jscpd@5.0.16';
const scannerVersion = scanner.slice('jscpd@'.length);
const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultAllowlist = join(serviceRoot, 'scripts/duplication-allowlist.json');
const sourceExtensions = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.css',
]);
const excludedDirectories = new Set([
  '__fixtures__',
  '__mocks__',
  '__snapshots__',
  '__tests__',
  '.wrangler',
  'build',
  'coverage',
  'deps',
  'dist',
  'fixtures',
  'fixture',
  'generated',
  'node_modules',
  'out',
  'recordings',
  'specs',
  'test',
  'testdata',
  'tests',
]);

export type Finding = {
  files: [string, string];
  fingerprint: string;
  matches: number;
  tokens: number;
  locations: { file: string; start: number; end: number }[];
};

export type DuplicationException = {
  files: [string, string];
  fingerprint: string;
  owner: string;
  reason: string;
  kind: 'legacy' | 'intentional';
  maxMatches: number;
  maxTokens: number;
};

export type ScanResult = {
  scanner: typeof scanner;
  files: number;
  lines: number;
  pairs: number;
  duplicatedLines: number;
  duplicatedTokens: number;
  findings: Finding[];
};

type ScanOptions = {
  scannerCommand?: readonly string[];
  afterScanner?: (outputDirectory: string) => void | Promise<void>;
};

type CliOptions = {
  root?: string;
  allowlistPath?: string;
  output?: (text: string) => void;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new Error('Expected a JSON object');
  return value;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected a JSON array');
  return value;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected a non-empty string');
  return value;
}

function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Expected an integer of at least ${minimum}`);
  }
  return value;
}

function repositoryPath(value: unknown): string {
  const file = text(value);
  if (
    isAbsolute(file) ||
    file.includes('\\') ||
    file.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Expected a repository-relative path: ${file}`);
  }
  return file;
}

function fingerprint(value: unknown): string {
  const hash = text(value);
  if (!/^[a-f0-9]{16}$/.test(hash)) {
    throw new Error(`Invalid duplication fingerprint: ${hash}`);
  }
  return hash;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  description: string
): void {
  const actual = Object.keys(value).toSorted();
  if (actual.join('\0') !== [...expected].sort().join('\0')) {
    throw new Error(`Malformed ${description}: expected only ${expected.join(', ')}`);
  }
}

function findingKey(entry: Pick<DuplicationException, 'files' | 'fingerprint'>): string {
  return JSON.stringify([entry.files, entry.fingerprint]);
}

export function parseAllowlist(value: unknown): DuplicationException[] {
  const data = object(value);
  exactKeys(data, ['version', 'scanner', 'exceptions'], 'duplication allowlist');
  if (data.version !== 1 || data.scanner !== scanner) {
    throw new Error('Unsupported duplication allowlist version or scanner');
  }

  const seen = new Set<string>();
  return array(data.exceptions).map(value => {
    const item = object(value);
    exactKeys(
      item,
      ['files', 'fingerprint', 'owner', 'reason', 'kind', 'maxMatches', 'maxTokens'],
      'duplication exception'
    );
    const parsedFiles = array(item.files).map(repositoryPath);
    if (
      parsedFiles.length !== 2 ||
      parsedFiles[0] === undefined ||
      parsedFiles[1] === undefined ||
      parsedFiles.join('\0') !== parsedFiles.toSorted().join('\0')
    ) {
      throw new Error('An exception must contain exactly two sorted file paths');
    }
    const kind = item.kind;
    if (kind !== 'legacy' && kind !== 'intentional') {
      throw new Error('An exception kind must be legacy or intentional');
    }
    const entry: DuplicationException = {
      files: [parsedFiles[0], parsedFiles[1]],
      fingerprint: fingerprint(item.fingerprint),
      owner: text(item.owner),
      reason: text(item.reason),
      kind,
      maxMatches: integer(item.maxMatches, 1),
      maxTokens: integer(item.maxTokens, 1),
    };
    const key = findingKey(entry);
    if (seen.has(key)) throw new Error(`Duplicate exception: ${entry.files.join(' and ')}`);
    seen.add(key);
    return entry;
  });
}

function extension(file: string): string {
  for (const candidate of sourceExtensions) {
    if (file.endsWith(candidate)) return candidate;
  }
  return '';
}

function isExcluded(relativePath: string): boolean {
  const parts = relativePath.split('/');
  const basename = parts.at(-1) ?? '';
  return (
    parts.some(part => excludedDirectories.has(part)) ||
    /\.(?:test|spec)\.[^.]+$/.test(basename) ||
    /(?:^|[-_.])fixtures?(?:[-_.]|$)/.test(basename) ||
    /(?:^|[-_.])test[-_.]?data(?:[-_.]|$)/.test(basename) ||
    /\.d\.[cm]?tsx?$/.test(basename) ||
    /\.(?:gen|generated)\.[cm]?tsx?$/.test(basename)
  );
}

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relativePath = relative(root, absolute).replaceAll('\\', '/');
      if (isExcluded(relativePath)) continue;
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && extension(entry.name)) {
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) continue;
        if (info.size > 10 * 1024 * 1024) {
          throw new Error(`Source exceeds the duplication scanner size limit: ${relativePath}`);
        }
        const content = await readFile(absolute, 'utf8');
        if (/jscpd:ignore-(?:start|end)/.test(content)) {
          throw new Error(
            `Inline duplication suppression is not allowed: ${relativePath}. Use a bounded exception instead.`
          );
        }
        files.push(absolute);
      }
    }
  }

  await visit(join(root, 'src'));
  await visit(join(root, 'wrapper/src'));
  return files.toSorted();
}

function defaultScannerCommand(): readonly string[] {
  const require = createRequire(import.meta.url);
  const packageDirectory = dirname(require.resolve('jscpd/package.json'));
  return [process.execPath, join(packageDirectory, 'run-jscpd.js')];
}

async function run(
  command: readonly string[],
  args: readonly string[],
  cwd: string
): Promise<void> {
  if (!command.length) throw new Error('Duplication scanner command is missing');
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command[0], [...command.slice(1), ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', chunk => (stdout += chunk));
    child.stderr?.setEncoding('utf8').on('data', chunk => (stderr += chunk));
    child.once('error', error =>
      reject(new Error(`Duplication scanner failed to start: ${error.message}`))
    );
    child.once('close', code => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Duplication scanner failed (${String(code)}):\n${stderr || stdout}`));
    });
  });
}

async function readJson(file: string, description: string): Promise<unknown> {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`${description} is missing: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`${description} is malformed: ${(error as Error).message}`);
  }
}

export async function scan(rootInput: string, options: ScanOptions = {}): Promise<ScanResult> {
  const root = await realpath(rootInput);
  const files = await collectFiles(root);
  if (!files.length) throw new Error('No production source files found for duplication analysis');

  const outputDirectory = await mkdtemp(join(tmpdir(), 'cloud-agent-duplication-'));
  try {
    const configPath = join(outputDirectory, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        path: files,
        mode: 'weak',
        minLines: 10,
        minTokens: 100,
        format: ['typescript', 'tsx', 'javascript', 'jsx', 'css'],
        crossFormats: [['typescript', 'tsx']],
        maxSize: '10mb',
        absolute: true,
        noColors: true,
        noTips: true,
        reporters: ['json', 'sarif'],
        output: outputDirectory,
      })
    );
    const command = options.scannerCommand ?? defaultScannerCommand();
    await run(command, ['--config', configPath, '--workers', '1', '--no-gitignore'], root);
    await options.afterScanner?.(outputDirectory);

    const json = object(
      await readJson(join(outputDirectory, 'jscpd-report.json'), 'jscpd JSON report')
    );
    const total = object(object(json.statistics).total);
    const sarif = object(
      await readJson(join(outputDirectory, 'jscpd-report.sarif'), 'jscpd SARIF report')
    );
    const runs = array(sarif.runs);
    if (runs.length !== 1) throw new Error('Expected one duplication scanner run');
    const scannerRun = object(runs[0]);
    if (object(object(scannerRun.tool).driver).version !== scannerVersion) {
      throw new Error('Unexpected duplication scanner version');
    }
    const results = array(scannerRun.results);
    if (integer(total.clones) !== results.length) {
      throw new Error('Duplication reports disagree on the number of findings');
    }

    const findings = new Map<string, Finding>();
    for (const value of results) {
      const result = object(value);
      if (result.ruleId !== 'jscpd/duplicate-code') {
        throw new Error('Unexpected duplication scanner result');
      }
      const locations = [...array(result.locations), ...array(result.relatedLocations)].map(
        value => {
          const physicalLocation = object(object(value).physicalLocation);
          const artifact = object(physicalLocation.artifactLocation);
          const uri = text(artifact.uri);
          let absolute: string;
          if (isAbsolute(uri)) {
            absolute = uri;
          } else {
            const baseId = text(artifact.uriBaseId);
            const base = text(object(object(scannerRun.originalUriBaseIds)[baseId]).uri);
            absolute = fileURLToPath(new URL(uri, base));
          }
          const region = object(physicalLocation.region);
          return {
            file: repositoryPath(relative(root, absolute).replaceAll('\\', '/')),
            start: integer(region.startLine, 1),
            end: integer(region.endLine, 1),
          };
        }
      );
      if (locations.length !== 2 || locations[0] === undefined || locations[1] === undefined) {
        throw new Error('Expected two locations for a duplicated block');
      }
      const sortedFiles = locations.map(location => location.file).toSorted();
      const hash = fingerprint(object(result.partialFingerprints)['jscpdCloneHash/v1']);
      const tokens = integer(object(result.properties).token_count, 1);
      const filesTuple: [string, string] = [sortedFiles[0], sortedFiles[1]];
      const key = findingKey({ files: filesTuple, fingerprint: hash });
      const previous = findings.get(key);
      findings.set(key, {
        files: filesTuple,
        fingerprint: hash,
        matches: (previous?.matches ?? 0) + 1,
        tokens: Math.max(previous?.tokens ?? 0, tokens),
        locations: [...(previous?.locations ?? []), locations[0], locations[1]],
      });
    }

    return {
      scanner,
      files: integer(total.sources, 1),
      lines: integer(total.lines, 1),
      pairs: results.length,
      duplicatedLines: integer(total.duplicatedLines),
      duplicatedTokens: integer(total.duplicatedTokens),
      findings: [...findings.values()].toSorted((left, right) =>
        findingKey(left).localeCompare(findingKey(right))
      ),
    };
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

export function compare(
  findings: readonly Finding[],
  exceptions: readonly DuplicationException[]
): string[] {
  const allowed = new Map(exceptions.map(entry => [findingKey(entry), entry]));
  const current = new Set(findings.map(findingKey));
  const failures: string[] = [];
  for (const finding of findings) {
    const entry = allowed.get(findingKey(finding));
    const locations = finding.locations
      .map(location => `${location.file}:${location.start}-${location.end}`)
      .join(' and ');
    if (!entry) {
      failures.push(
        `Unclassified duplication (${finding.tokens} tokens, ${finding.matches} match(es)): ${locations}`
      );
    } else if (finding.matches > entry.maxMatches || finding.tokens > entry.maxTokens) {
      failures.push(
        `Duplication grew: ${locations}. Matches ${finding.matches}/${entry.maxMatches}, ` +
          `tokens ${finding.tokens}/${entry.maxTokens}. ${entry.reason}`
      );
    }
  }
  for (const entry of exceptions) {
    if (!current.has(findingKey(entry))) {
      failures.push(
        `Stale exception: ${entry.files.join(' and ')} (${entry.fingerprint}). Remove it to lock in cleanup.`
      );
    }
  }
  return failures;
}

export function prune(
  findings: readonly Finding[],
  exceptions: readonly DuplicationException[]
): DuplicationException[] {
  const current = new Map(findings.map(finding => [findingKey(finding), finding]));
  return exceptions.flatMap(entry => {
    const finding = current.get(findingKey(entry));
    return finding
      ? [
          {
            ...entry,
            maxMatches: Math.min(entry.maxMatches, finding.matches),
            maxTokens: Math.min(entry.maxTokens, finding.tokens),
          },
        ]
      : [];
  });
}

function serializeAllowlist(exceptions: readonly DuplicationException[]): string {
  return `${JSON.stringify({ version: 1, scanner, exceptions }, null, 2)}\n`;
}

export async function runCli(args: readonly string[], options: CliOptions = {}): Promise<void> {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  const mode = normalizedArgs[0];
  if (normalizedArgs.length > 1 || (mode && !['--help', '--report', '--prune'].includes(mode))) {
    throw new Error('Usage: pnpm run check:duplication [-- --report | --prune | --help]');
  }
  const output = options.output ?? console.log;
  if (mode === '--help') {
    output(
      'Check cloud-agent-next production code for copied blocks of at least 10 lines and 100 tokens.\n' +
        '--report prints findings without changing the allowlist.\n' +
        '--prune only removes stale exceptions and lowers existing limits; it cannot admit new findings.'
    );
    return;
  }

  const root = options.root ?? serviceRoot;
  const allowlistPath = options.allowlistPath ?? defaultAllowlist;
  const result = await scan(root);
  if (mode === '--report') {
    output(JSON.stringify(result, null, 2));
    return;
  }

  const allowlistValue = await readJson(allowlistPath, 'duplication allowlist');
  const previous = parseAllowlist(allowlistValue);
  const exceptions = mode === '--prune' ? prune(result.findings, previous) : previous;
  const failures = compare(result.findings, exceptions);
  if (failures.length) {
    throw new Error(
      `${failures.join('\n')}\nRefactor new copies or review a bounded exception in ${relative(root, allowlistPath)}.`
    );
  }
  if (mode === '--prune') {
    if (JSON.stringify(previous) !== JSON.stringify(exceptions)) {
      await writeFile(allowlistPath, serializeAllowlist(exceptions));
    }
  }
  const percentage = ((100 * result.duplicatedLines) / result.lines).toFixed(2);
  output(
    `check:duplication: ${result.pairs} block pairs, ${result.duplicatedLines} duplicated lines ` +
      `(${percentage}%), ${result.files} eligible files.\n` +
      `${exceptions.length} bounded exceptions; no new duplication.`
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
