/**
 * Export admin-visible session trace bundles from a CSV of `session_id` values.
 *
 * This is intentionally a no-server-changes exporter. It calls the existing
 * deployed Admin tRPC procedures and writes one bundle per input session:
 * admin session metadata plus the full messages payload those procedures expose.
 * It is not the exact raw session-ingest `{ info, messages }` snapshot.
 *
 * Privacy posture:
 * - Session messages are sensitive customer/session content.
 * - Console logs and manifests contain IDs, counts, paths, statuses, and compact
 *   sanitized errors only. They never echo message bodies, tool outputs, or auth tokens.
 * - Direct account fields in `admin_session_trace.user` and `kilo_user_id` are
 *   HMAC-pseudonymized before future export files are written.
 * - High-confidence private key/token/key formats are replaced with typed HMAC
 *   placeholders while surrounding text and PEM private-key markers remain visible.
 * - The raw session-ingest `info` object is deliberately not exported here. That
 *   object can contain titles, workspace paths, permission patterns, share URLs,
 *   file-change summaries, and sometimes diff-like data.
 *
 * Usage:
 *   KILOCODE_ADMIN_API_TOKEN=... ADMIN_SESSION_TRACE_PSEUDONYM_KEY=... \
 *     pnpm script src/scripts/session-traces/export-admin-session-traces.ts \
 *       --base-url=https://app.kilo.ai \
 *       --input=/path/to/session-ids.csv \
 *       --output=/path/to/session-export \
 *       --concurrency=5 \
 *       --resume
 *
 * Environment:
 * - `KILOCODE_ADMIN_API_TOKEN` is required unless `--token-env=<name>` points
 *   at another environment variable.
 * - `ADMIN_SESSION_TRACE_PSEUDONYM_KEY` is required unless
 *   `--pseudonym-key-env=<name>` points at another environment variable.
 * - `KILOCODE_ADMIN_API_BASE_URL` can supply `--base-url`.
 * - TruffleHog scans the completed export by default. Use `--trufflehog=off`
 *   only for an intentional operator opt-out.
 */

import '../../lib/load-env';

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { parse as csvParse } from 'csv-parse/sync';
import pLimit from 'p-limit';
import {
  ADMIN_SESSION_TRACE_PSEUDONYM_KEY_ENV,
  pseudonymizeAdminSessionTrace,
  requirePseudonymKey,
} from './admin-session-trace-pseudonymization';
import { redactHighConfidenceSecrets } from './admin-session-trace-secret-redaction';
import {
  scanExportDirectoryWithTruffleHog,
  type TruffleHogMode,
  type TruffleHogScanSummary,
} from './trufflehog-export-secret-scan';

const EXPORT_FORMAT = 'admin-session-trace-bundle-v1';
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TOKEN_ENV = 'KILOCODE_ADMIN_API_TOKEN';
const DEFAULT_TRUFFLEHOG_MODE: TruffleHogMode = 'auto';
const MANIFEST_FILENAME = 'manifest.jsonl';
const SUMMARY_FILENAME = 'summary.json';

export type ParsedSessionIdsCsv = {
  sessionIds: string[];
  inputRowCount: number;
  duplicateSessionIdCount: number;
  blankSessionIdCount: number;
  sessionIdHeader: string;
};

export type AdminSessionTraceApi = {
  getSessionTrace(sessionId: string): Promise<unknown>;
  getSessionMessages(sessionId: string): Promise<unknown>;
};

export type SessionTraceExportOptions = {
  inputPath: string;
  outputDir: string;
  baseUrl: string;
  authToken: string;
  pseudonymKey: string;
  concurrency: number;
  resume: boolean;
  maxAttempts: number;
  truffleHogMode: TruffleHogMode;
  now?: () => Date;
};

export type ExportManifestEntry = {
  session_id: string;
  status: 'exported' | 'skipped_existing' | 'not_found' | 'failed';
  output_path?: string;
  byte_size?: number;
  message_count?: number | null;
  empty_messages?: boolean;
  error?: string;
};

export type SessionTraceExportSummary = {
  export_format: typeof EXPORT_FORMAT;
  exported_at: string;
  input_path: string;
  output_dir: string;
  admin_api_base_url: string;
  requested_rows: number;
  unique_session_ids: number;
  duplicate_session_ids: number;
  blank_session_ids: number;
  exported: number;
  skipped_existing: number;
  not_found: number;
  failed: number;
  empty_message_bundles: number;
  manifest_path: string;
  summary_path: string;
  secret_scan: TruffleHogScanSummary;
};

type CliOptions = SessionTraceExportOptions & {
  tokenEnv: string;
  pseudonymKeyEnv: string;
};

type FetchLike = typeof fetch;

type AdminTrpcClientOptions = {
  baseUrl: string;
  authToken: string;
  maxAttempts: number;
  fetchImpl?: FetchLike;
  sleep?: (delayMs: number) => Promise<void>;
};

type SessionExportDependencies = {
  api?: AdminSessionTraceApi;
  scanExportDirectory?: typeof scanExportDirectoryWithTruffleHog;
};

export class AdminTrpcError extends Error {
  readonly procedure: string;
  readonly status: number | null;
  readonly trpcCode: string | null;

  constructor(params: {
    procedure: string;
    message: string;
    status?: number | null;
    trpcCode?: string | null;
  }) {
    super(params.message);
    this.name = 'AdminTrpcError';
    this.procedure = params.procedure;
    this.status = params.status ?? null;
    this.trpcCode = params.trpcCode ?? null;
  }
}

export function parseSessionIdsCsv(content: string, sourceName = 'CSV input'): ParsedSessionIdsCsv {
  let headers: string[] = [];
  const rawRows = csvParse(content, {
    bom: true,
    columns(headerValues: string[]) {
      headers = headerValues.map(header => header.trim());
      return headers;
    },
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  const sessionIdHeader = headers.find(isSessionIdHeader);
  if (!sessionIdHeader) {
    throw new Error(`${sourceName} is missing a session_id column`);
  }

  const sessionIds: string[] = [];
  const seenSessionIds = new Set<string>();
  let duplicateSessionIdCount = 0;
  let blankSessionIdCount = 0;

  for (const row of rawRows) {
    const sessionId = (row[sessionIdHeader] ?? '').trim();
    if (!sessionId) {
      blankSessionIdCount++;
      continue;
    }
    if (seenSessionIds.has(sessionId)) {
      duplicateSessionIdCount++;
      continue;
    }
    seenSessionIds.add(sessionId);
    sessionIds.push(sessionId);
  }

  if (sessionIds.length === 0) {
    throw new Error(`${sourceName} does not contain any non-empty session_id values`);
  }

  return {
    sessionIds,
    inputRowCount: rawRows.length,
    duplicateSessionIdCount,
    blankSessionIdCount,
    sessionIdHeader,
  };
}

function isSessionIdHeader(header: string): boolean {
  return header.replaceAll(/[^a-zA-Z0-9]/g, '').toLowerCase() === 'sessionid';
}

export function safeSessionDirectoryName(sessionId: string): string {
  return encodeURIComponent(sessionId).replaceAll('.', '%2E');
}

export function normalizeAdminApiBaseUrl(rawBaseUrl: string): string {
  const trimmed = rawBaseUrl.trim().replace(/\/+$/g, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid admin API base URL: ${rawBaseUrl}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Admin API base URL must use http or https: ${rawBaseUrl}`);
  }

  return trimmed;
}

export function createAdminSessionTraceApi({
  baseUrl,
  authToken,
  maxAttempts,
  fetchImpl = fetch,
  sleep = defaultSleep,
}: AdminTrpcClientOptions): AdminSessionTraceApi {
  const normalizedBaseUrl = normalizeAdminApiBaseUrl(baseUrl);
  const trimmedToken = authToken.trim();
  if (!trimmedToken) {
    throw new Error('Admin API token is empty');
  }

  return {
    getSessionTrace(sessionId) {
      return callAdminTrpcQuery({
        baseUrl: normalizedBaseUrl,
        authToken: trimmedToken,
        procedure: 'admin.sessionTraces.get',
        input: { session_id: sessionId },
        maxAttempts,
        fetchImpl,
        sleep,
      });
    },
    getSessionMessages(sessionId) {
      return callAdminTrpcQuery({
        baseUrl: normalizedBaseUrl,
        authToken: trimmedToken,
        procedure: 'admin.sessionTraces.getMessages',
        input: { session_id: sessionId },
        maxAttempts,
        fetchImpl,
        sleep,
      });
    },
  };
}

async function callAdminTrpcQuery(params: {
  baseUrl: string;
  authToken: string;
  procedure: string;
  input: unknown;
  maxAttempts: number;
  fetchImpl: FetchLike;
  sleep: (delayMs: number) => Promise<void>;
}): Promise<unknown> {
  const encodedInput = encodeURIComponent(JSON.stringify(params.input));
  const url = `${params.baseUrl}/api/trpc/${params.procedure}?input=${encodedInput}`;
  let lastError: unknown;

  for (let attempt = 1; attempt <= params.maxAttempts; attempt++) {
    try {
      const response = await params.fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${params.authToken}`,
        },
      });
      const payload = await readJsonPayload(response);

      if (!response.ok) {
        const error = buildTrpcResponseError(params.procedure, response.status, payload);
        if (shouldRetryStatus(response.status) && attempt < params.maxAttempts) {
          lastError = error;
          await params.sleep(retryDelayMs(attempt));
          continue;
        }
        throw error;
      }

      const result = getObject(payload)?.result;
      const resultObject = getObject(result);
      if (resultObject && Object.prototype.hasOwnProperty.call(resultObject, 'data')) {
        return resultObject.data;
      }

      throw buildTrpcResponseError(params.procedure, response.status, payload);
    } catch (error) {
      lastError = error;
      if (error instanceof AdminTrpcError) {
        throw error;
      }
      if (attempt >= params.maxAttempts) {
        throw new AdminTrpcError({
          procedure: params.procedure,
          message: sanitizeErrorMessage(error),
        });
      }
      await params.sleep(retryDelayMs(attempt));
    }
  }

  throw new AdminTrpcError({
    procedure: params.procedure,
    message: sanitizeErrorMessage(lastError),
  });
}

async function readJsonPayload(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!body) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return { rawBody: body.slice(0, 200) };
  }
}

function buildTrpcResponseError(
  procedure: string,
  status: number,
  payload: unknown
): AdminTrpcError {
  const errorObject = getObject(getObject(payload)?.error);
  const errorJson = getObject(errorObject?.json);
  const errorData = getObject(errorJson?.data);
  const messageCandidate =
    typeof errorJson?.message === 'string'
      ? errorJson.message
      : typeof errorObject?.message === 'string'
        ? errorObject.message
        : `Admin tRPC ${procedure} failed with HTTP ${status}`;
  const trpcCode = typeof errorData?.code === 'string' ? errorData.code : null;

  return new AdminTrpcError({
    procedure,
    status,
    trpcCode,
    message: sanitizeErrorMessage(messageCandidate),
  });
}

function getObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryDelayMs(attempt: number): number {
  return 250 * 2 ** Math.max(0, attempt - 1);
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

export async function exportAdminSessionTraces(
  options: SessionTraceExportOptions,
  dependencies: SessionExportDependencies = {}
): Promise<SessionTraceExportSummary> {
  const now = options.now ?? (() => new Date());
  const exportedAt = now().toISOString();
  const csvContent = await readFile(options.inputPath, 'utf8');
  const parsedCsv = parseSessionIdsCsv(csvContent, options.inputPath);
  const outputDir = path.resolve(options.outputDir);
  const normalizedBaseUrl = normalizeAdminApiBaseUrl(options.baseUrl);
  requirePseudonymKey(options.pseudonymKey, 'SessionTraceExportOptions.pseudonymKey');
  const api =
    dependencies.api ??
    createAdminSessionTraceApi({
      baseUrl: normalizedBaseUrl,
      authToken: options.authToken,
      maxAttempts: options.maxAttempts,
    });

  await mkdir(outputDir, { recursive: true, mode: 0o700 });

  const limit = pLimit(options.concurrency);
  const manifestEntries = await Promise.all(
    parsedCsv.sessionIds.map(sessionId =>
      limit(() =>
        exportOneSession({
          sessionId,
          outputDir,
          exportedAt,
          resume: options.resume,
          api,
          pseudonymKey: options.pseudonymKey,
        })
      )
    )
  );

  const manifestPath = path.join(outputDir, MANIFEST_FILENAME);
  const summaryPath = path.join(outputDir, SUMMARY_FILENAME);
  await writeFile(
    manifestPath,
    manifestEntries.map(entry => JSON.stringify(entry)).join('\n') + '\n',
    { encoding: 'utf8', mode: 0o600 }
  );

  const secretScan = await (dependencies.scanExportDirectory ?? scanExportDirectoryWithTruffleHog)({
    outputDir,
    mode: options.truffleHogMode,
  });

  const summary: SessionTraceExportSummary = {
    export_format: EXPORT_FORMAT,
    exported_at: exportedAt,
    input_path: path.resolve(options.inputPath),
    output_dir: outputDir,
    admin_api_base_url: normalizedBaseUrl,
    requested_rows: parsedCsv.inputRowCount,
    unique_session_ids: parsedCsv.sessionIds.length,
    duplicate_session_ids: parsedCsv.duplicateSessionIdCount,
    blank_session_ids: parsedCsv.blankSessionIdCount,
    exported: countStatus(manifestEntries, 'exported'),
    skipped_existing: countStatus(manifestEntries, 'skipped_existing'),
    not_found: countStatus(manifestEntries, 'not_found'),
    failed: countStatus(manifestEntries, 'failed'),
    empty_message_bundles: manifestEntries.filter(entry => entry.empty_messages).length,
    manifest_path: manifestPath,
    summary_path: summaryPath,
    secret_scan: secretScan,
  };

  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });

  return summary;
}

async function exportOneSession(params: {
  sessionId: string;
  outputDir: string;
  exportedAt: string;
  resume: boolean;
  api: AdminSessionTraceApi;
  pseudonymKey: string;
}): Promise<ExportManifestEntry> {
  const sessionDir = path.join(params.outputDir, safeSessionDirectoryName(params.sessionId));
  const outputPath = path.join(sessionDir, 'session.json');

  if (params.resume && (await fileExists(outputPath))) {
    return {
      session_id: params.sessionId,
      status: 'skipped_existing',
      output_path: outputPath,
    };
  }

  try {
    const [sessionTrace, sessionMessages] = await Promise.all([
      params.api.getSessionTrace(params.sessionId),
      params.api.getSessionMessages(params.sessionId),
    ]);
    const messageCount = getMessagesCount(sessionMessages);
    const pseudonymizedTrace = pseudonymizeAdminSessionTrace(sessionTrace, params.pseudonymKey);
    const artifact = {
      export_format: EXPORT_FORMAT,
      exported_at: params.exportedAt,
      session_id: params.sessionId,
      admin_session_trace: pseudonymizedTrace.trace,
      admin_session_messages: sessionMessages,
    };
    const redactedArtifact = redactHighConfidenceSecrets(artifact, params.pseudonymKey);
    const serializedArtifact = JSON.stringify(redactedArtifact.value, null, 2) + '\n';

    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    await writeFile(outputPath, serializedArtifact, { encoding: 'utf8', mode: 0o600 });

    return {
      session_id: params.sessionId,
      status: 'exported',
      output_path: outputPath,
      byte_size: Buffer.byteLength(serializedArtifact, 'utf8'),
      message_count: messageCount,
      empty_messages: messageCount === 0,
    };
  } catch (error) {
    return {
      session_id: params.sessionId,
      status: isNotFoundError(error) ? 'not_found' : 'failed',
      error: sanitizeErrorMessage(error),
    };
  }
}

function getMessagesCount(sessionMessages: unknown): number | null {
  const payload = getObject(sessionMessages);
  return Array.isArray(payload?.messages) ? payload.messages.length : null;
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
  manifestEntries: ExportManifestEntry[],
  status: ExportManifestEntry['status']
): number {
  return manifestEntries.filter(entry => entry.status === status).length;
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof AdminTrpcError && (error.status === 404 || error.trpcCode === 'NOT_FOUND')
  );
}

export function sanitizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return raw
    .replaceAll(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replaceAll(/[\r\n\t]+/g, ' ')
    .replaceAll(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 500);
}

export function parseCliOptions(args: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  let inputPath = '';
  let outputDir = '';
  let baseUrl = env.KILOCODE_ADMIN_API_BASE_URL ?? '';
  let concurrency = DEFAULT_CONCURRENCY;
  let resume = false;
  let maxAttempts = DEFAULT_MAX_ATTEMPTS;
  let tokenEnv = DEFAULT_TOKEN_ENV;
  let pseudonymKeyEnv = ADMIN_SESSION_TRACE_PSEUDONYM_KEY_ENV;
  let truffleHogMode = DEFAULT_TRUFFLEHOG_MODE;

  for (const arg of args) {
    if (arg === '--resume') {
      resume = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith('--input=')) {
      inputPath = arg.slice('--input='.length);
    } else if (arg.startsWith('--output=')) {
      outputDir = arg.slice('--output='.length);
    } else if (arg.startsWith('--base-url=')) {
      baseUrl = arg.slice('--base-url='.length);
    } else if (arg.startsWith('--token-env=')) {
      tokenEnv = arg.slice('--token-env='.length);
    } else if (arg.startsWith('--pseudonym-key-env=')) {
      pseudonymKeyEnv = arg.slice('--pseudonym-key-env='.length);
    } else if (arg.startsWith('--concurrency=')) {
      concurrency = parsePositiveInteger(arg, '--concurrency=');
    } else if (arg.startsWith('--trufflehog=')) {
      truffleHogMode = parseTruffleHogMode(arg.slice('--trufflehog='.length));
    } else if (arg.startsWith('--max-attempts=')) {
      maxAttempts = parsePositiveInteger(arg, '--max-attempts=');
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!inputPath) throw new Error('Missing required argument: --input=<path>');
  if (!outputDir) throw new Error('Missing required argument: --output=<dir>');
  if (!baseUrl) {
    throw new Error(
      'Missing admin API base URL: pass --base-url=<url> or set KILOCODE_ADMIN_API_BASE_URL'
    );
  }
  if (!tokenEnv) throw new Error('--token-env cannot be empty');
  if (!pseudonymKeyEnv) throw new Error('--pseudonym-key-env cannot be empty');

  const authToken = env[tokenEnv] ?? '';
  if (!authToken.trim()) {
    throw new Error(`Missing admin API token in environment variable ${tokenEnv}`);
  }

  return {
    inputPath,
    outputDir,
    baseUrl: normalizeAdminApiBaseUrl(baseUrl),
    authToken,
    pseudonymKey: requirePseudonymKey(
      env[pseudonymKeyEnv],
      `environment variable ${pseudonymKeyEnv}`
    ),
    concurrency,
    resume,
    maxAttempts,
    truffleHogMode,
    tokenEnv,
    pseudonymKeyEnv,
  };
}

function parseTruffleHogMode(value: string): TruffleHogMode {
  if (value === 'auto' || value === 'binary' || value === 'docker' || value === 'off') {
    return value;
  }
  throw new Error(`Invalid --trufflehog value: ${value}`);
}

function parsePositiveInteger(arg: string, prefix: string): number {
  const parsed = Number.parseInt(arg.slice(prefix.length), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${prefix.slice(0, -1)} value: ${arg}`);
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Export admin-visible session trace bundles from a CSV.

Usage:
  KILOCODE_ADMIN_API_TOKEN=... ${ADMIN_SESSION_TRACE_PSEUDONYM_KEY_ENV}=... pnpm script src/scripts/session-traces/export-admin-session-traces.ts \\
    --base-url=https://app.kilo.ai \\
    --input=/path/to/session-ids.csv \\
    --output=/path/to/export-dir [--concurrency=5] [--resume] \\
    [--trufflehog=auto|binary|docker|off]

Required:
  --input=<path>       CSV containing a session_id-style column.
  --output=<dir>       Explicit directory for sensitive exported artifacts.
  --base-url=<url>     Admin web app base URL, or set KILOCODE_ADMIN_API_BASE_URL.

Authentication and pseudonymization:
  Set KILOCODE_ADMIN_API_TOKEN to an admin-capable Kilo API JWT, or use
  --token-env=<name> to point at another environment variable. Set
  ${ADMIN_SESSION_TRACE_PSEUDONYM_KEY_ENV}, or use --pseudonym-key-env=<name>,
  to HMAC-pseudonymize exported account fields. Raw secrets are not accepted as
  command-line flags.

Notes:
  This no-server-changes exporter uses current Admin tRPC endpoints. It writes
  admin metadata plus full returned messages, not the raw session-ingest
  { info, messages } snapshot. The direct account fields in admin_session_trace
  are HMAC-pseudonymized and high-confidence credential formats are redacted, but
  exported files remain sensitive customer data. TruffleHog scans the completed
  export in auto mode by default; findings are stored as sanitized metadata only.`);
}

export async function run(...args: string[]): Promise<void> {
  const options = parseCliOptions(args.length > 0 ? args : process.argv.slice(2));
  console.log('Exporting admin-visible session trace bundles');
  console.log(`Input CSV:     ${path.resolve(options.inputPath)}`);
  console.log(`Output dir:    ${path.resolve(options.outputDir)}`);
  console.log(`Admin API:     ${options.baseUrl}`);
  console.log(`Token env:     ${options.tokenEnv}`);
  console.log(`Hash key env:  ${options.pseudonymKeyEnv}`);
  console.log(`Concurrency:   ${options.concurrency}`);
  console.log(`Resume:        ${options.resume ? 'yes' : 'no'}`);
  console.log(`TruffleHog:    ${options.truffleHogMode}`);
  console.log('Payload scope: admin session metadata + returned messages; sensitive content.');

  const summary = await exportAdminSessionTraces(options);

  console.log('\nExport complete');
  console.log(`Exported:      ${summary.exported}`);
  console.log(`Skipped:       ${summary.skipped_existing}`);
  console.log(`Not found:     ${summary.not_found}`);
  console.log(`Failed:        ${summary.failed}`);
  console.log(`Empty messages:${summary.empty_message_bundles}`);
  console.log(`Manifest:      ${summary.manifest_path}`);
  console.log(`Summary:       ${summary.summary_path}`);
  console.log(`Secret scan:   ${summary.secret_scan.status}`);
  console.log(`Scan findings: ${summary.secret_scan.finding_count}`);
  if (summary.secret_scan.findings_path) {
    console.log(`Findings:      ${summary.secret_scan.findings_path}`);
  }
  if (
    summary.secret_scan.status === 'findings' ||
    summary.secret_scan.status === 'unavailable' ||
    summary.secret_scan.status === 'error'
  ) {
    process.exitCode = 1;
  }
}

const isDirectScriptInvocation = process.argv[1]?.endsWith('export-admin-session-traces.ts');
if (isDirectScriptInvocation) {
  void run().catch(error => {
    console.error(`Fatal export error: ${sanitizeErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
