import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CommandExecutor } from './command.js';
import { requireSuccess } from './command.js';
import type { EnvironmentValues } from './plan.js';

export type DotenvPatch = {
  relativePath: string;
  absolutePath: string;
  before: string;
  after: string;
  existed: boolean;
  defaultValue: string;
};

type ValueSpan = {
  start: number;
  end: number;
  rawValue: string;
};

function isManagedDotenvPath(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join('/');
  const inScope = !normalized.includes('/') || normalized.startsWith('apps/web/');
  if (!inScope) return false;

  const basename = path.posix.basename(normalized);
  if (!basename.startsWith('.env') || basename === '.envrc') return false;
  if (basename.includes('.local') && !basename.includes('.example')) return false;
  return true;
}

export async function discoverTrackedDotenvFiles(
  repoRoot: string,
  execute: CommandExecutor
): Promise<string[]> {
  const result = await execute({
    command: 'git',
    args: ['ls-files', '-z', '--', '.env*', 'apps/web/.env*'],
    cwd: repoRoot,
  });
  const stdout = requireSuccess(result, 'Tracked dotenv discovery');
  return stdout.split('\0').filter(Boolean).filter(isManagedDotenvPath).sort();
}

function findClosingQuote(value: string, quote: '"' | "'", start: number): number | undefined {
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quote === '"' && character === '\\' && !escaped) {
      escaped = true;
      continue;
    }
    if (character === quote && !escaped) return index;
    escaped = false;
  }
  return undefined;
}

function assignmentValueStarts(content: string, key: string): number[] {
  const starts: number[] = [];
  const assignmentPattern = new RegExp(
    `^([ \\t]*(?:export[ \\t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \\t]*=[ \\t]*)(.*)$`
  );
  let openQuote: '"' | "'" | undefined;
  let offset = 0;

  while (offset <= content.length) {
    const newline = content.indexOf('\n', offset);
    const lineEnd = newline === -1 ? content.length : newline;
    const line = content.slice(offset, lineEnd);

    if (openQuote) {
      if (findClosingQuote(line, openQuote, 0) !== undefined) openQuote = undefined;
    } else {
      const assignment = assignmentPattern.exec(line);
      const prefix = assignment?.[1];
      const assignmentKey = assignment?.[2];
      const rawValue = assignment?.[3];
      if (prefix !== undefined && assignmentKey !== undefined && rawValue !== undefined) {
        if (assignmentKey === key) starts.push(offset + prefix.length);
        const quote = rawValue[0];
        if (
          (quote === '"' || quote === "'") &&
          findClosingQuote(rawValue, quote, 1) === undefined
        ) {
          openQuote = quote;
        }
      }
    }

    if (newline === -1) break;
    offset = newline + 1;
  }
  return starts;
}

export function countKeyAssignments(content: string, key: string): number {
  return assignmentValueStarts(content, key).length;
}

function findValueSpan(content: string, key: string): ValueSpan {
  const starts = assignmentValueStarts(content, key);
  const start = starts[0];
  if (start === undefined) throw new Error(`Could not parse the existing ${key} assignment.`);
  const quote = content[start];

  if (quote === '"' || quote === "'") {
    let escaped = false;
    for (let index = start + 1; index < content.length; index += 1) {
      const character = content[index];
      if (quote === '"' && character === '\\' && !escaped) {
        escaped = true;
        continue;
      }
      if (character === quote && !escaped) {
        return { start, end: index + 1, rawValue: content.slice(start, index + 1) };
      }
      escaped = false;
    }
    throw new Error(`Could not find the closing quote for ${key}.`);
  }

  let lineEnd = content.indexOf('\n', start);
  if (lineEnd === -1) lineEnd = content.length;
  let end = lineEnd;
  for (let index = start; index < lineEnd; index += 1) {
    if (content[index] === '#' && (index === start || /\s/.test(content[index - 1] ?? ''))) {
      end = index;
      break;
    }
  }
  while (end > start && /[ \t]/.test(content[end - 1] ?? '')) end -= 1;
  return { start, end, rawValue: content.slice(start, end) };
}

function preferredQuote(rawValue: string): 'single' | 'double' | undefined {
  if (rawValue.startsWith("'") && rawValue.endsWith("'")) return 'single';
  if (rawValue.startsWith('"') && rawValue.endsWith('"')) return 'double';
  return undefined;
}

export function formatDotenvValue(
  value: string,
  quote: 'single' | 'double' | undefined = undefined
): string {
  if (quote === 'single' && !value.includes("'") && !value.includes('\n')) {
    return `'${value}'`;
  }
  const requiresQuotes =
    quote === 'double' ||
    value.includes('\n') ||
    value.includes('\r') ||
    value.includes(' ') ||
    value.includes('#') ||
    value.includes('"') ||
    value.includes("'");
  if (!requiresQuotes) return value;
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/"/g, '\\"')}"`;
}

export function patchDotenvContent(
  content: string,
  key: string,
  defaultValue: string
): { content: string; existed: boolean } {
  const count = countKeyAssignments(content, key);
  if (count > 1) {
    throw new Error(`Cannot patch ${key}: it is declared more than once in the same file.`);
  }

  if (count === 1) {
    const span = findValueSpan(content, key);
    const replacement = formatDotenvValue(defaultValue, preferredQuote(span.rawValue));
    return {
      content: `${content.slice(0, span.start)}${replacement}${content.slice(span.end)}`,
      existed: true,
    };
  }

  const separator = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  return {
    content: `${content}${separator}${key}=${formatDotenvValue(defaultValue)}\n`,
    existed: false,
  };
}

export async function createDotenvPatch(
  repoRoot: string,
  relativePath: string,
  key: string,
  defaultValue: string
): Promise<DotenvPatch> {
  const absolutePath = path.join(repoRoot, relativePath);
  const before = await readFile(absolutePath, 'utf8');
  const patched = patchDotenvContent(before, key, defaultValue);
  return {
    relativePath,
    absolutePath,
    before,
    after: patched.content,
    existed: patched.existed,
    defaultValue,
  };
}

function secretRepresentations(value: string): string[] {
  const representations = new Set([value, formatDotenvValue(value), JSON.stringify(value)]);
  if (!value.includes("'") && !value.includes('\n')) representations.add(`'${value}'`);
  return [...representations].filter(Boolean);
}

export async function assertNoEnvironmentValuesInTrackedFiles(
  repoRoot: string,
  relativePaths: string[],
  patches: DotenvPatch[],
  values: EnvironmentValues
): Promise<void> {
  const patchesByPath = new Map(patches.map(patch => [patch.relativePath, patch]));
  for (const relativePath of relativePaths) {
    const patch = patchesByPath.get(relativePath);
    const content = patch?.after ?? (await readFile(path.join(repoRoot, relativePath), 'utf8'));
    for (const value of Object.values(values)) {
      if (secretRepresentations(value).some(representation => content.includes(representation))) {
        throw new Error(
          `Refusing to continue: a real environment value appears in tracked file ${relativePath}.`
        );
      }
    }
  }
}

export function renderDotenvPatchPreview(patches: DotenvPatch[], key: string): string {
  const lines: string[] = [];
  for (const patch of patches) {
    lines.push(`diff -- ${patch.relativePath}`);
    lines.push(`@@ ${key} @@`);
    if (patch.existed) lines.push(`-${key}=<redacted existing tracked value>`);
    lines.push(`+${key}=${formatDotenvValue(patch.defaultValue)}`);
  }
  return lines.join('\n');
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const fileStat = await stat(filePath);
  const temporaryPath = `${filePath}.web-env-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporaryPath, content, { mode: fileStat.mode });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function applyDotenvPatches(patches: DotenvPatch[]): Promise<void> {
  const applied: DotenvPatch[] = [];
  try {
    for (const patch of patches) {
      await atomicWrite(patch.absolutePath, patch.after);
      applied.push(patch);
    }
  } catch (error) {
    await restoreDotenvPatches(applied);
    throw error;
  }
}

export async function restoreDotenvPatches(patches: DotenvPatch[]): Promise<void> {
  for (const patch of patches) {
    await atomicWrite(patch.absolutePath, patch.before);
  }
}

export async function verifyDotenvPatches(patches: DotenvPatch[], key: string): Promise<void> {
  for (const patch of patches) {
    const content = await readFile(patch.absolutePath, 'utf8');
    if (countKeyAssignments(content, key) !== 1) {
      throw new Error(`Tracked default verification failed for ${patch.relativePath}.`);
    }
    const expected = patchDotenvContent(patch.before, key, patch.defaultValue).content;
    if (content !== expected) {
      throw new Error(`Tracked default verification failed for ${patch.relativePath}.`);
    }
  }
}
