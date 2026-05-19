/**
 * Redact high-confidence credential formats in existing admin session exports.
 *
 * The script is dry-run by default. Pass `--execute` to rewrite `session.json`
 * files in place. It preserves JSON structure and replaces detected credentials
 * with deterministic typed HMAC placeholders. PEM private key BEGIN/END markers
 * stay visible while the key body is replaced.
 */

import '../../lib/load-env';

import { access, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import {
  ADMIN_SESSION_TRACE_PSEUDONYM_KEY_ENV,
  requirePseudonymKey,
} from './admin-session-trace-pseudonymization';
import {
  redactHighConfidenceSecrets,
  type SecretRedactionStats,
} from './admin-session-trace-secret-redaction';

const SUPPORTED_EXPORT_FORMAT = 'admin-session-trace-bundle-v1';
const DEFAULT_CONCURRENCY = 10;

type JsonObject = Record<string, unknown>;

export type SecretRewriteOptions = {
  inputDir: string;
  execute: boolean;
  concurrency: number;
  pseudonymKey: string;
  pseudonymKeyEnv: string;
};

type SecretRewriteResult = {
  status: 'would_rewrite' | 'rewritten' | 'already_redacted' | 'skipped_missing_file' | 'failed';
  stats: SecretRedactionStats;
  error?: string;
};

export type SecretRewriteSummary = {
  input_dir: string;
  mode: 'dry-run' | 'execute';
  session_directories: number;
  would_rewrite: number;
  rewritten: number;
  already_redacted: number;
  skipped_missing_file: number;
  failed: number;
  total_redactions: number;
  redactions_by_category: Record<string, number>;
};

export async function redactExportDirectorySecrets(
  options: SecretRewriteOptions
): Promise<SecretRewriteSummary> {
  const inputDir = path.resolve(options.inputDir);
  const entries = await readdir(inputDir, { withFileTypes: true });
  const sessionDirectories = entries.filter(entry => entry.isDirectory());
  const limit = pLimit(options.concurrency);
  const results = await Promise.all(
    sessionDirectories.map(entry =>
      limit(() => redactOneSessionFile(inputDir, entry.name, options.execute, options.pseudonymKey))
    )
  );
  const combinedStats = combineStats(results.map(result => result.stats));

  return {
    input_dir: inputDir,
    mode: options.execute ? 'execute' : 'dry-run',
    session_directories: sessionDirectories.length,
    would_rewrite: countStatus(results, 'would_rewrite'),
    rewritten: countStatus(results, 'rewritten'),
    already_redacted: countStatus(results, 'already_redacted'),
    skipped_missing_file: countStatus(results, 'skipped_missing_file'),
    failed: countStatus(results, 'failed'),
    total_redactions: combinedStats.totalReplacements,
    redactions_by_category: combinedStats.replacementsByCategory,
  };
}

async function redactOneSessionFile(
  inputDir: string,
  sessionDirectoryName: string,
  execute: boolean,
  pseudonymKey: string
): Promise<SecretRewriteResult> {
  const sessionJsonPath = path.join(inputDir, sessionDirectoryName, 'session.json');
  if (!(await fileExists(sessionJsonPath))) {
    return emptyResult('skipped_missing_file');
  }

  try {
    const artifact = parseSupportedArtifact(
      await readFile(sessionJsonPath, 'utf8'),
      sessionJsonPath
    );
    const redacted = redactHighConfidenceSecrets(artifact, pseudonymKey);
    if (!redacted.changed) {
      return {
        status: 'already_redacted',
        stats: redacted.stats,
      };
    }

    if (execute) {
      await writeArtifactAtomically(sessionJsonPath, redacted.value);
    }

    return {
      status: execute ? 'rewritten' : 'would_rewrite',
      stats: redacted.stats,
    };
  } catch (error) {
    return {
      status: 'failed',
      stats: emptyStats(),
      error: sanitizeErrorMessage(error),
    };
  }
}

function parseSupportedArtifact(rawArtifact: string, filePath: string): JsonObject {
  const parsed = JSON.parse(rawArtifact) as unknown;
  if (!isJsonObject(parsed)) {
    throw new Error(`${filePath} does not contain an object export artifact`);
  }
  if (parsed.export_format !== SUPPORTED_EXPORT_FORMAT) {
    throw new Error(`${filePath} has unsupported export_format`);
  }
  return parsed;
}

async function writeArtifactAtomically(filePath: string, artifact: JsonObject): Promise<void> {
  const tempPath = `${filePath}.redacting-secrets-${process.pid}`;
  await writeFile(tempPath, JSON.stringify(artifact, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(tempPath, filePath);
}

function combineStats(statsList: SecretRedactionStats[]): SecretRedactionStats {
  const result = emptyStats();
  for (const stats of statsList) {
    result.totalReplacements += stats.totalReplacements;
    for (const [category, count] of Object.entries(stats.replacementsByCategory)) {
      result.replacementsByCategory[category] =
        (result.replacementsByCategory[category] ?? 0) + count;
    }
  }
  return result;
}

function emptyResult(status: SecretRewriteResult['status']): SecretRewriteResult {
  return {
    status,
    stats: emptyStats(),
  };
}

function emptyStats(): SecretRedactionStats {
  return {
    replacementsByCategory: {},
    totalReplacements: 0,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function countStatus(
  results: SecretRewriteResult[],
  status: SecretRewriteResult['status']
): number {
  return results.filter(result => result.status === status).length;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return raw
    .replaceAll(/[\r\n\t]+/g, ' ')
    .replaceAll(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 500);
}

export function parseSecretRewriteOptions(
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): SecretRewriteOptions {
  let inputDir = '';
  let execute = false;
  let concurrency = DEFAULT_CONCURRENCY;
  let pseudonymKeyEnv = ADMIN_SESSION_TRACE_PSEUDONYM_KEY_ENV;

  for (const arg of args) {
    if (arg === '--execute') {
      execute = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith('--input-dir=')) {
      inputDir = arg.slice('--input-dir='.length);
    } else if (arg.startsWith('--pseudonym-key-env=')) {
      pseudonymKeyEnv = arg.slice('--pseudonym-key-env='.length);
    } else if (arg.startsWith('--concurrency=')) {
      concurrency = parsePositiveInteger(arg, '--concurrency=');
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!inputDir) throw new Error('Missing required argument: --input-dir=<path>');
  if (!pseudonymKeyEnv) throw new Error('--pseudonym-key-env cannot be empty');

  return {
    inputDir,
    execute,
    concurrency,
    pseudonymKeyEnv,
    pseudonymKey: requirePseudonymKey(
      env[pseudonymKeyEnv],
      `environment variable ${pseudonymKeyEnv}`
    ),
  };
}

function parsePositiveInteger(arg: string, prefix: string): number {
  const parsed = Number.parseInt(arg.slice(prefix.length), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${prefix.slice(0, -1)} value: ${arg}`);
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Redact high-confidence credential formats in existing admin session exports.

Usage:
  ${ADMIN_SESSION_TRACE_PSEUDONYM_KEY_ENV}=... pnpm script src/scripts/session-traces/redact-exported-admin-session-trace-secrets.ts \\
    --input-dir=/path/to/export-dir [--execute] [--concurrency=10]

Behavior:
  Dry-run is the default. Pass --execute to rewrite session.json files in place.
  JSON structure and surrounding text are preserved. Private key BEGIN/END markers
  remain visible while their sensitive body is replaced. Only high-confidence
  token/key formats are automatically redacted in this pass.`);
}

export async function run(...args: string[]): Promise<void> {
  const options = parseSecretRewriteOptions(args.length > 0 ? args : process.argv.slice(2));
  console.log('Redacting high-confidence credentials in exported admin session traces');
  console.log(`Input dir:       ${path.resolve(options.inputDir)}`);
  console.log(`Mode:            ${options.execute ? 'execute' : 'dry-run'}`);
  console.log(`Concurrency:     ${options.concurrency}`);
  console.log(`Key env:         ${options.pseudonymKeyEnv}`);

  const summary = await redactExportDirectorySecrets(options);
  console.log('\nSecret redaction summary');
  console.log(`Session folders: ${summary.session_directories}`);
  console.log(`Would rewrite:   ${summary.would_rewrite}`);
  console.log(`Rewritten:       ${summary.rewritten}`);
  console.log(`Already clean:   ${summary.already_redacted}`);
  console.log(`Missing files:   ${summary.skipped_missing_file}`);
  console.log(`Failed:          ${summary.failed}`);
  console.log(`Redactions:      ${summary.total_redactions}`);
  console.log(`Categories:      ${JSON.stringify(summary.redactions_by_category)}`);
  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

const isDirectScriptInvocation = process.argv[1]?.endsWith(
  'redact-exported-admin-session-trace-secrets.ts'
);
if (isDirectScriptInvocation) {
  void run().catch(error => {
    console.error(`Fatal secret redaction error: ${sanitizeErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
