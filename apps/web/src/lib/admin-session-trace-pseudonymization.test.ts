import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  isPseudonymToken,
  pseudonymizeAdminSessionTrace,
} from '@/scripts/session-traces/admin-session-trace-pseudonymization';
import { pseudonymizeExportDirectory } from '@/scripts/session-traces/pseudonymize-exported-admin-session-traces';

const temporaryDirectories: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'admin-session-pseudonyms-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
});

describe('admin session trace pseudonymization', () => {
  it('hashes targeted account fields deterministically and idempotently', () => {
    const trace = {
      kilo_user_id: 'user_123',
      user: {
        id: 'user_123',
        email: 'person@example.com',
        name: 'Example Person',
        image: 'https://example.test/avatar.png',
      },
      untouched: 'metadata',
    };

    const first = pseudonymizeAdminSessionTrace(trace, 'fixture-key');
    const firstTrace = first.trace as typeof trace;
    const second = pseudonymizeAdminSessionTrace(first.trace, 'fixture-key');

    expect(first.changed).toBe(true);
    expect(first.pseudonymizedFieldCount).toBe(5);
    expect(isPseudonymToken(firstTrace.kilo_user_id)).toBe(true);
    expect(firstTrace.user.id).toBe(firstTrace.kilo_user_id);
    expect(isPseudonymToken(firstTrace.user.email)).toBe(true);
    expect(isPseudonymToken(firstTrace.user.name)).toBe(true);
    expect(isPseudonymToken(firstTrace.user.image)).toBe(true);
    expect(firstTrace.user.email).not.toBe(firstTrace.user.name);
    expect(firstTrace.untouched).toBe('metadata');
    expect(second).toEqual({
      trace: first.trace,
      changed: false,
      pseudonymizedFieldCount: 0,
      alreadyPseudonymizedFieldCount: 5,
    });
  });

  it('preserves null and missing account fields', () => {
    const result = pseudonymizeAdminSessionTrace(
      {
        kilo_user_id: null,
        user: {
          id: null,
          email: null,
        },
      },
      'fixture-key'
    );

    expect(result).toEqual({
      trace: {
        kilo_user_id: null,
        user: {
          id: null,
          email: null,
        },
      },
      changed: false,
      pseudonymizedFieldCount: 0,
      alreadyPseudonymizedFieldCount: 0,
    });
  });

  it('rewrites existing session exports without touching messages or summary files', async () => {
    const exportRoot = await makeTempDir();
    const sessionDirectory = path.join(exportRoot, 'ses_fixture');
    await mkdir(sessionDirectory, { recursive: true });
    const summaryPath = path.join(exportRoot, 'summary.json');
    const manifestPath = path.join(exportRoot, 'manifest.jsonl');
    const messages = {
      format: 'v2',
      messages: [{ user: { email: 'must-not-change@example.com' }, text: 'leave content alone' }],
    };
    const artifact = {
      export_format: 'admin-session-trace-bundle-v1',
      admin_session_trace: {
        kilo_user_id: 'user_123',
        user: {
          id: 'user_123',
          email: 'person@example.com',
          name: 'Example Person',
          image: 'https://example.test/avatar.png',
        },
      },
      admin_session_messages: messages,
    };
    await writeFile(
      path.join(sessionDirectory, 'session.json'),
      JSON.stringify(artifact, null, 2) + '\n'
    );
    await writeFile(summaryPath, '{"keep":"summary"}\n');
    await writeFile(manifestPath, '{"keep":"manifest"}\n');

    const summary = await pseudonymizeExportDirectory({
      inputDir: exportRoot,
      execute: true,
      concurrency: 1,
      pseudonymKey: 'fixture-key',
      pseudonymKeyEnv: 'FIXTURE_KEY',
    });
    const rewritten = JSON.parse(
      await readFile(path.join(sessionDirectory, 'session.json'), 'utf8')
    ) as typeof artifact;

    expect(summary).toEqual(
      expect.objectContaining({
        rewritten: 1,
        failed: 0,
        pseudonymized_fields: 5,
      })
    );
    expect(rewritten.admin_session_messages).toEqual(messages);
    expect(isPseudonymToken(rewritten.admin_session_trace.user.email)).toBe(true);
    expect(await readFile(summaryPath, 'utf8')).toBe('{"keep":"summary"}\n');
    expect(await readFile(manifestPath, 'utf8')).toBe('{"keep":"manifest"}\n');

    const secondPass = await pseudonymizeExportDirectory({
      inputDir: exportRoot,
      execute: true,
      concurrency: 1,
      pseudonymKey: 'fixture-key',
      pseudonymKeyEnv: 'FIXTURE_KEY',
    });
    expect(secondPass).toEqual(
      expect.objectContaining({
        rewritten: 0,
        already_pseudonymized: 1,
        failed: 0,
      })
    );
  });
});
