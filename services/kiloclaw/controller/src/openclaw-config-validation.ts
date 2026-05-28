import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const VALIDATION_TIMEOUT_MS = 30_000;
const VALIDATION_MAX_OUTPUT_BYTES = 1_048_576;
const VALIDATION_MAX_ISSUES = 20;
const VALIDATION_MAX_TEXT_LENGTH = 500;
export const VALIDATION_STAGE_FILENAME = '.openclaw.kiloclaw-validation-candidate.json';

export function isOpenclawValidationArtifactPath(relativePath: string): boolean {
  return (
    relativePath === VALIDATION_STAGE_FILENAME ||
    relativePath.startsWith(`${VALIDATION_STAGE_FILENAME}.`)
  );
}

const ValidationIssueSchema = z.object({
  path: z.string().optional(),
  message: z.string(),
  allowedValues: z.array(z.string()).optional(),
});

const ValidationOutputSchema = z.object({
  valid: z.boolean(),
  issues: z.array(ValidationIssueSchema).optional(),
  error: z.string().optional(),
});

export type OpenclawConfigValidationIssue = {
  path: string;
  message: string;
  allowedValues?: string[];
};

export type OpenclawConfigValidationResult =
  | { valid: true }
  | {
      valid: false;
      reason: 'invalid' | 'validation-unavailable';
      issues: OpenclawConfigValidationIssue[];
    };

type CommandResult = {
  stdout: string;
  timedOut: boolean;
};

export type OpenclawConfigValidationDeps = {
  readCandidate: (filePath: string) => string;
  removeFile: (filePath: string) => void;
  writeCandidate: (filePath: string, candidate: string) => void;
  runValidation: (stagePath: string) => Promise<CommandResult>;
};

function errorCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return 'unknown';
}

function isMissingFileError(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function removeFileIfPresent(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

const defaultDeps: OpenclawConfigValidationDeps = {
  readCandidate: filePath => fs.readFileSync(filePath, 'utf8'),
  removeFile: removeFileIfPresent,
  writeCandidate: (filePath, candidate) => {
    fs.writeFileSync(filePath, candidate, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  },
  runValidation: stagePath =>
    new Promise(resolve => {
      execFile(
        'openclaw',
        ['config', 'validate', '--json'],
        {
          env: { ...process.env, OPENCLAW_CONFIG_PATH: stagePath },
          timeout: VALIDATION_TIMEOUT_MS,
          maxBuffer: VALIDATION_MAX_OUTPUT_BYTES,
          encoding: 'utf8',
        },
        (error, stdout) => {
          resolve({ stdout, timedOut: error?.killed === true });
        }
      );
    }),
};

function clampDiagnosticText(value: string): string {
  const withoutControlChars = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (withoutControlChars.length <= VALIDATION_MAX_TEXT_LENGTH) {
    return withoutControlChars;
  }
  return `${withoutControlChars.slice(0, VALIDATION_MAX_TEXT_LENGTH - 1)}…`;
}

function redactStagingPath(value: string, stagePath: string): string {
  return value
    .replaceAll(stagePath, 'openclaw.json')
    .replaceAll(path.basename(stagePath), 'openclaw.json');
}

function normalizeIssues(
  issues: z.infer<typeof ValidationIssueSchema>[],
  stagePath: string
): OpenclawConfigValidationIssue[] {
  return issues.slice(0, VALIDATION_MAX_ISSUES).map(issue => ({
    path: clampDiagnosticText(redactStagingPath(issue.path ?? '', stagePath)),
    message: clampDiagnosticText(redactStagingPath(issue.message, stagePath)),
    ...(issue.allowedValues
      ? {
          allowedValues: issue.allowedValues
            .slice(0, 20)
            .map(value => clampDiagnosticText(redactStagingPath(value, stagePath))),
        }
      : undefined),
  }));
}

function unavailableIssue(message: string): OpenclawConfigValidationResult {
  return {
    valid: false,
    reason: 'validation-unavailable',
    issues: [{ path: '', message }],
  };
}

function unexpectedValidationFailure(error: unknown): OpenclawConfigValidationResult {
  switch (errorCode(error)) {
    case 'ENOSPC':
      return unavailableIssue('There is not enough disk space to validate this configuration.');
    case 'EACCES':
    case 'EPERM':
      return unavailableIssue('OpenClaw cannot access the temporary validation file.');
    case 'EEXIST':
      return unavailableIssue('Configuration validation is already in progress. Try saving again.');
    default:
      return unavailableIssue('OpenClaw configuration validation could not be started.');
  }
}

function referencesTargetConfig(value: unknown, configPath: string): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (const entry of current) pending.push(entry);
      continue;
    }
    if (typeof current !== 'object' || current === null) {
      continue;
    }

    for (const [key, nestedValue] of Object.entries(current)) {
      if (key === '$include') {
        const includes = Array.isArray(nestedValue) ? nestedValue : [nestedValue];
        if (
          includes.some(
            include =>
              typeof include === 'string' &&
              path.resolve(path.dirname(configPath), include) === path.resolve(configPath)
          )
        ) {
          return true;
        }
      }
      pending.push(nestedValue);
    }
  }
  return false;
}

function candidateInspectionWarning(candidate: string, configPath: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return 'This save path validates strict JSON only. Convert JSON5 syntax before saving.';
  }
  if (referencesTargetConfig(parsed, configPath)) {
    return 'This config includes openclaw.json itself, so it cannot be validated safely before saving.';
  }
  return null;
}

export async function validateOpenclawConfigCandidate(
  candidate: string,
  configPath: string,
  deps: OpenclawConfigValidationDeps = defaultDeps
): Promise<OpenclawConfigValidationResult> {
  const inspectionWarning = candidateInspectionWarning(candidate, configPath);
  if (inspectionWarning) {
    return unavailableIssue(inspectionWarning);
  }

  const stagePath = path.join(path.dirname(configPath), VALIDATION_STAGE_FILENAME);
  const stageBackupPath = `${stagePath}.bak`;
  try {
    deps.removeFile(stagePath);
    deps.removeFile(stageBackupPath);
    deps.writeCandidate(stagePath, candidate);
    const commandResult = await deps.runValidation(stagePath);
    if (commandResult.timedOut) {
      return unavailableIssue('OpenClaw configuration validation timed out.');
    }

    let rawResult: unknown;
    try {
      rawResult = JSON.parse(commandResult.stdout);
    } catch {
      return unavailableIssue('OpenClaw configuration validation returned an unreadable result.');
    }
    const result = ValidationOutputSchema.safeParse(rawResult);
    if (!result.success) {
      return unavailableIssue('OpenClaw configuration validation returned an unreadable result.');
    }
    if (result.data.valid) {
      if (deps.readCandidate(stagePath) !== candidate) {
        return unavailableIssue('OpenClaw configuration changed during validation.');
      }
      return { valid: true };
    }
    if (result.data.issues && result.data.issues.length > 0) {
      return {
        valid: false,
        reason: 'invalid',
        issues: normalizeIssues(result.data.issues, stagePath),
      };
    }
    return unavailableIssue('OpenClaw could not validate this configuration.');
  } catch (error) {
    console.error('[openclaw-config-validation] Validation failed unexpectedly:', errorCode(error));
    return unexpectedValidationFailure(error);
  } finally {
    try {
      deps.removeFile(stagePath);
      deps.removeFile(stageBackupPath);
    } catch (error) {
      console.warn('[openclaw-config-validation] Staging cleanup failed:', errorCode(error));
    }
  }
}
