import { spawn } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

const DEFAULT_DOCKER_IMAGE = 'ghcr.io/trufflesecurity/trufflehog:3.95.3';
const FINDINGS_FILENAME = 'trufflehog-findings.jsonl';

export type TruffleHogMode = 'auto' | 'binary' | 'docker' | 'off';
export type TruffleHogRunner = 'binary' | 'docker' | null;
export type TruffleHogScanStatus = 'passed' | 'findings' | 'skipped' | 'unavailable' | 'error';

export type SanitizedTruffleHogFinding = {
  detector_name: string | null;
  detector_type: string | number | null;
  verification_state: 'verified' | 'unverified' | 'unknown';
  relative_path: string | null;
  line: number | null;
};

export type TruffleHogScanSummary = {
  tool: 'trufflehog';
  status: TruffleHogScanStatus;
  mode: TruffleHogMode;
  runner: TruffleHogRunner;
  verification: 'disabled';
  finding_count: number;
  findings_by_detector: Record<string, number>;
  findings_by_verification: Record<string, number>;
  findings_path: string | null;
  exit_code: number | null;
  error_category?:
    | 'binary_unavailable'
    | 'docker_unavailable'
    | 'scanner_unavailable'
    | 'scan_process_failed'
    | 'invalid_scanner_output';
};

export type TruffleHogScanOptions = {
  outputDir: string;
  mode: TruffleHogMode;
  truffleHogBin?: string;
  dockerBin?: string;
  dockerImage?: string;
};

type ProcessRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError: NodeJS.ErrnoException | null;
};

type ScannerDependencies = {
  commandExists?: (command: string) => Promise<boolean>;
  runProcess?: (command: string, args: string[]) => Promise<ProcessRunResult>;
};

export async function scanExportDirectoryWithTruffleHog(
  options: TruffleHogScanOptions,
  dependencies: ScannerDependencies = {}
): Promise<TruffleHogScanSummary> {
  if (options.mode === 'off') {
    return emptySummary({ mode: options.mode, status: 'skipped' });
  }

  const outputDir = path.resolve(options.outputDir);
  const commandExists = dependencies.commandExists ?? defaultCommandExists;
  const runProcess = dependencies.runProcess ?? defaultRunProcess;
  const runner = await resolveRunner(options, commandExists);
  if (!runner) {
    return emptySummary({
      mode: options.mode,
      status: 'unavailable',
      error_category:
        options.mode === 'binary'
          ? 'binary_unavailable'
          : options.mode === 'docker'
            ? 'docker_unavailable'
            : 'scanner_unavailable',
    });
  }

  const result = await runProcess(runner.command, runner.args(outputDir));
  if (result.spawnError || (result.exitCode !== 0 && result.exitCode !== 183)) {
    return emptySummary({
      mode: options.mode,
      runner: runner.kind,
      status: 'error',
      exit_code: result.exitCode,
      error_category: 'scan_process_failed',
    });
  }

  const parsed = parseTruffleHogFindings(result.stdout, outputDir);
  if (parsed.invalidLineCount > 0) {
    return emptySummary({
      mode: options.mode,
      runner: runner.kind,
      status: 'error',
      exit_code: result.exitCode,
      error_category: 'invalid_scanner_output',
    });
  }

  const findingsPath = parsed.findings.length > 0 ? path.join(outputDir, FINDINGS_FILENAME) : null;
  if (findingsPath) {
    await writeFile(
      findingsPath,
      parsed.findings.map(finding => JSON.stringify(finding)).join('\n') + '\n',
      { encoding: 'utf8', mode: 0o600 }
    );
  }

  return {
    tool: 'trufflehog',
    status: parsed.findings.length > 0 ? 'findings' : 'passed',
    mode: options.mode,
    runner: runner.kind,
    verification: 'disabled',
    finding_count: parsed.findings.length,
    findings_by_detector: parsed.findings.reduce<Record<string, number>>((counts, finding) => {
      const key = finding.detector_name ?? 'unknown';
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}),
    findings_by_verification: parsed.findings.reduce<Record<string, number>>((counts, finding) => {
      counts[finding.verification_state] = (counts[finding.verification_state] ?? 0) + 1;
      return counts;
    }, {}),
    findings_path: findingsPath,
    exit_code: result.exitCode,
  };
}

export function parseTruffleHogFindings(
  stdout: string,
  outputDir: string
): { findings: SanitizedTruffleHogFinding[]; invalidLineCount: number } {
  const findings: SanitizedTruffleHogFinding[] = [];
  let invalidLineCount = 0;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      invalidLineCount++;
      continue;
    }
    const object = getObject(parsed);
    if (!object) {
      invalidLineCount++;
      continue;
    }
    if (!isFindingRecord(object)) {
      continue;
    }
    findings.push(sanitizeFinding(object, outputDir));
  }
  return { findings, invalidLineCount };
}

function isFindingRecord(record: Record<string, unknown>): boolean {
  return 'DetectorName' in record || 'DetectorType' in record || 'SourceMetadata' in record;
}

function sanitizeFinding(
  finding: Record<string, unknown>,
  outputDir: string
): SanitizedTruffleHogFinding {
  const verified = finding.Verified;
  return {
    detector_name: typeof finding.DetectorName === 'string' ? finding.DetectorName : null,
    detector_type:
      typeof finding.DetectorType === 'string' || typeof finding.DetectorType === 'number'
        ? finding.DetectorType
        : null,
    verification_state:
      verified === true ? 'verified' : verified === false ? 'unverified' : 'unknown',
    relative_path: extractRelativePath(finding.SourceMetadata, outputDir),
    line: extractLine(finding.SourceMetadata),
  };
}

function extractRelativePath(sourceMetadata: unknown, outputDir: string): string | null {
  const filesystem = findFilesystemMetadata(sourceMetadata);
  const candidate = filesystem?.file ?? filesystem?.path ?? filesystem?.File ?? filesystem?.Path;
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  const normalized = candidate.startsWith('/scan/')
    ? candidate.slice('/scan/'.length)
    : candidate === '/scan'
      ? '.'
      : path.isAbsolute(candidate)
        ? path.relative(outputDir, candidate)
        : candidate;
  if (!normalized || normalized.startsWith('..')) return path.basename(candidate);
  return normalized;
}

function extractLine(sourceMetadata: unknown): number | null {
  const filesystem = findFilesystemMetadata(sourceMetadata);
  const candidate = filesystem?.line ?? filesystem?.Line;
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
}

function findFilesystemMetadata(sourceMetadata: unknown): Record<string, unknown> | null {
  const source = getObject(sourceMetadata);
  const data = getObject(source?.Data) ?? source;
  return getObject(data?.Filesystem) ?? getObject(data?.FileSystem);
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function resolveRunner(
  options: TruffleHogScanOptions,
  commandExists: (command: string) => Promise<boolean>
): Promise<{
  kind: Exclude<TruffleHogRunner, null>;
  command: string;
  args: (dir: string) => string[];
} | null> {
  const truffleHogBin = options.truffleHogBin ?? 'trufflehog';
  const dockerBin = options.dockerBin ?? 'docker';
  const dockerImage = options.dockerImage ?? DEFAULT_DOCKER_IMAGE;
  if (
    (options.mode === 'auto' || options.mode === 'binary') &&
    (await commandExists(truffleHogBin))
  ) {
    return {
      kind: 'binary',
      command: truffleHogBin,
      args: dir => [
        'filesystem',
        dir,
        '--json',
        '--no-update',
        '--no-verification',
        '--fail',
        '--fail-on-scan-errors',
      ],
    };
  }
  if ((options.mode === 'auto' || options.mode === 'docker') && (await commandExists(dockerBin))) {
    return {
      kind: 'docker',
      command: dockerBin,
      args: dir => [
        'run',
        '--rm',
        '--network=none',
        '-v',
        `${dir}:/scan:ro`,
        dockerImage,
        'filesystem',
        '/scan',
        '--json',
        '--no-update',
        '--no-verification',
        '--fail',
        '--fail-on-scan-errors',
      ],
    };
  }
  return null;
}

async function defaultCommandExists(command: string): Promise<boolean> {
  const candidates = command.includes(path.sep)
    ? [command]
    : (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .map(directory => path.join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return true;
    } catch {
      // Check the next PATH entry.
    }
  }
  return false;
}

async function defaultRunProcess(command: string, args: string[]): Promise<ProcessRunResult> {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let spawnError: NodeJS.ErrnoException | null = null;
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', error => {
      spawnError = error as NodeJS.ErrnoException;
    });
    child.on('close', exitCode => {
      resolve({ exitCode, stdout, stderr, spawnError });
    });
  });
}

function emptySummary(
  partial: Pick<TruffleHogScanSummary, 'mode' | 'status'> & Partial<TruffleHogScanSummary>
): TruffleHogScanSummary {
  return {
    tool: 'trufflehog',
    status: partial.status,
    mode: partial.mode,
    runner: partial.runner ?? null,
    verification: 'disabled',
    finding_count: 0,
    findings_by_detector: {},
    findings_by_verification: {},
    findings_path: null,
    exit_code: partial.exit_code ?? null,
    ...(partial.error_category ? { error_category: partial.error_category } : {}),
  };
}
