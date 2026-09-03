import { createWorkspaceTools } from '@cloudflare/think/tools/workspace';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ReviewWorkspace } from '../../src/git';
import type { Env } from '../../src/types';
import {
  createReviewGrepTool,
  createReviewReadTool,
  createSafeReviewWorkspace,
  MAX_REVIEW_GREP_LINE_BYTES,
  MAX_REVIEW_GREP_OUTPUT_BYTES,
  MAX_REVIEW_READ_LINE_BYTES,
  MAX_REVIEW_READ_LINES,
  MAX_REVIEW_READ_OUTPUT_BYTES,
} from '../../src/workspace';

type WorkspaceEntry = Awaited<ReturnType<ReviewWorkspace['glob']>>[number];
type ReviewGrepInput = Parameters<
  NonNullable<ReturnType<typeof createReviewGrepTool>['execute']>
>[0];

function fileInfo(path: string, overrides: Partial<WorkspaceEntry> = {}): WorkspaceEntry {
  return {
    path,
    name: path.split('/').at(-1) ?? path,
    type: 'file',
    mimeType: 'application/octet-stream',
    size: 0,
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

class FakeWorkspace {
  #identity = 'original-workspace';
  readonly git = { client: 'git-client' };
  readonly missing = new Set<string>();
  readonly symlinks = new Map<string, string>();
  readonly streamedBytes = new Map<string, number>();
  readonly cancelledReads: string[] = [];
  readonly fs = {
    readFile: vi.fn(
      async (path: string, options: { byteOffset?: number; byteLength?: number } = {}) => {
        const content = this.contents.get(path);
        if (content === undefined) {
          throw Object.assign(new Error(`ENOENT: no such path: ${path}`), { code: 'ENOENT' });
        }
        const bytes = new TextEncoder().encode(content);
        let cursor = options.byteOffset ?? 0;
        const end = Math.min(bytes.byteLength, cursor + (options.byteLength ?? bytes.byteLength));
        return new ReadableStream<Uint8Array>({
          pull: controller => {
            if (cursor >= end) {
              controller.close();
              return;
            }
            const chunk = bytes.subarray(cursor, Math.min(cursor + 512, end));
            cursor += chunk.byteLength;
            this.streamedBytes.set(path, (this.streamedBytes.get(path) ?? 0) + chunk.byteLength);
            controller.enqueue(chunk);
          },
          cancel: () => {
            this.cancelledReads.push(path);
          },
        });
      }
    ),
    lstat: vi.fn(async (path: string) => {
      if (this.symlinks.has(path)) return { isSymbolicLink: true };
      if (
        !this.missing.has(path) &&
        (path === '/' ||
          path === '/workspace' ||
          this.entries.some(entry => entry.path === path || entry.path.startsWith(`${path}/`)))
      ) {
        return { isSymbolicLink: false };
      }
      throw Object.assign(new Error(`ENOENT: no such path: ${path}`), { code: 'ENOENT' });
    }),
  };
  readonly glob = vi.fn(async (_pattern: string) => this.entries);
  readonly stat = vi.fn(async (path: string) => {
    const entry = this.entries.find(candidate => candidate.path === path);
    if (!entry || this.missing.has(path)) return null;
    return { ...entry, size: this.sizes.get(path) ?? entry.size };
  });
  readonly readFile = vi.fn(async (path: string) => this.contents.get(path) ?? null);
  readonly readFileBytes = vi.fn(async (path: string) => {
    const content = this.contents.get(path);
    return content === undefined ? null : new TextEncoder().encode(content);
  });
  readonly readDir = vi.fn(
    async (path: string, options?: Parameters<ReviewWorkspace['readDir']>[1]) => {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const entries = this.entries.filter(
        entry => entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes('/')
      );
      const offset = options?.offset ?? 0;
      return entries.slice(
        offset,
        options?.limit === undefined ? undefined : offset + options.limit
      );
    }
  );

  constructor(
    readonly entries: WorkspaceEntry[],
    readonly sizes = new Map<string, number>(),
    readonly contents = new Map<string, string>()
  ) {}

  get sessionId(): string {
    return this.#identity;
  }

  provider(): string {
    return this.#identity;
  }

  asReviewWorkspace(): ReviewWorkspace {
    return this as unknown as ReviewWorkspace;
  }
}

function grepWorkspace(contents: Map<string, string>): FakeWorkspace {
  const encoder = new TextEncoder();
  return new FakeWorkspace(
    [...contents].map(([path, content]) =>
      fileInfo(path, { size: encoder.encode(content).byteLength })
    ),
    new Map(),
    contents
  );
}

async function runGrep(original: FakeWorkspace, input: ReviewGrepInput) {
  const workspace = createSafeReviewWorkspace(original.asReviewWorkspace());
  const execute = createReviewGrepTool(workspace).execute;
  if (!execute) throw new Error('Review grep tool has no execute function');
  const result = await execute(input, { toolCallId: 'review-grep', messages: [], context: {} });
  if (!('matches' in result) || !result.matches)
    throw new Error('Review grep returned no matches field');
  return result;
}

const textReadResultSchema = z.object({
  path: z.string(),
  content: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  totalLines: z.number().nullable(),
  truncated: z.boolean(),
  nextOffset: z.number().optional(),
  nextByteOffset: z.number().optional(),
});

type ReviewReadInput = Parameters<
  NonNullable<ReturnType<typeof createReviewReadTool>['execute']>
>[0];

async function runRead(original: FakeWorkspace, input: ReviewReadInput) {
  const workspace = createSafeReviewWorkspace(original.asReviewWorkspace());
  const execute = createReviewReadTool(workspace).execute;
  if (!execute) throw new Error('Review read tool has no execute function');
  return textReadResultSchema.parse(
    await execute(input, { toolCallId: 'review-read', messages: [], context: {} })
  );
}

describe('bounded review read', () => {
  it.each([undefined, Number.MAX_SAFE_INTEGER])(
    'streams a large CSV without loading or numbering the entire file with limit %s',
    async limit => {
      const path = '/workspace/data.csv';
      const original = grepWorkspace(new Map([[path, 'a,b\n'.repeat(1_500_000)]]));
      const first = await runRead(original, { path, limit });

      expect(first).toMatchObject({ startLine: 1, truncated: true, totalLines: null });
      expect(first.content.startsWith('1\ta,b\n2\ta,b')).toBe(true);
      expect(first.endLine).toBeLessThanOrEqual(MAX_REVIEW_READ_LINES);
      expect(new TextEncoder().encode(first.content).byteLength).toBeLessThanOrEqual(
        MAX_REVIEW_READ_OUTPUT_BYTES
      );
      expect(original.streamedBytes.get(path)).toBeLessThan(MAX_REVIEW_READ_OUTPUT_BYTES * 2);
      expect(original.cancelledReads).toContain(path);
      expect(original.readFile).not.toHaveBeenCalled();
      expect(original.readFileBytes).not.toHaveBeenCalled();
      expect(first.nextOffset).toBe(first.endLine + 1);
      expect(first.nextByteOffset).toBe(first.endLine * 4);

      const second = await runRead(original, {
        path,
        offset: first.nextOffset,
        byteOffset: first.nextByteOffset,
        limit: 2,
      });
      expect(second.content).toBe(`${first.endLine + 1}\ta,b\n${first.endLine + 2}\ta,b`);
      expect(original.fs.readFile).toHaveBeenLastCalledWith(path, {
        byteOffset: first.nextByteOffset,
        byteLength: undefined,
      });
    }
  );

  it('preserves complete small reads, offsets and Unicode across stream chunks', async () => {
    const path = '/workspace/source.ts';
    const lines = ['a'.repeat(511) + 'é漢\u{1D11E}', 'second', 'third'];
    const original = grepWorkspace(new Map([[path, lines.join('\n')]]));

    expect(await runRead(original, { path })).toEqual({
      path,
      content: lines.map((line, index) => `${index + 1}\t${line}`).join('\n'),
      startLine: 1,
      endLine: 3,
      totalLines: 3,
      truncated: false,
    });
    expect(await runRead(original, { path, offset: 2, limit: 1 })).toMatchObject({
      content: '2\tsecond',
      startLine: 2,
      endLine: 2,
      truncated: true,
      nextOffset: 3,
    });
  });

  it('clips a large Unicode line without retaining its complete contents', async () => {
    const path = '/workspace/long.ts';
    const result = await runRead(
      grepWorkspace(new Map([[path, `${'é漢\u{1D11E}'.repeat(50_000)}\nend`]])),
      { path }
    );
    const line = result.content.split('\n')[0];
    expect(line).toContain('... (truncated)');
    expect(line).not.toContain('\uFFFD');
    expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(
      MAX_REVIEW_READ_LINE_BYTES + 32
    );
    expect(result.content.endsWith('\n2\tend')).toBe(true);
  });

  it('preserves PDF attachment handling through bounded byte reads', async () => {
    const path = '/workspace/document.pdf';
    const body = '%PDF-1.7\nfixture';
    const original = grepWorkspace(new Map([[path, body]]));
    const read = createReviewReadTool(createSafeReviewWorkspace(original.asReviewWorkspace()));
    if (!read.execute || !read.toModelOutput) throw new Error('Review read tool is incomplete');
    const input = { path };
    const output = await read.execute(input, {
      toolCallId: 'pdf-read',
      messages: [],
      context: {},
    });
    expect(output).toMatchObject({ kind: 'file', mediaType: 'application/pdf', data: btoa(body) });
    expect(await read.toModelOutput({ input, output, toolCallId: 'pdf-read' })).toMatchObject({
      type: 'content',
      value: expect.arrayContaining([
        expect.objectContaining({ type: 'file', mediaType: 'application/pdf' }),
      ]),
    });
    expect(original.readFileBytes).not.toHaveBeenCalled();
  });

  it('rejects oversized inline media before reading its bytes', async () => {
    const path = '/workspace/document.pdf';
    const original = grepWorkspace(new Map([[path, '%PDF-1.7\nfixture']]));
    original.sizes.set(path, 8 * 1024 * 1024);
    const read = createReviewReadTool(createSafeReviewWorkspace(original.asReviewWorkspace()));
    if (!read.execute || !read.toModelOutput) throw new Error('Review read tool is incomplete');
    const input = { path };
    const output = await read.execute(input, {
      toolCallId: 'oversized-pdf-read',
      messages: [],
      context: {},
    });
    expect(output).toMatchObject({
      kind: 'file',
      mediaType: 'application/pdf',
      sizeBytes: 8 * 1024 * 1024,
    });
    expect(
      await read.toModelOutput({ input, output, toolCallId: 'oversized-pdf-read' })
    ).toMatchObject({
      type: 'error-text',
      value: expect.stringContaining('inline model output limit'),
    });
    expect(original.fs.readFile).not.toHaveBeenCalled();
    expect(original.readFileBytes).not.toHaveBeenCalled();
  });

  it.each(['/workspace/.git/config', '/workspace/metadata/config'])(
    'does not open a stream for hidden path %s, including byte continuations',
    async path => {
      const original = grepWorkspace(new Map([[path, 'secret Git metadata']]));
      original.symlinks.set('/workspace/metadata', '.git');
      const read = createReviewReadTool(createSafeReviewWorkspace(original.asReviewWorkspace()));
      if (!read.execute) throw new Error('Review read tool has no execute function');
      expect(
        await read.execute(
          { path, offset: 1, byteOffset: 1 },
          { toolCallId: 'hidden-read', messages: [], context: {} }
        )
      ).toEqual({ error: `File not found: ${path}` });
      expect(original.fs.readFile).not.toHaveBeenCalled();
    }
  );

  it('streams a real chunked Computer Workspace file within the Durable Object', async () => {
    const namespace = (env as Env).REVIEW_ISOLATE;
    const id = namespace.idFromName(`workspace-bounded-read-${crypto.randomUUID()}`);
    const result = await runInDurableObject(namespace.get(id), async instance => {
      const workspace = instance.workspace;
      await workspace.mkdir('/workspace', { recursive: true });
      await workspace.writeFile('/workspace/data.csv', 'a,b\n'.repeat(1_500_000));
      const read = createReviewReadTool(workspace);
      if (!read.execute) throw new Error('Review read tool has no execute function');
      return read.execute(
        { path: '/workspace/data.csv' },
        { toolCallId: 'real-bounded-read', messages: [], context: {} }
      );
    });
    const output = textReadResultSchema.parse(result);
    expect(output).toMatchObject({ startLine: 1, truncated: true, totalLines: null });
    expect(output.endLine).toBeLessThanOrEqual(MAX_REVIEW_READ_LINES);
    expect(new TextEncoder().encode(output.content).byteLength).toBeLessThanOrEqual(
      MAX_REVIEW_READ_OUTPUT_BYTES
    );
  });
});

describe('bounded review grep', () => {
  it.each([
    {
      input: { query: '^needle(?:\\.\\[value\\]|Xv)$', include: '**/*.ts' },
      lines: ['1: Needle.[value]', '2: needleXv', '3: needle.[value]'],
    },
    {
      input: { query: 'needle.[value]', fixedString: true },
      lines: ['1: Needle.[value]', '3: needle.[value]'],
    },
    {
      input: { query: '^NEEDLE$', caseSensitive: true },
      lines: ['4: NEEDLE'],
    },
    {
      input: { query: '^NEEDLE$' },
      lines: ['4: NEEDLE', '5: needle'],
    },
  ])('preserves normal search behavior for $input', async ({ input, lines }) => {
    const path = '/workspace/source.ts';
    const original = grepWorkspace(
      new Map([[path, 'Needle.[value]\nneedleXv\nneedle.[value]\nNEEDLE\nneedle\nnomatch']])
    );

    expect(await runGrep(original, input)).toEqual({
      query: input.query,
      filesSearched: 1,
      filesWithMatches: 1,
      totalMatches: lines.length,
      matches: lines.map(line => `${path}:${line}`),
    });
    expect(original.glob).toHaveBeenCalledExactlyOnceWith(input.include ?? '**/*');
  });

  it('preserves overlapping context and marks only the anchored matching line', async () => {
    const path = '/workspace/source.ts';
    const original = grepWorkspace(
      new Map([[path, 'start\nNeedle first\nmiddle\nneedle second\nend']])
    );

    expect(await runGrep(original, { query: 'needle', contextLines: 2 })).toEqual({
      query: 'needle',
      filesSearched: 1,
      filesWithMatches: 1,
      totalMatches: 2,
      matches: [
        {
          file: path,
          line: 2,
          context: '  1\tstart\n> 2\tNeedle first\n  3\tmiddle\n  4\tneedle second',
        },
        {
          file: path,
          line: 4,
          context: '  2\tNeedle first\n  3\tmiddle\n> 4\tneedle second\n  5\tend',
        },
      ],
    });
  });

  it('bounds oversized overlapping context before reading the rest of a ten-file corpus', async () => {
    const content = Array.from({ length: 20 }, () => `needle ${'x'.repeat(46_202)}`).join('\n');
    expect(new TextEncoder().encode(content).byteLength).toBe(924_199);
    const original = grepWorkspace(
      new Map(Array.from({ length: 10 }, (_, index) => [`/workspace/large-${index}.ts`, content]))
    );

    const result = await runGrep(original, { query: 'needle', contextLines: 10 });

    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(
      MAX_REVIEW_GREP_OUTPUT_BYTES
    );
    expect(result).toMatchObject({
      filesSearched: 1,
      filesWithMatches: 1,
      truncated: true,
      truncation: { outputLimitReached: true, matchLimitReached: false },
    });
    expect(result.totalMatches).toBeGreaterThan(0);
    expect(result.totalMatches).toBeLessThan(200);
    expect(result.truncation?.truncatedLines).toBeGreaterThan(0);
    expect(result.readFollowup).toContain('read with path, offset and limit');
    expect(original.readFile).toHaveBeenCalledExactlyOnceWith('/workspace/large-0.ts');
    for (const match of result.matches) {
      if (typeof match === 'string') throw new Error('Expected grep context');
      expect(match.file).toBe('/workspace/large-0.ts');
      expect(match.context).toContain(`> ${match.line}\t`);
      const lines = match.context.split('\n');
      expect(lines.length).toBeLessThanOrEqual(21);
      for (const line of lines) {
        const text = line.slice(line.indexOf('\t') + 1);
        expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
          MAX_REVIEW_GREP_LINE_BYTES
        );
        expect(text).toContain('... (truncated)');
      }
    }
  });

  it('clips Unicode lines on complete code points while retaining the BOM and matching anchor', async () => {
    const path = '/workspace/unicode.ts';
    const content = `\uFEFF${'é漢\u{1D11E}'.repeat(20_000)}needle`;
    const result = await runGrep(grepWorkspace(new Map([[path, content]])), { query: 'needle' });
    const match = result.matches[0];
    if (typeof match !== 'string') throw new Error('Expected a matching line');
    const prefix = `${path}:1: `;
    expect(match.startsWith(prefix)).toBe(true);
    const text = match.slice(prefix.length);
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
      MAX_REVIEW_GREP_LINE_BYTES
    );
    expect(text.startsWith('\uFEFF')).toBe(true);
    expect(text).not.toContain('\uFFFD');
    expect(text.endsWith('... (truncated)')).toBe(true);
    expect(content.startsWith(text.slice(0, -'... (truncated)'.length))).toBe(true);
    expect(result).toMatchObject({
      totalMatches: 1,
      truncated: true,
      truncation: { truncatedLines: 1, outputLimitReached: false },
    });
  });

  it('budgets aggregate UTF-8 JSON bytes including Unicode paths, escapes and metadata', async () => {
    const content = `needle ${'é漢\u{1D11E}"\\\t\0'.repeat(70)}`;
    const original = grepWorkspace(
      new Map(
        Array.from({ length: 100 }, (_, index) => [`/workspace/café-漢-${index}.ts`, content])
      )
    );
    const result = await runGrep(original, { query: 'needle' });

    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(
      MAX_REVIEW_GREP_OUTPUT_BYTES
    );
    expect(result).toMatchObject({
      truncated: true,
      truncation: { truncatedLines: 0, outputLimitReached: true, matchLimitReached: false },
    });
    expect(result.totalMatches).toBeGreaterThan(1);
    expect(result.totalMatches).toBeLessThan(100);
    expect(original.readFile.mock.calls.length).toBeLessThan(100);
    expect(result.matches).toEqual(
      Array.from(
        { length: result.totalMatches },
        (_, index) => `/workspace/café-漢-${index}.ts:1: ${content}`
      )
    );
  });

  it('retains the matched line when escaped context exhausts the byte budget', async () => {
    const path = '/workspace/escaped.ts';
    const lines = Array.from({ length: 21 }, () => '\0'.repeat(MAX_REVIEW_GREP_LINE_BYTES));
    lines[10] = 'needle';
    const result = await runGrep(grepWorkspace(new Map([[path, lines.join('\n')]])), {
      query: 'needle',
      contextLines: 10,
    });

    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(
      MAX_REVIEW_GREP_OUTPUT_BYTES
    );
    expect(result).toMatchObject({
      totalMatches: 1,
      truncated: true,
      truncation: { truncatedLines: 0, outputLimitReached: true },
    });
    const match = result.matches[0];
    if (typeof match === 'string' || !match) throw new Error('Expected grep context');
    expect(match).toMatchObject({ file: path, line: 11 });
    expect(match.context).toContain('> 11\tneedle');
    expect(match.context.split('\n').length).toBeLessThan(21);
  });

  it('retains the 200 matching-line cap and stops before reading another file', async () => {
    const path = '/workspace/matches.ts';
    const original = grepWorkspace(
      new Map([
        [path, Array.from({ length: 201 }, () => 'needle needle').join('\n')],
        ['/workspace/unread.ts', 'needle'],
      ])
    );
    const result = await runGrep(original, { query: 'needle' });

    expect(result).toMatchObject({
      filesSearched: 1,
      filesWithMatches: 1,
      totalMatches: 200,
      truncated: true,
      truncation: { truncatedLines: 0, outputLimitReached: false, matchLimitReached: true },
    });
    expect(result.matches).toHaveLength(200);
    expect(result.matches.at(-1)).toBe(`${path}:200: needle needle`);
    expect(original.readFile).toHaveBeenCalledExactlyOnceWith(path);
  });

  it.each(['.*needle', '(x+)+y', '(x|xx)+y'])(
    'searches a maximum-size nonmatching line with %s without backtracking',
    async query => {
      const path = '/workspace/minified.js';
      const original = grepWorkspace(new Map([[path, 'x'.repeat(1024 * 1024)]]));
      expect(await runGrep(original, { query })).toEqual({
        query,
        filesSearched: 1,
        filesWithMatches: 0,
        totalMatches: 0,
        matches: [],
      });
    }
  );

  it.each(['(?<=n)eedle', '(needle)\\1'])(
    'rejects unsupported RE2 syntax %s without falling back to backtracking',
    async query => {
      const original = grepWorkspace(new Map([['/workspace/source.ts', 'needleneedle']]));
      const execute = createReviewGrepTool(original.asReviewWorkspace()).execute;
      if (!execute) throw new Error('Review grep tool has no execute function');
      expect(
        await execute({ query }, { toolCallId: 'unsupported-regex', messages: [], context: {} })
      ).toEqual({ error: `Invalid regex: ${query}` });
      expect(original.readFile).not.toHaveBeenCalled();
    }
  );

  it('returns invalid-regex errors and keeps reflected oversized queries bounded', async () => {
    const original = grepWorkspace(new Map([['/workspace/source.ts', 'needle']]));
    const execute = createReviewGrepTool(original.asReviewWorkspace()).execute;
    if (!execute) throw new Error('Review grep tool has no execute function');
    const options = { toolCallId: 'invalid-grep', messages: [], context: {} };

    await expect(execute({ query: '[' }, options)).resolves.toEqual({ error: 'Invalid regex: [' });
    const result = await execute({ query: `[${'漢'.repeat(100_000)}` }, options);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(
      MAX_REVIEW_GREP_OUTPUT_BYTES
    );
    expect(result).toMatchObject({ error: expect.stringContaining('... (truncated)') });
    expect(original.readFile).not.toHaveBeenCalled();
  });
});

describe('safe review workspace', () => {
  it.each(['**/*', '.git/**/*', '/workspace/.git/objects/**', 'nested/.git/**/*'])(
    'excludes every Git metadata path for the %s pattern',
    async pattern => {
      const regular = fileInfo('/workspace/src/.gitignore');
      const github = fileInfo('/workspace/.github/workflows/review.yml');
      const original = new FakeWorkspace(
        [
          fileInfo('/workspace/.git', { type: 'directory' }),
          fileInfo('/workspace/.git/objects/pack/repository.pack'),
          fileInfo('/workspace/nested/.git/config'),
          regular,
          github,
        ],
        new Map([
          [regular.path, 12],
          [github.path, 34],
        ])
      );
      const workspace = createSafeReviewWorkspace(original.asReviewWorkspace());

      await expect(workspace.glob(pattern)).resolves.toEqual([
        { ...regular, size: 12 },
        { ...github, size: 34 },
      ]);
      expect(original.glob).toHaveBeenCalledWith(pattern);
      expect(original.stat).toHaveBeenCalledTimes(2);
    }
  );

  it.each([
    '/workspace/.git',
    '/workspace/.git/HEAD',
    '/workspace/nested/.git/config',
    '.git/config',
  ])('hides %s from file reads and stat without restricting the raw workspace', async path => {
    const git = fileInfo(path);
    const original = new FakeWorkspace(
      [git],
      new Map([[path, 19]]),
      new Map([[path, 'private Git metadata']])
    );
    const underlying = original.asReviewWorkspace();
    const workspace = createSafeReviewWorkspace(underlying);

    await expect(workspace.readFile(path)).resolves.toBeNull();
    await expect(workspace.readFileBytes(path)).resolves.toBeNull();
    await expect(workspace.stat(path)).resolves.toBeNull();
    expect(original.readFile).not.toHaveBeenCalled();
    expect(original.readFileBytes).not.toHaveBeenCalled();
    expect(original.stat).not.toHaveBeenCalled();

    await expect(underlying.readFile(path)).resolves.toBe('private Git metadata');
    await expect(underlying.readFileBytes(path)).resolves.toEqual(
      new TextEncoder().encode('private Git metadata')
    );
    await expect(underlying.stat(path)).resolves.toEqual({ ...git, size: 19 });
  });

  it.each([
    '/workspace/metadata',
    '/workspace/metadata/config',
    '/workspace/nested/metadata/config',
  ])('rejects every operation through the symlinked path %s', async path => {
    const entry = fileInfo(path);
    const original = new FakeWorkspace(
      [entry],
      new Map([[path, 21]]),
      new Map([[path, 'private Git metadata']])
    );
    const link = path.startsWith('/workspace/nested/')
      ? '/workspace/nested/metadata'
      : '/workspace/metadata';
    original.symlinks.set(link, '.git');
    const underlying = original.asReviewWorkspace();
    const workspace = createSafeReviewWorkspace(underlying);

    await expect(workspace.readFile(path)).resolves.toBeNull();
    await expect(workspace.readFileBytes(path)).resolves.toBeNull();
    await expect(workspace.stat(path)).resolves.toBeNull();
    await expect(workspace.readDir(path)).resolves.toEqual([]);
    expect(original.readFile).not.toHaveBeenCalled();
    expect(original.readFileBytes).not.toHaveBeenCalled();
    expect(original.stat).not.toHaveBeenCalled();
    expect(original.readDir).not.toHaveBeenCalled();
    expect(original.fs.lstat).toHaveBeenCalledWith(link);
    await expect(underlying.readFile(path)).resolves.toBe('private Git metadata');
  });

  it('intentionally blocks ordinary source files when they are symbolic links', async () => {
    const linked = fileInfo('/workspace/linked-source.ts');
    const original = new FakeWorkspace(
      [linked],
      new Map([[linked.path, 18]]),
      new Map([[linked.path, 'linked source file']])
    );
    original.symlinks.set(linked.path, 'src/source.ts');
    const workspace = createSafeReviewWorkspace(original.asReviewWorkspace());

    await expect(workspace.readFile(linked.path)).resolves.toBeNull();
    await expect(workspace.readFileBytes(linked.path)).resolves.toBeNull();
    await expect(workspace.stat(linked.path)).resolves.toBeNull();
    await expect(workspace.glob('**/*')).resolves.toEqual([]);
  });

  it('preserves missing paths when component lstat returns ENOENT', async () => {
    const original = new FakeWorkspace([]);
    const workspace = createSafeReviewWorkspace(original.asReviewWorkspace());
    const missing = '/workspace/missing/file.ts';

    await expect(workspace.readFile(missing)).resolves.toBeNull();
    await expect(workspace.readFileBytes(missing)).resolves.toBeNull();
    await expect(workspace.stat(missing)).resolves.toBeNull();
    expect(original.readFile).toHaveBeenCalledExactlyOnceWith(missing);
    expect(original.readFileBytes).toHaveBeenCalledExactlyOnceWith(missing);
    expect(original.stat).toHaveBeenCalledExactlyOnceWith(missing);
  });

  it('propagates unexpected lstat failures without reading the requested file', async () => {
    const file = fileInfo('/workspace/source.ts');
    const original = new FakeWorkspace([file], new Map(), new Map([[file.path, 'visible source']]));
    original.fs.lstat.mockRejectedValueOnce(new Error('filesystem unavailable'));
    const workspace = createSafeReviewWorkspace(original.asReviewWorkspace());

    await expect(workspace.readFile(file.path)).rejects.toThrow('filesystem unavailable');
    expect(original.readFile).not.toHaveBeenCalled();
  });

  it.each([
    '/workspace/.github/workflows/review.yml',
    '/workspace/.gitignore',
    '/workspace/nested/.gitignore',
  ])('preserves ordinary reads and stats for %s', async path => {
    const file = fileInfo(path);
    const original = new FakeWorkspace(
      [file],
      new Map([[path, 23]]),
      new Map([[path, 'ordinary repository file']])
    );
    const workspace = createSafeReviewWorkspace(original.asReviewWorkspace());

    await expect(workspace.readFile(path)).resolves.toBe('ordinary repository file');
    await expect(workspace.readFileBytes(path)).resolves.toEqual(
      new TextEncoder().encode('ordinary repository file')
    );
    await expect(workspace.stat(path)).resolves.toEqual({ ...file, size: 23 });
  });

  it('filters root and nested Git directories while preserving similarly named entries', async () => {
    const rootGit = fileInfo('/workspace/.git', { type: 'directory' });
    const github = fileInfo('/workspace/.github', { type: 'directory' });
    const gitignore = fileInfo('/workspace/.gitignore');
    const nested = fileInfo('/workspace/nested', { type: 'directory' });
    const nestedGit = fileInfo('/workspace/nested/.git', { type: 'directory' });
    const nestedFile = fileInfo('/workspace/nested/review.ts');
    const original = new FakeWorkspace([rootGit, github, gitignore, nested, nestedGit, nestedFile]);
    const underlying = original.asReviewWorkspace();
    const workspace = createSafeReviewWorkspace(underlying);

    await expect(workspace.readDir('/workspace', { limit: 10, offset: 0 })).resolves.toEqual([
      github,
      gitignore,
      nested,
    ]);
    await expect(workspace.readDir('/workspace/nested')).resolves.toEqual([nestedFile]);
    expect(original.readDir).toHaveBeenCalledWith('/workspace', { limit: 10, offset: 0 });
    await expect(underlying.readDir('/workspace')).resolves.toEqual([
      rootGit,
      github,
      gitignore,
      nested,
    ]);
    await expect(underlying.readDir('/workspace/nested')).resolves.toEqual([nestedGit, nestedFile]);
  });

  it('filters symbolic-link aliases from parent listings and blocks alias directories', async () => {
    const metadata = fileInfo('/workspace/metadata', { type: 'directory' });
    const linkedConfig = fileInfo('/workspace/metadata/config');
    const github = fileInfo('/workspace/.github', { type: 'directory' });
    const gitignore = fileInfo('/workspace/.gitignore');
    const original = new FakeWorkspace([metadata, linkedConfig, github, gitignore]);
    original.symlinks.set(metadata.path, '.git');
    const underlying = original.asReviewWorkspace();
    const workspace = createSafeReviewWorkspace(underlying);

    await expect(workspace.readDir('/workspace')).resolves.toEqual([github, gitignore]);
    await expect(workspace.readDir(metadata.path)).resolves.toEqual([]);
    expect(original.readDir).toHaveBeenCalledExactlyOnceWith('/workspace', undefined);
    await expect(underlying.readDir('/workspace')).resolves.toEqual([metadata, github, gitignore]);
  });

  it.each(['/workspace/.git', '/workspace/.git/objects', '/workspace/nested/.git'])(
    'returns an empty directory listing for %s without touching the raw workspace',
    async path => {
      const original = new FakeWorkspace([fileInfo(`${path}/config`)]);
      const workspace = createSafeReviewWorkspace(original.asReviewWorkspace());

      await expect(workspace.readDir(path)).resolves.toEqual([]);
      expect(original.readDir).not.toHaveBeenCalled();
    }
  );

  it('populates accurate sizes without changing metadata or the original unfiltered glob', async () => {
    const git = fileInfo('/workspace/.git/HEAD');
    const source = fileInfo('/workspace/src/review.ts', {
      mimeType: 'text/typescript',
      createdAt: 123,
      updatedAt: 456,
    });
    const directory = fileInfo('/workspace/src', {
      type: 'directory',
      mimeType: 'inode/directory',
    });
    const original = new FakeWorkspace(
      [git, source, directory],
      new Map([
        [source.path, 1_048_577],
        [directory.path, 4096],
      ])
    );
    const underlying = original.asReviewWorkspace();
    const workspace = createSafeReviewWorkspace(underlying);

    await expect(workspace.glob('**/*')).resolves.toEqual([
      { ...source, size: 1_048_577 },
      { ...directory, size: 4096 },
    ]);
    await expect(underlying.glob('**/*')).resolves.toEqual([git, source, directory]);
    expect(source.size).toBe(0);
    expect(directory.size).toBe(0);
  });

  it('filters symlinked glob entries and checks shared path components only once', async () => {
    const first = fileInfo('/workspace/src/first.ts');
    const second = fileInfo('/workspace/src/second.ts');
    const metadata = fileInfo('/workspace/metadata', { type: 'directory' });
    const linkedConfig = fileInfo('/workspace/metadata/config');
    const original = new FakeWorkspace(
      [first, second, metadata, linkedConfig],
      new Map([
        [first.path, 11],
        [second.path, 22],
      ])
    );
    original.symlinks.set(metadata.path, '.git');
    const workspace = createSafeReviewWorkspace(original.asReviewWorkspace());

    await expect(workspace.glob('**/*')).resolves.toEqual([
      { ...first, size: 11 },
      { ...second, size: 22 },
    ]);
    expect(original.fs.lstat.mock.calls.filter(([path]) => path === '/workspace')).toHaveLength(1);
    expect(original.fs.lstat.mock.calls.filter(([path]) => path === '/workspace/src')).toHaveLength(
      1
    );
    expect(
      original.fs.lstat.mock.calls.filter(([path]) => path === '/workspace/metadata')
    ).toHaveLength(1);
    expect(original.stat).not.toHaveBeenCalledWith(linkedConfig.path);
  });

  it('omits entries whose current size cannot be determined', async () => {
    const missing = fileInfo('/workspace/src/removed.ts');
    const remaining = fileInfo('/workspace/src/current.ts');
    const original = new FakeWorkspace([missing, remaining], new Map([[remaining.path, 88]]));
    original.missing.add(missing.path);
    const workspace = createSafeReviewWorkspace(original.asReviewWorkspace());

    await expect(workspace.glob('**/*')).resolves.toEqual([{ ...remaining, size: 88 }]);
  });

  it('preserves original fields, private-field getters, and method bindings', () => {
    const original = new FakeWorkspace([]);
    const workspace = createSafeReviewWorkspace(original.asReviewWorkspace());

    expect(workspace.git).toBe(original.git);
    expect(workspace.sessionId).toBe('original-workspace');
    expect(workspace.provider()).toBe('original-workspace');
  });

  it('makes Think read treat Git metadata as missing while allowing .gitignore', async () => {
    const git = fileInfo('/workspace/.git/HEAD', { mimeType: 'text/plain' });
    const gitignore = fileInfo('/workspace/.gitignore', { mimeType: 'text/plain' });
    const original = new FakeWorkspace(
      [git, gitignore],
      new Map([
        [git.path, 21],
        [gitignore.path, 15],
      ]),
      new Map([
        [git.path, 'private Git metadata'],
        [gitignore.path, 'ignored-pattern'],
      ])
    );
    const workspace = createSafeReviewWorkspace(original.asReviewWorkspace());
    const execute = createWorkspaceTools(workspace, { bash: false }).read.execute;
    if (!execute) throw new Error('Think read tool has no execute function');

    await expect(
      execute({ path: git.path }, { toolCallId: 'read-git', messages: [], context: {} })
    ).resolves.toEqual({ error: `File not found: ${git.path}` });
    await expect(
      execute({ path: gitignore.path }, { toolCallId: 'read-ignore', messages: [], context: {} })
    ).resolves.toEqual({
      path: gitignore.path,
      content: '1\tignored-pattern',
      totalLines: 1,
    });
    expect(original.stat).toHaveBeenCalledExactlyOnceWith(gitignore.path);
    expect(original.readFile).toHaveBeenCalledExactlyOnceWith(gitignore.path);
  });

  it('makes Think list hide root and nested Git directories', async () => {
    const rootGit = fileInfo('/workspace/.git', { type: 'directory' });
    const github = fileInfo('/workspace/.github', { type: 'directory' });
    const gitignore = fileInfo('/workspace/.gitignore', { size: 17 });
    const nested = fileInfo('/workspace/nested', { type: 'directory' });
    const nestedGit = fileInfo('/workspace/nested/.git', { type: 'directory' });
    const nestedFile = fileInfo('/workspace/nested/review.ts', { size: 8 });
    const original = new FakeWorkspace([rootGit, github, gitignore, nested, nestedGit, nestedFile]);
    const workspace = createSafeReviewWorkspace(original.asReviewWorkspace());
    const execute = createWorkspaceTools(workspace, { bash: false }).list.execute;
    if (!execute) throw new Error('Think list tool has no execute function');

    await expect(
      execute({ path: '/workspace' }, { toolCallId: 'list-root', messages: [], context: {} })
    ).resolves.toEqual({
      path: '/workspace',
      count: 3,
      entries: ['.github/', '.gitignore (17 B)', 'nested/'],
    });
    await expect(
      execute(
        { path: '/workspace/nested' },
        { toolCallId: 'list-nested', messages: [], context: {} }
      )
    ).resolves.toEqual({
      path: '/workspace/nested',
      count: 1,
      entries: ['review.ts (8 B)'],
    });
    await expect(
      execute({ path: '/workspace/.git' }, { toolCallId: 'list-git', messages: [], context: {} })
    ).resolves.toEqual({ path: '/workspace/.git', count: 0, entries: [] });
    expect(original.readDir).toHaveBeenCalledTimes(2);
  });

  it('lets review grep skip oversized files without reading Git metadata', async () => {
    const oversized = fileInfo('/workspace/src/generated.ts');
    const searchable = fileInfo('/workspace/src/review.ts');
    const git = fileInfo('/workspace/.git/objects/pack/repository.pack');
    const original = new FakeWorkspace(
      [oversized, searchable, git],
      new Map([
        [oversized.path, 1_048_577],
        [searchable.path, 64],
        [git.path, 2_097_152],
      ]),
      new Map([
        [oversized.path, 'needle in oversized file'],
        [searchable.path, 'needle in searchable file'],
        [git.path, 'needle in Git metadata'],
      ])
    );
    const workspace = createSafeReviewWorkspace(original.asReviewWorkspace());
    const execute = createReviewGrepTool(workspace).execute;
    if (!execute) throw new Error('Review grep tool has no execute function');

    const result = await execute(
      { query: 'needle', include: '**/*' },
      { toolCallId: 'review-grep', messages: [], context: {} }
    );

    expect(result).toMatchObject({
      filesSearched: 1,
      filesWithMatches: 1,
      totalMatches: 1,
      filesSkipped: 1,
      matches: ['/workspace/src/review.ts:1: needle in searchable file'],
    });
    expect(original.readFile).toHaveBeenCalledExactlyOnceWith(searchable.path);
    expect(original.stat).not.toHaveBeenCalledWith(git.path);
  });

  it('rejects a real Computer Workspace symlink to Git metadata in the review Durable Object', async () => {
    const namespace = (env as Env).REVIEW_ISOLATE;
    const id = namespace.idFromName(`workspace-symlink-${crypto.randomUUID()}`);
    const result = await runInDurableObject(namespace.get(id), async instance => {
      const workspace = instance.workspace;
      await workspace.mkdir('/workspace/.git', { recursive: true });
      await workspace.mkdir('/workspace/.github', { recursive: true });
      await workspace.writeFile('/workspace/.git/config', 'private Git metadata');
      await workspace.writeFile('/workspace/.github/workflow.yml', 'visible workflow');
      await workspace.writeFile('/workspace/.gitignore', 'ignored');
      await workspace.writeFile('/workspace/source.ts', 'visible source');
      await workspace.fs.symlink('.git', '/workspace/metadata');
      await workspace.fs.symlink('source.ts', '/workspace/linked-source.ts');

      const tools = createWorkspaceTools(workspace, { bash: false });
      const read = tools.read.execute;
      const list = tools.list.execute;
      if (!read || !list) throw new Error('Think workspace tools have no execute function');

      return {
        linkTarget: await workspace.fs.readlink('/workspace/metadata'),
        rawMetadata: await workspace.fs.readFile('/workspace/metadata/config', 'utf8'),
        read: await workspace.readFile('/workspace/metadata/config'),
        bytes: await workspace.readFileBytes('/workspace/metadata/config'),
        stat: await workspace.stat('/workspace/metadata/config'),
        directory: await workspace.readDir('/workspace/metadata'),
        source: await workspace.readFile('/workspace/source.ts'),
        github: await workspace.readFile('/workspace/.github/workflow.yml'),
        gitignore: await workspace.readFile('/workspace/.gitignore'),
        linkedSource: await workspace.readFile('/workspace/linked-source.ts'),
        missing: await workspace.readFile('/workspace/missing.ts'),
        root: (await workspace.readDir('/workspace')).map(entry => entry.path),
        recursive: (await workspace.glob('**/*')).map(entry => entry.path),
        directed: (await workspace.glob('metadata/**/*')).map(entry => entry.path),
        thinkRead: await read(
          { path: '/workspace/metadata/config' },
          { toolCallId: 'real-read', messages: [], context: {} }
        ),
        thinkList: await list(
          { path: '/workspace' },
          { toolCallId: 'real-list', messages: [], context: {} }
        ),
      };
    });

    expect(result).toMatchObject({
      linkTarget: '.git',
      rawMetadata: 'private Git metadata',
      read: null,
      bytes: null,
      stat: null,
      directory: [],
      source: 'visible source',
      github: 'visible workflow',
      gitignore: 'ignored',
      linkedSource: null,
      missing: null,
      directed: [],
      thinkRead: { error: 'File not found: /workspace/metadata/config' },
      thinkList: {
        path: '/workspace',
        count: 3,
        entries: ['.github/', '.gitignore (0 B)', 'source.ts (0 B)'],
      },
    });
    expect(result.root).toEqual([
      '/workspace/.github',
      '/workspace/.gitignore',
      '/workspace/source.ts',
    ]);
    expect(result.recursive).toEqual(
      expect.arrayContaining([
        '/workspace/.github/workflow.yml',
        '/workspace/.gitignore',
        '/workspace/source.ts',
      ])
    );
    expect(result.recursive).not.toContain('/workspace/metadata');
    expect(result.recursive).not.toContain('/workspace/linked-source.ts');
    expect(result.recursive).not.toContain('/workspace/.git/config');
  });
});
