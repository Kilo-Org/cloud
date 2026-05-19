import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AdminTrpcError,
  createAdminSessionTraceApi,
  exportAdminSessionTraces,
  parseSessionIdsCsv,
  safeSessionDirectoryName,
  type AdminSessionTraceApi,
} from '@/scripts/session-traces/export-admin-session-traces';
import { isPseudonymToken } from '@/scripts/session-traces/admin-session-trace-pseudonymization';

const temporaryDirectories: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'admin-session-traces-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
});

describe('admin session trace export script', () => {
  it('parses session_id headers case-insensitively and deduplicates values', () => {
    const parsed = parseSessionIdsCsv(
      ['SESSION_ID,cohort', 'ses_a,one', 'ses_a,two', ',blank', 'ses_b,three'].join('\n'),
      'sessions.csv'
    );

    expect(parsed).toEqual({
      sessionIds: ['ses_a', 'ses_b'],
      inputRowCount: 4,
      duplicateSessionIdCount: 1,
      blankSessionIdCount: 1,
      sessionIdHeader: 'SESSION_ID',
    });
  });

  it('calls the deployed Admin tRPC query shape with bearer auth', async () => {
    const fetchImpl = jest.fn(
      async () =>
        new Response(JSON.stringify({ result: { data: { session_id: 'ses_a' } } }), {
          status: 200,
        })
    ) as unknown as typeof fetch;
    const api = createAdminSessionTraceApi({
      baseUrl: 'https://admin.example.test/',
      authToken: 'admin-token',
      maxAttempts: 1,
      fetchImpl,
      sleep: async () => undefined,
    });

    await expect(api.getSessionTrace('ses_a')).resolves.toEqual({ session_id: 'ses_a' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = (fetchImpl as unknown as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(requestUrl).toBe(
      'https://admin.example.test/api/trpc/admin.sessionTraces.get?input=%7B%22session_id%22%3A%22ses_a%22%7D'
    );
    expect(requestInit.headers).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer admin-token',
    });
  });

  it('writes admin export bundles, manifests not-found sessions, and summarizes counts', async () => {
    const tempDir = await makeTempDir();
    const inputPath = path.join(tempDir, 'sessions.csv');
    const outputDir = path.join(tempDir, 'output');
    await writeFile(inputPath, 'session_id\nses_export\nses_missing\nses_export\n', 'utf8');

    const api: AdminSessionTraceApi = {
      async getSessionTrace(sessionId) {
        if (sessionId === 'ses_missing') {
          throw new AdminTrpcError({
            procedure: 'admin.sessionTraces.get',
            message: 'Session not found',
            status: 404,
            trpcCode: 'NOT_FOUND',
          });
        }
        return {
          session_id: sessionId,
          title: 'Visible admin metadata',
          kilo_user_id: 'user_123',
          user: {
            id: 'user_123',
            email: 'person@example.com',
            name: 'Example Person',
            image: 'https://example.test/avatar.png',
          },
        };
      },
      async getSessionMessages(sessionId) {
        return {
          format: 'v2',
          messages: [
            {
              info: { id: `${sessionId}-msg` },
              parts: [
                {
                  type: 'text',
                  text: 'key=sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
                },
              ],
            },
          ],
        };
      },
    };

    const summary = await exportAdminSessionTraces(
      {
        inputPath,
        outputDir,
        baseUrl: 'https://admin.example.test',
        authToken: 'unused-in-fake-api',
        pseudonymKey: 'test-pseudonym-key',
        concurrency: 2,
        resume: false,
        maxAttempts: 1,
        truffleHogMode: 'off',
        now: () => new Date('2026-05-18T12:00:00.000Z'),
      },
      { api }
    );

    expect(summary).toEqual(
      expect.objectContaining({
        requested_rows: 3,
        unique_session_ids: 2,
        duplicate_session_ids: 1,
        exported: 1,
        not_found: 1,
        failed: 0,
        empty_message_bundles: 0,
        secret_scan: expect.objectContaining({ status: 'skipped', mode: 'off' }),
      })
    );

    const artifactPath = path.join(
      outputDir,
      safeSessionDirectoryName('ses_export'),
      'session.json'
    );
    const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as Record<string, unknown>;
    expect(artifact).toEqual(
      expect.objectContaining({
        export_format: 'admin-session-trace-bundle-v1',
        exported_at: '2026-05-18T12:00:00.000Z',
        session_id: 'ses_export',
        admin_session_messages: expect.objectContaining({
          format: 'v2',
        }),
      })
    );
    const trace = artifact.admin_session_trace as {
      session_id: string;
      title: string;
      kilo_user_id: string;
      user: { id: string; email: string; name: string; image: string };
    };
    expect(trace.session_id).toBe('ses_export');
    expect(trace.title).toBe('Visible admin metadata');
    expect(isPseudonymToken(trace.kilo_user_id)).toBe(true);
    expect(trace.user.id).toBe(trace.kilo_user_id);
    expect(isPseudonymToken(trace.user.email)).toBe(true);
    expect(isPseudonymToken(trace.user.name)).toBe(true);
    expect(isPseudonymToken(trace.user.image)).toBe(true);
    const serializedArtifact = JSON.stringify(artifact);
    expect(serializedArtifact).not.toContain('person@example.com');
    expect(serializedArtifact).not.toContain('sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890');
    expect(serializedArtifact).toContain('[REDACTED_SECRET:v1:openai-secret-key:');

    const manifest = (await readFile(summary.manifest_path, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(manifest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          session_id: 'ses_export',
          status: 'exported',
          message_count: 1,
          empty_messages: false,
        }),
        expect.objectContaining({
          session_id: 'ses_missing',
          status: 'not_found',
          error: 'Session not found',
        }),
      ])
    );
  });

  it('skips already exported sessions when resume is enabled', async () => {
    const tempDir = await makeTempDir();
    const inputPath = path.join(tempDir, 'sessions.csv');
    const outputDir = path.join(tempDir, 'output');
    await writeFile(inputPath, 'session_id\nses_resume\n', 'utf8');

    const api: AdminSessionTraceApi = {
      getSessionTrace: jest.fn(async () => ({ session_id: 'ses_resume' })),
      getSessionMessages: jest.fn(async () => ({ format: 'v2', messages: [] })),
    };

    await exportAdminSessionTraces(
      {
        inputPath,
        outputDir,
        baseUrl: 'https://admin.example.test',
        authToken: 'unused-in-fake-api',
        pseudonymKey: 'test-pseudonym-key',
        concurrency: 1,
        resume: false,
        maxAttempts: 1,
        truffleHogMode: 'off',
      },
      { api }
    );

    const resumedSummary = await exportAdminSessionTraces(
      {
        inputPath,
        outputDir,
        baseUrl: 'https://admin.example.test',
        authToken: 'unused-in-fake-api',
        pseudonymKey: 'test-pseudonym-key',
        concurrency: 1,
        resume: true,
        maxAttempts: 1,
        truffleHogMode: 'off',
      },
      {
        api: {
          getSessionTrace: jest.fn(async () => {
            throw new Error('resume should not refetch metadata');
          }),
          getSessionMessages: jest.fn(async () => {
            throw new Error('resume should not refetch messages');
          }),
        },
      }
    );

    expect(resumedSummary).toEqual(
      expect.objectContaining({
        exported: 0,
        skipped_existing: 1,
        failed: 0,
      })
    );
  });
});
