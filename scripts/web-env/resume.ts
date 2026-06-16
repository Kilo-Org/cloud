import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isRecord, readString } from './json.js';
import type { VercelWriteOperation } from './plan.js';

export type ResumeJournal = {
  version: 1;
  variableName: string;
  sensitive: boolean;
  createdAt: string;
  completed: string[];
  failed: string;
  pending: string[];
  onePassword: 'completed' | 'failed' | 'pending' | 'skipped';
};

export function operationId(operation: VercelWriteOperation): string {
  return `${operation.project}/${operation.environment}`;
}

export async function writeResumeJournal(
  repoRoot: string,
  journal: ResumeJournal
): Promise<string> {
  const directory = path.join(repoRoot, '.tmp', 'web-env');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const safeTimestamp = journal.createdAt.replace(/[:.]/g, '-');
  const destination = path.join(directory, `${journal.variableName}-${safeTimestamp}.json`);
  await writeFile(destination, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  return path.relative(repoRoot, destination);
}

function readStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return undefined;
  return value;
}

export async function readResumeJournal(filePath: string): Promise<ResumeJournal> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    throw new Error('The resume journal is missing or invalid.');
  }
  if (!isRecord(parsed)) throw new Error('The resume journal has an unexpected format.');

  const variableName = readString(parsed, 'variableName');
  const createdAt = readString(parsed, 'createdAt');
  const completed = readStringArray(parsed, 'completed');
  const failed = readString(parsed, 'failed');
  const pending = readStringArray(parsed, 'pending');
  const onePassword = readString(parsed, 'onePassword');
  if (
    parsed.version !== 1 ||
    !variableName ||
    typeof parsed.sensitive !== 'boolean' ||
    !createdAt ||
    !completed ||
    !failed ||
    !pending ||
    (onePassword !== 'completed' &&
      onePassword !== 'failed' &&
      onePassword !== 'pending' &&
      onePassword !== 'skipped')
  ) {
    throw new Error('The resume journal has an unexpected format.');
  }

  return {
    version: 1,
    variableName,
    sensitive: parsed.sensitive,
    createdAt,
    completed,
    failed,
    pending,
    onePassword,
  };
}
