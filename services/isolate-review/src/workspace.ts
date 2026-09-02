import { createReadTool, WorkspaceFileStore } from '@cloudflare/computer/tools';
import { tool } from 'ai';
import { RE2JS } from 're2js';
import { z } from 'zod';
import type { ReviewWorkspace } from './git';
import { isGitPath } from './paths';

export const MAX_REVIEW_READ_LINES = 2_000;
export const MAX_REVIEW_READ_OUTPUT_BYTES = 16 * 1024;
export const MAX_REVIEW_READ_LINE_BYTES = 2 * 1024;
const MAX_REVIEW_READ_MEDIA_BYTES = 3.5 * 1024 * 1024;

export function createReviewReadTool(workspace: ReviewWorkspace) {
  const store = new WorkspaceFileStore(workspace);
  const stat = async (path: string) => {
    const info = await workspace.stat(path);
    return info?.type === 'file' ? { size: info.size, mtime: info.updatedAt } : null;
  };

  return createReadTool({
    store: {
      stat,
      async *readChunks(path, byteOffset, byteLength) {
        if (!(await stat(path))) {
          throw Object.assign(new Error(`File not found: ${path}`), { code: 'ENOENT' });
        }
        yield* store.readChunks(path, byteOffset, byteLength);
      },
      async readAll(path) {
        const info = await stat(path);
        if (!info || info.size > MAX_REVIEW_READ_MEDIA_BYTES) return null;
        return workspace.readFileBytes(path);
      },
      async write() {
        throw new Error('Review workspace is read-only');
      },
    },
    maxLines: MAX_REVIEW_READ_LINES,
    maxBytes: MAX_REVIEW_READ_OUTPUT_BYTES,
    includeLineNumbers: true,
    lineTruncation: { bytes: MAX_REVIEW_READ_LINE_BYTES },
    maxModelBytes: MAX_REVIEW_READ_MEDIA_BYTES,
  });
}

export const MAX_REVIEW_GREP_LINE_BYTES = 2 * 1024;
export const MAX_REVIEW_GREP_OUTPUT_BYTES = 64 * 1024;

const MAX_GREP_MATCHES = 200;
const MAX_GREP_FILE_BYTES = 1024 * 1024;
const MAX_GREP_CONTEXT_LINES = 10;
const GREP_LINE_TRUNCATED = '... (truncated)';
const GREP_READ_FOLLOWUP =
  'Use read with path, offset and limit around the returned line numbers; narrow query or include to continue searching. Long lines may also be truncated by read. Truncated output is incomplete evidence.';

type ReviewGrepMatch = string | { file: string; line: number; context: string };

function isHiddenGitPath(path: string): boolean {
  return isGitPath(path) || path.split('/').includes('.git');
}

async function isHiddenWorkspacePath(
  workspace: ReviewWorkspace,
  path: string,
  checks = new Map<string, Promise<boolean>>()
): Promise<boolean> {
  if (isHiddenGitPath(path)) return true;

  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }

  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    let check = checks.get(current);
    if (!check) {
      check = workspace.fs.lstat(current).then(
        stat => stat.isSymbolicLink,
        (error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
          throw error;
        }
      );
      checks.set(current, check);
    }
    if (await check) return true;
  }

  return false;
}

export function createSafeReviewWorkspace(workspace: ReviewWorkspace): ReviewWorkspace {
  return new Proxy(workspace, {
    get(target, property) {
      if (property === 'glob') {
        return async (pattern: string) => {
          const entries = await target.glob(pattern);
          const checks = new Map<string, Promise<boolean>>();
          const sizedEntries = await Promise.all(
            entries.map(async entry => {
              if (await isHiddenWorkspacePath(target, entry.path, checks)) return null;
              const stat = await target.stat(entry.path);
              return stat === null ? null : { ...entry, size: stat.size };
            })
          );

          return sizedEntries.filter(entry => entry !== null);
        };
      }

      if (property === 'readFile' || property === 'readFileBytes' || property === 'stat') {
        return async (path: string) => {
          if (await isHiddenWorkspacePath(target, path)) return null;
          return target[property](path);
        };
      }

      if (property === 'readDir') {
        return async (path: string, options?: Parameters<ReviewWorkspace['readDir']>[1]) => {
          const checks = new Map<string, Promise<boolean>>();
          if (await isHiddenWorkspacePath(target, path, checks)) return [];
          const entries = await target.readDir(path, options);
          const visibleEntries = await Promise.all(
            entries.map(async entry =>
              (await isHiddenWorkspacePath(target, entry.path, checks)) ? null : entry
            )
          );
          return visibleEntries.filter(entry => entry !== null);
        };
      }

      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;

      const bound: unknown = value.bind(target);
      return bound;
    },
  });
}

export function createReviewGrepTool(workspace: ReviewWorkspace) {
  return tool({
    description:
      'Search file contents using an RE2 regular expression (no lookaround or backreferences) or fixed string. Returns matching lines with file paths and line numbers. Searches all files matching the include glob, or all files if not specified. Line previews and total output are byte-bounded; truncated evidence requires follow-up reads or a narrower search.',
    inputSchema: z.object({
      query: z.string().describe('Search pattern (regex or fixed string)'),
      include: z
        .string()
        .optional()
        .describe('Glob pattern to filter files (e.g. "**/*.ts"). Defaults to "**/*"'),
      fixedString: z
        .boolean()
        .optional()
        .describe('If true, treat query as a literal string instead of regex'),
      caseSensitive: z
        .boolean()
        .optional()
        .describe('If true, search is case-sensitive (default: false)'),
      contextLines: z
        .number()
        .int()
        .min(0)
        .max(MAX_GREP_CONTEXT_LINES)
        .optional()
        .describe('Number of context lines around each match (default: 0)'),
    }),
    execute: async ({ query, include, fixedString, caseSensitive, contextLines }) => {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
      const lineBuffer = new Uint8Array(MAX_REVIEW_GREP_LINE_BYTES);
      const byteLength = (value: string) => encoder.encode(value).byteLength;
      const preview = (value: string) => {
        const encoded = encoder.encodeInto(value, lineBuffer);
        const truncated = encoded.read < value.length;
        const written = truncated
          ? encoder.encodeInto(
              value,
              lineBuffer.subarray(0, lineBuffer.length - GREP_LINE_TRUNCATED.length)
            ).written
          : encoded.written;
        return {
          text:
            decoder.decode(lineBuffer.subarray(0, written)) +
            (truncated ? GREP_LINE_TRUNCATED : ''),
          truncated,
        };
      };
      const boundedQuery = preview(query);
      let regex: RE2JS;
      try {
        regex = RE2JS.compile(
          fixedString ? query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : query,
          caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE
        );
      } catch {
        return { error: `Invalid regex: ${boundedQuery.text}` };
      }

      const files = (await workspace.glob(include ?? '**/*')).filter(file => file.type === 'file');
      const ctx = Math.min(contextLines ?? 0, MAX_GREP_CONTEXT_LINES);
      const matches: ReviewGrepMatch[] = [];
      const truncation = {
        lineTextBytes: MAX_REVIEW_GREP_LINE_BYTES,
        outputBytes: MAX_REVIEW_GREP_OUTPUT_BYTES,
        matchLimit: MAX_GREP_MATCHES,
        contextLines: MAX_GREP_CONTEXT_LINES,
        truncatedLines: 0,
        outputLimitReached: false,
        matchLimitReached: false,
        queryTruncated: boundedQuery.truncated,
      };
      const skippedNote = (count: number) => `${count} file(s) skipped (larger than 1 MB)`;
      let remainingBytes =
        MAX_REVIEW_GREP_OUTPUT_BYTES -
        byteLength(
          JSON.stringify({
            query: boundedQuery.text,
            filesSearched: files.length,
            filesWithMatches: files.length,
            totalMatches: MAX_GREP_MATCHES,
            matches: [],
            filesSkipped: files.length,
            note: skippedNote(files.length),
            truncated: true,
            truncation: {
              ...truncation,
              truncatedLines: MAX_GREP_MATCHES * (2 * MAX_GREP_CONTEXT_LINES + 1),
            },
            readFollowup: GREP_READ_FOLLOWUP,
          })
        );
      let filesSearched = 0;
      let filesWithMatches = 0;
      let filesSkipped = 0;

      search: for (const file of files) {
        if (file.size > MAX_GREP_FILE_BYTES) {
          filesSkipped++;
          continue;
        }
        const content = await workspace.readFile(file.path);
        if (content === null) continue;
        filesSearched++;
        const lines = content.split('\n');
        let fileHasMatch = false;
        for (let index = 0; index < lines.length; index++) {
          if (!regex.test(lines[index])) continue;
          if (file.path.length > remainingBytes) {
            truncation.outputLimitReached = true;
            break search;
          }

          const line = index + 1;
          const matchedLine = preview(lines[index]);
          let truncatedLines = Number(matchedLine.truncated);
          const match: ReviewGrepMatch =
            ctx > 0
              ? { file: file.path, line, context: `> ${line}\t${matchedLine.text}` }
              : `${file.path}:${line}: ${matchedLine.text}`;
          let matchBytes = byteLength(JSON.stringify(match)) + (matches.length > 0 ? 1 : 0);
          if (matchBytes > remainingBytes) {
            truncation.outputLimitReached = true;
            break search;
          }

          if (typeof match !== 'string') {
            const context = [match.context];
            const appendContext = (contextIndex: number, before: boolean) => {
              const contextLine = preview(lines[contextIndex]);
              const formatted = `  ${contextIndex + 1}\t${contextLine.text}`;
              const bytes = byteLength(JSON.stringify(formatted));
              if (matchBytes + bytes > remainingBytes) {
                truncation.outputLimitReached = true;
                return false;
              }
              if (before) context.unshift(formatted);
              else context.push(formatted);
              matchBytes += bytes;
              truncatedLines += Number(contextLine.truncated);
              return true;
            };
            for (let before = index - 1; before >= Math.max(0, index - ctx); before--) {
              if (!appendContext(before, true)) break;
            }
            if (!truncation.outputLimitReached) {
              for (
                let after = index + 1;
                after < Math.min(lines.length, index + ctx + 1);
                after++
              ) {
                if (!appendContext(after, false)) break;
              }
            }
            match.context = context.join('\n');
          }

          matches.push(match);
          remainingBytes -= matchBytes;
          truncation.truncatedLines += truncatedLines;
          if (!fileHasMatch) {
            filesWithMatches++;
            fileHasMatch = true;
          }
          truncation.matchLimitReached = matches.length >= MAX_GREP_MATCHES;
          if (truncation.outputLimitReached || truncation.matchLimitReached) break search;
        }
      }

      const truncated =
        truncation.truncatedLines > 0 ||
        truncation.outputLimitReached ||
        truncation.matchLimitReached ||
        truncation.queryTruncated;
      return {
        query: boundedQuery.text,
        filesSearched,
        filesWithMatches,
        totalMatches: matches.length,
        matches,
        ...(filesSkipped > 0 ? { filesSkipped, note: skippedNote(filesSkipped) } : {}),
        ...(truncated ? { truncated: true, truncation, readFollowup: GREP_READ_FOLLOWUP } : {}),
      };
    },
  });
}
