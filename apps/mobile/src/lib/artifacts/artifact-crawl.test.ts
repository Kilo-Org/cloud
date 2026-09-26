/* eslint-disable max-lines -- one suite for the crawl's reads, the size cap, and the mirror-entry assembly */
/* eslint-disable require-await, @typescript-eslint/require-await -- the injected probe and download seams resolve immediately, so they settle without await */
import { File } from 'expo-file-system';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ArtifactCrawlDeps,
  buildSessionArtifacts,
  extractSessionArtifacts,
  fetchSessionMessagesPage,
  listSessionPage,
  materializeArtifact,
  MAX_ARTIFACT_BYTES,
  MIRROR_SESSION_LIMIT,
  type MirrorSessionRow,
} from '@/lib/artifacts/artifact-crawl';

// Real-File-shaped stand-in for expo-file-system. `materializeArtifact` writes
// through the public File surface (`write`, `size`, `delete`), so the fake
// implements exactly that and records what happened for assertions.
const fakeFs = vi.hoisted(() => {
  type Tracked = {
    deleted: boolean;
    size: number;
    writes: { content: string; encoding?: string }[];
  };
  const files: Tracked[] = [];

  class FileMock {
    deleted = false;
    size = 0;
    writes: Tracked['writes'] = [];

    constructor() {
      files.push(this);
    }

    write(content: string, options?: { encoding?: string }): void {
      this.writes.push({ content, ...(options?.encoding ? { encoding: options.encoding } : {}) });
      this.size = content.length;
    }

    delete(): void {
      this.deleted = true;
    }
  }

  return {
    File: FileMock,
    files,
    reset: () => {
      files.length = 0;
    },
  };
});

vi.mock('expo-file-system', () => ({ Directory: vi.fn(), File: fakeFs.File, Paths: {} }));
vi.mock('expo-sharing', () => ({ isAvailableAsync: vi.fn(), shareAsync: vi.fn() }));
const probeFetch = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock('expo/fetch', () => ({ fetch: probeFetch }));

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cloudAgentNext: { getAttachmentDownloadUrl: { mutate: vi.fn() } },
    cliSessionsV2: { getSessionMessagesPage: { query: vi.fn() }, list: { query: vi.fn() } },
  },
}));

const UUID = '11111111-2222-4333-8444-555555555555';
const SANDBOX_URL = `file:///tmp/attachments/session-1/user-1/${UUID}/shot.png`;
const DATA_URL = 'data:image/png;base64,QUJD';
const UPDATED_AT = '2026-01-01T00:00:00.000Z';

type TrackedFile = (typeof fakeFs.files)[number];

/** A target File plus the mock's record of it, which stays the same object. */
function target(): { file: File; tracked: TrackedFile } {
  const file = new File();
  const tracked = fakeFs.files.at(-1);
  if (!tracked) {
    throw new Error('File did not register with the mock filesystem');
  }
  return { file, tracked };
}

/** A completed download: a fresh File carrying `size` bytes. */
function downloaded(size: number): File {
  const file = new File();
  const tracked = fakeFs.files.at(-1);
  if (tracked) {
    tracked.size = size;
  }
  return file;
}

function presignResolving(signedUrl: string) {
  return vi.fn<ArtifactCrawlDeps['presignAttachmentDownload']>().mockResolvedValue({ signedUrl });
}

function downloadResolving(size: number) {
  return vi.fn<ArtifactCrawlDeps['downloadFile']>().mockResolvedValue(downloaded(size));
}

const message = (parts: unknown[]) => ({ info: { id: 'message-1', role: 'assistant' }, parts });

const filePart = (id: string, url: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'file',
  mime: 'text/plain',
  url,
  ...extra,
});

const toolPart = (id: string, attachments: unknown[], tool = 'read') => ({
  id,
  type: 'tool',
  tool,
  state: { status: 'completed', attachments },
});

const rowOf = (id: string, title: string | null): MirrorSessionRow => ({
  id,
  title,
  updatedAt: UPDATED_AT,
});

beforeEach(() => {
  vi.clearAllMocks();
  probeFetch.mockReset();
  vi.stubGlobal('fetch', probeFetch);
  fakeFs.reset();
});

afterEach(() => vi.unstubAllGlobals());

describe('extractSessionArtifacts', () => {
  it('takes file parts and tool attachments, and skips what the live sink skips', () => {
    const messages = [
      {
        info: { id: 'message-1' },
        parts: [
          filePart('file-1', 'https://x/q1.pdf', { mime: 'application/pdf', filename: 'q1.pdf' }),
          filePart('file-2', ''),
          { id: 'text-1', type: 'text', text: 'hello' },
          toolPart('tool-1', [
            { mime: 'image/png', url: DATA_URL },
            { mime: 'application/pdf', url: 'https://x/skipped.pdf' },
            { mime: 'image/png', url: '' },
          ]),
          toolPart(
            'tool-2',
            [
              { mime: 'application/pdf', filename: 'report.pdf', url: 'https://x/report.pdf' },
              { mime: 'text/csv', url: 'https://x/rows.csv' },
            ],
            'send_file'
          ),
          {
            id: 'tool-3',
            type: 'tool',
            tool: 'read',
            state: { status: 'running', attachments: [{ mime: 'image/png', url: DATA_URL }] },
          },
        ],
      },
      { info: { id: 'message-2' } },
    ];

    expect(extractSessionArtifacts(messages)).toEqual([
      { id: 'file-1', mime: 'application/pdf', filename: 'q1.pdf', url: 'https://x/q1.pdf' },
      { id: 'tool-1', mime: 'image/png', url: DATA_URL },
      {
        id: 'tool-2',
        mime: 'application/pdf',
        filename: 'report.pdf',
        url: 'https://x/report.pdf',
      },
      { id: 'tool-2-1', mime: 'text/csv', url: 'https://x/rows.csv' },
    ]);
  });

  it('reads no parts at all as no artifacts', () => {
    expect(extractSessionArtifacts([message([]), message([])])).toEqual([]);
  });
});

describe('materializeArtifact', () => {
  it('presigns a sandbox reference and passes an http(s) URL straight through', async () => {
    const { file } = target();
    const presignAttachmentDownload = presignResolving('https://r2.example.com/signed');
    const downloadFile = downloadResolving(42);
    const probeContentLength = vi.fn<ArtifactCrawlDeps['probeContentLength']>(async () => null);

    const sandboxed = await materializeArtifact(
      { id: 'file-1', mime: 'image/png', filename: 'shot.png', url: SANDBOX_URL },
      file,
      { downloadFile, presignAttachmentDownload, probeContentLength }
    );

    expect(presignAttachmentDownload).toHaveBeenCalledWith({
      messageUuid: UUID,
      filename: 'shot.png',
    });
    expect(downloadFile).toHaveBeenCalledWith('https://r2.example.com/signed', file);
    expect(sandboxed).toEqual({ ok: true, size: 42 });

    const direct = await materializeArtifact(
      { id: 'file-2', mime: 'text/plain', url: 'https://x/a.txt' },
      file,
      { downloadFile, presignAttachmentDownload, probeContentLength }
    );

    expect(presignAttachmentDownload).toHaveBeenCalledTimes(1);
    expect(downloadFile).toHaveBeenLastCalledWith('https://x/a.txt', file);
    expect(direct).toEqual({ ok: true, size: 42 });
  });

  it('decodes a data: URL straight into the target', async () => {
    const { file, tracked } = target();
    const presignAttachmentDownload = vi.fn<ArtifactCrawlDeps['presignAttachmentDownload']>();
    const downloadFile = vi.fn<ArtifactCrawlDeps['downloadFile']>();

    const result = await materializeArtifact(
      { id: 'file-1', mime: 'image/png', url: DATA_URL },
      file,
      { downloadFile, presignAttachmentDownload }
    );

    expect(tracked.writes).toEqual([{ content: 'QUJD', encoding: 'base64' }]);
    expect(presignAttachmentDownload).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, size: 3 });
  });

  it('reports a failed download, a failed presign, and an unfetchable URL without throwing', async () => {
    const offline = vi
      .fn<ArtifactCrawlDeps['downloadFile']>()
      .mockRejectedValue(new Error('offline'));
    const noAuth = vi
      .fn<ArtifactCrawlDeps['presignAttachmentDownload']>()
      .mockRejectedValue(new Error('no auth'));

    await expect(
      materializeArtifact(
        { id: 'file-1', mime: 'text/plain', url: 'https://x/a.txt' },
        new File(),
        {
          downloadFile: offline,
          probeContentLength: vi.fn(async () => null),
        }
      )
    ).resolves.toEqual({ ok: false, reason: 'download-failed' });

    await expect(
      materializeArtifact({ id: 'file-1', mime: 'image/png', url: SANDBOX_URL }, new File(), {
        presignAttachmentDownload: noAuth,
      })
    ).resolves.toEqual({ ok: false, reason: 'download-failed' });

    await expect(
      materializeArtifact(
        { id: 'file-1', mime: 'text/plain', url: 'file:///etc/passwd' },
        new File()
      )
    ).resolves.toEqual({ ok: false, reason: 'unsupported' });
  });

  it('drops a download larger than the byte cap when no length was declared', async () => {
    const { file, tracked } = target();
    const downloadFile = downloadResolving(MAX_ARTIFACT_BYTES + 1);
    const probeContentLength = vi.fn<ArtifactCrawlDeps['probeContentLength']>(async () => null);

    const result = await materializeArtifact(
      { id: 'file-1', mime: 'text/plain', url: 'https://x/big.bin' },
      file,
      { downloadFile, probeContentLength }
    );

    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(tracked.deleted).toBe(true);
  });

  it('rejects an oversized artifact from its declared length without downloading it', async () => {
    const { file, tracked } = target();
    const downloadFile = vi.fn<ArtifactCrawlDeps['downloadFile']>();
    const probeContentLength = vi.fn<ArtifactCrawlDeps['probeContentLength']>(
      async () => MAX_ARTIFACT_BYTES + 1
    );

    const result = await materializeArtifact(
      { id: 'file-1', mime: 'text/plain', url: 'https://x/big.bin' },
      file,
      { downloadFile, probeContentLength }
    );

    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(probeContentLength).toHaveBeenCalledWith('https://x/big.bin');
    // The whole point of the pre-check: no byte of body reached the target.
    expect(downloadFile).not.toHaveBeenCalled();
    expect(tracked.deleted).toBe(false);
    expect(tracked.size).toBe(0);
  });

  it('sizes a GET-presigned attachment from Content-Range before downloading it', async () => {
    const { file, tracked } = target();
    const signedUrl = 'https://r2.example.com/signed';
    const downloadFile = downloadResolving(MAX_ARTIFACT_BYTES + 1);
    // SigV4 binds the method: HEAD is forbidden for a GetObject signature.
    probeFetch.mockImplementation(async (_url, init) =>
      init?.method === 'GET'
        ? new Response('x', {
            status: 206,
            headers: {
              'content-length': '1',
              'content-range': `bytes 0-0/${MAX_ARTIFACT_BYTES + 1}`,
            },
          })
        : new Response(null, { status: 403 })
    );

    expect(
      await materializeArtifact({ id: 'f1', mime: 'image/png', url: SANDBOX_URL }, file, {
        downloadFile,
        presignAttachmentDownload: presignResolving(signedUrl),
      })
    ).toEqual({ ok: false, reason: 'too-large' });
    expect(downloadFile).not.toHaveBeenCalled();
    expect(tracked.writes).toEqual([]);
    expect(probeFetch).toHaveBeenCalledWith(signedUrl, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      signal: expect.any(AbortSignal),
    });
    expect(probeFetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it.each([1, MAX_ARTIFACT_BYTES])(
    'downloads a ranged artifact of %s bytes within the cap',
    async size => {
      probeFetch.mockResolvedValue(
        new Response('x', {
          status: 206,
          headers: { 'content-length': '1', 'content-range': `bytes 0-0/${size}` },
        })
      );
      const { file } = target();
      const downloadFile = downloadResolving(size);

      expect(
        await materializeArtifact({ id: 'f1', mime: 'text/plain', url: 'https://x/f1' }, file, {
          downloadFile,
        })
      ).toEqual({ ok: true, size });
      expect(downloadFile).toHaveBeenCalledOnce();
      expect(probeFetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    }
  );

  it('rejects a full oversized response and aborts when the server ignores Range', async () => {
    probeFetch.mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { 'content-length': String(MAX_ARTIFACT_BYTES + 1) },
      })
    );
    const downloadFile = vi.fn<ArtifactCrawlDeps['downloadFile']>();
    expect(
      await materializeArtifact({ id: 'f1', mime: 'text/plain', url: 'https://x/f1' }, new File(), {
        downloadFile,
      })
    ).toEqual({ ok: false, reason: 'too-large' });
    expect(downloadFile).not.toHaveBeenCalled();
    expect(probeFetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it.each<ResponseInit>([
    { status: 206, headers: { 'content-length': '1' } },
    { status: 206, headers: { 'content-range': 'bytes 0-0/*' } },
    { status: 206, headers: { 'content-range': 'invalid' } },
    { status: 200, headers: {} },
    { status: 200, headers: { 'content-length': '-1' } },
    { status: 200, headers: { 'content-length': 'invalid' } },
    { status: 403, headers: {} },
    { status: 416, headers: { 'content-range': 'bytes */0' } },
  ])('keeps the post-download cap after an unknown length: %j', async init => {
    probeFetch.mockResolvedValue(new Response(null, init));
    const { file, tracked } = target();
    const downloadFile = downloadResolving(MAX_ARTIFACT_BYTES + 1);

    expect(
      await materializeArtifact({ id: 'f1', mime: 'text/plain', url: 'https://x/f1' }, file, {
        downloadFile,
      })
    ).toEqual({ ok: false, reason: 'too-large' });
    expect(downloadFile).toHaveBeenCalledOnce();
    expect(tracked.deleted).toBe(true);
    expect(probeFetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('still downloads an empty artifact when the probe is unavailable', async () => {
    probeFetch.mockRejectedValue(new Error('offline'));
    expect(
      await materializeArtifact({ id: 'f1', mime: 'text/plain', url: 'https://x/f1' }, new File(), {
        downloadFile: downloadResolving(0),
      })
    ).toEqual({ ok: true, size: 0 });
    expect(probeFetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});

describe('listSessionPage', () => {
  it('reads the 50-row page, passes nextCursor through, and forwards a cursor', async () => {
    const listSessions = vi
      .fn<ArtifactCrawlDeps['listSessions']>()
      .mockResolvedValueOnce({
        cliSessions: [{ session_id: 's1', title: 'First', updated_at: UPDATED_AT }],
        nextCursor: 'cursor-2',
      })
      .mockResolvedValueOnce({ cliSessions: [], nextCursor: null });

    const page = await listSessionPage({}, { listSessions });

    expect(listSessions).toHaveBeenCalledWith({
      limit: MIRROR_SESSION_LIMIT,
      orderBy: 'updated_at',
    });
    expect(MIRROR_SESSION_LIMIT).toBe(50);
    expect(page).toEqual({ nextCursor: 'cursor-2', sessions: [rowOf('s1', 'First')] });

    await listSessionPage({ cursor: 'cursor-2' }, { listSessions });

    expect(listSessions).toHaveBeenLastCalledWith({
      limit: MIRROR_SESSION_LIMIT,
      orderBy: 'updated_at',
      cursor: 'cursor-2',
    });
  });
});

describe('fetchSessionMessagesPage', () => {
  it('surfaces a typed failure instead of reading it as the end of a session', async () => {
    const messages = [message([filePart('file-1', 'https://x/a.txt')])];
    const getSessionMessagesPage = vi
      .fn<ArtifactCrawlDeps['getSessionMessagesPage']>()
      .mockResolvedValueOnce({ history: { messages, nextCursor: 'cursor-2' } })
      .mockResolvedValueOnce({ history: { kind: 'retryable_failure' } })
      .mockResolvedValueOnce({ history: null });

    await expect(
      fetchSessionMessagesPage({ sessionId: 's1' }, { getSessionMessagesPage })
    ).resolves.toEqual({ failure: null, messages, nextCursor: 'cursor-2' });
    expect(getSessionMessagesPage).toHaveBeenCalledWith({ session_id: 's1' });

    await expect(
      fetchSessionMessagesPage({ sessionId: 's1', cursor: 'cursor-1' }, { getSessionMessagesPage })
    ).resolves.toEqual({ failure: 'retryable', messages: [], nextCursor: 'cursor-1' });

    await expect(
      fetchSessionMessagesPage({ sessionId: 's1' }, { getSessionMessagesPage })
    ).resolves.toEqual({ failure: null, messages: [], nextCursor: null });
  });
});

describe('buildSessionArtifacts', () => {
  it('falls back to a generated title and records each materialized size', () => {
    const artifacts = new Map([
      [
        's1',
        [
          {
            id: 'file-1',
            mime: 'application/pdf',
            filename: 'reports/q1.pdf',
            size: 2048,
          },
        ],
      ],
    ]);

    expect(buildSessionArtifacts([rowOf('s1', null), rowOf('s2', 'Named')], artifacts)).toEqual([
      {
        id: 's1',
        title: 'Session s1',
        updatedAt: UPDATED_AT,
        files: [{ id: 'file-1', name: 'q1.pdf', mime: 'application/pdf', size: 2048 }],
      },
      { id: 's2', title: 'Named', updatedAt: UPDATED_AT, files: [] },
    ]);
  });

  it('hides the backend placeholder title behind the fallback label', () => {
    const sessions = buildSessionArtifacts(
      [
        rowOf('s1', 'New session - 2026-09-22T01:09:45.623Z'),
        rowOf('s2', 'Child session - 2026-09-22T01:09:45.623Z'),
      ],
      new Map()
    );

    expect(sessions.map(session => session.title)).toEqual(['Session s1', 'Session s2']);
  });

  it('disambiguates artifacts that share a filename within a session', () => {
    const artifacts = new Map([
      [
        's1',
        [
          { id: 'file-1', mime: 'application/pdf', filename: 'report.pdf', size: 1 },
          { id: 'file-2', mime: 'application/pdf', filename: 'report.pdf', size: 2 },
        ],
      ],
    ]);

    expect(buildSessionArtifacts([rowOf('s1', 'Named')], artifacts)).toEqual([
      {
        id: 's1',
        title: 'Named',
        updatedAt: UPDATED_AT,
        files: [
          { id: 'file-1', name: 'report.pdf', mime: 'application/pdf', size: 1 },
          { id: 'file-2', name: 'report (2).pdf', mime: 'application/pdf', size: 2 },
        ],
      },
    ]);
  });
});
