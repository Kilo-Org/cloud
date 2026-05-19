/**
 * Pseudonymize direct account identifiers in existing admin session trace exports.
 *
 * The script is dry-run by default. Pass `--execute` to rewrite session.json
 * files in place. It touches only `admin_session_trace.user.{id,email,name,image}`
 * and `admin_session_trace.kilo_user_id`; message content is never traversed.
 *
 * Usage:
 *   ADMIN_SESSION_TRACE_PSEUDONYM_KEY=... \
 *     pnpm script src/scripts/session-traces/pseudonymize-exported-admin-session-traces.ts \
 *       --input-dir=/path/to/export-dir \
 *       --execute
 */

import '../../lib/load-env';

import { access, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import {
  ADMIN_SESSION_TRACE_PSEUDONYM_KEY_ENV,
  pseudonymizeAdminSessionTrace,
  requirePseudonymKey,
} from './admin-session-trace-pseudonymization';

const SUPPORTED_EXPORT_FORMAT = 'admin-session-trace-bundle-v1';
const DEFAULT_CONCURRENCY = 10;

type JsonObject = Record<string, unknown>;

export type RewriteOptions = {
  inputDir: string;
  execute: boolean;
  concurrency: number;
  pseudonymKey: string;
  pseudonymKeyEnv: string;
};

type RewriteResult = {
  status:
    | 'would_rewrite'
    | 'rewritten'
    | 'already_pseudonymized'
    | 'skipped_missing_file'
    | 'failed';
  pseudonymizedFieldCount: number;
  alreadyPseudonymizedFieldCount: number;
  error?: string;
};

export type PseudonymizeExportDirectorySummary = {
  input_dir: string;
  mode: 'dry-run' | 'execute';
  session_directories: number;
  would_rewrite: number;
  rewritten: number;
  already_pseudonymized: number;
  skipped_missing_file: number;
  failed: number;
  pseudonymized_fields: number;
  already_pseudonymized_fields: number;
};

export async function pseudonymizeExportDirectory(
  options: RewriteOptions
): Promise<PseudonymizeExportDirectorySummary> {
  const inputDir = path.resolve(options.inputDir);
  const directoryEntries = await readdir(inputDir, { withFileTypes: true });
  const sessionDirectories = directoryEntries.filter(entry => entry.isDirectory());
  const limit = pLimit(options.concurrency);
  const results = await Promise.all(
    sessionDirectories.map(entry =>
      limit(() =>
        pseudonymizeOneSessionFile(inputDir, entry.name, options.execute, options.pseudonymKey)
      )
    )
  );

  return {
    input_dir: inputDir,
    mode: options.execute ? 'execute' : 'dry-run',
    session_directories: sessionDirectories.length,
    would_rewrite: countStatus(results, 'would_rewrite'),
    rewritten: countStatus(results, 'rewritten'),
    already_pseudonymized: countStatus(results, 'already_pseudonymized'),
    skipped_missing_file: countStatus(results, 'skipped_missing_file'),
    failed: countStatus(results, 'failed'),
    pseudonymized_fields: results.reduce((sum, result) => sum + result.pseudonymizedFieldCount, 0),
    already_pseudonymized_fields: results.reduce(
      (sum, result) => sum + result.alreadyPseudonymizedFieldCount,
      0
    ),
  };
}

async function pseudonymizeOneSessionFile(
  inputDir: string,
  sessionDirectoryName: string,
  execute: boolean,
  pseudonymKey: string
): Promise<RewriteResult> {
  const sessionJsonPath = path.join(inputDir, sessionDirectoryName, 'session.json');
  if (!(await fileExists(sessionJsonPath))) {
    return emptyResult('skipped_missing_file');
  }

  try {
    const rawArtifact = await readFile(sessionJsonPath, 'utf8');
    const artifact = parseSupportedArtifact(rawArtifact, sessionJsonPath);
    const result = pseudonymizeAdminSessionTrace(artifact.admin_session_trace, pseudonymKey);
    if (!result.changed) {
      return {
        status: 'already_pseudonymized',
        pseudonymizedFieldCount: 0,
        alreadyPseudonymizedFieldCount: result.alreadyPseudonymizedFieldCount,
      };
    }

    if (execute) {
      artifact.admin_session_trace = result.trace;
      await writeArtifactAtomically(sessionJsonPath, artifact);
    }

    return {
      status: execute ? 'rewritten' : 'would_rewrite',
      pseudonymizedFieldCount: result.pseudonymizedFieldCount,
      alreadyPseudonymizedFieldCount: result.alreadyPseudonymizedFieldCount,
    };
  } catch (error) {
    return {
      status: 'failed',
      pseudonymizedFieldCount: 0,
      alreadyPseudonymizedFieldCount: 0,
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
  if (!Object.prototype.hasOwnProperty.call(parsed, 'admin_session_trace')) {
    throw new Error(`${filePath} is missing admin_session_trace`);
  }
  return parsed;
}

async function writeArtifactAtomically(filePath: string, artifact: JsonObject): Promise<void> {
  const tempPath = `${filePath}.pseudonymizing-${process.pid}`;
  await writeFile(tempPath, JSON.stringify(artifact, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(tempPath, filePath);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function countStatus(results: RewriteResult[], status: RewriteResult['status']): number {
  return results.filter(result => result.status === status).length;
}

function emptyResult(status: RewriteResult['status']): RewriteResult {
  return {
    status,
    pseudonymizedFieldCount: 0,
    alreadyPseudonymizedFieldCount: 0,
  };
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

export function parseRewriteOptions(
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): RewriteOptions {
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
  console.log(`Pseudonymize direct user account identifiers in existing session exports.

Usage:
  ${ADMIN_SESSION_TRACE_PSEUDONYM_KEY_ENV}=... pnpm script src/scripts/session-traces/pseudonymize-exported-admin-session-traces.ts \\
    --input-dir=/path/to/export-dir [--execute] [--concurrency=10]

Behavior:
  Dry-run is the default. Pass --execute to rewrite session.json files in place.
  Only admin_session_trace.user.{id,email,name,image} and
  admin_session_trace.kilo_user_id are HMAC-pseudonymized. Message bodies are not touched.

Secrets:
  Use ${ADMIN_SESSION_TRACE_PSEUDONYM_KEY_ENV}, or point
  --pseudonym-key-env=<name> at another environment variable. Raw keys are not
  accepted as command-line flags.`);
}

export async function run(...args: string[]): Promise<void> {
  const options = parseRewriteOptions(args.length > 0 ? args : process.argv.slice(2));
  console.log('Pseudonymizing exported admin session trace user account fields');
  console.log(`Input dir:       ${path.resolve(options.inputDir)}`);
  console.log(`Mode:            ${options.execute ? 'execute' : 'dry-run'}`);
  console.log(`Concurrency:     ${options.concurrency}`);
  console.log(`Key env:         ${options.pseudonymKeyEnv}`);

  const summary = await pseudonymizeExportDirectory(options);
  console.log('\nPseudonymization summary');
  console.log(`Session folders: ${summary.session_directories}`);
  console.log(`Would rewrite:   ${summary.would_rewrite}`);
  console.log(`Rewritten:       ${summary.rewritten}`);
  console.log(`Already hashed:  ${summary.already_pseudonymized}`);
  console.log(`Missing files:   ${summary.skipped_missing_file}`);
  console.log(`Failed:          ${summary.failed}`);
  console.log(`Fields hashed:   ${summary.pseudonymized_fields}`);
  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

const isDirectScriptInvocation = process.argv[1]?.endsWith(
  'pseudonymize-exported-admin-session-traces.ts'
);
if (isDirectScriptInvocation) {
  void run().catch(error => {
    console.error(`Fatal pseudonymization error: ${sanitizeErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
