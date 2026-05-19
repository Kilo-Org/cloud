import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseTruffleHogFindings,
  scanExportDirectoryWithTruffleHog,
} from '@/scripts/session-traces/trufflehog-export-secret-scan';

const temporaryDirectories: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'admin-session-trufflehog-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
});

describe('admin session export TruffleHog scanner', () => {
  it('parses findings into sanitized metadata without retaining raw secret material', () => {
    const parsed = parseTruffleHogFindings(
      [
        JSON.stringify({ level: 'info-0', msg: 'running source' }),
        JSON.stringify({
          DetectorName: 'ExampleDetector',
          DetectorType: 42,
          Verified: false,
          Raw: 'raw-secret-value',
          RawV2: 'raw-secret-value-v2',
          Redacted: 'leaky-redacted-preview',
          SourceMetadata: {
            Data: {
              Filesystem: {
                file: '/scan/ses_abc/session.json',
                line: 17,
              },
            },
          },
        }),
      ].join('\n'),
      '/tmp/export'
    );

    expect(parsed.invalidLineCount).toBe(0);
    expect(parsed.findings).toEqual([
      {
        detector_name: 'ExampleDetector',
        detector_type: 42,
        verification_state: 'unverified',
        relative_path: 'ses_abc/session.json',
        line: 17,
      },
    ]);
    expect(JSON.stringify(parsed.findings)).not.toContain('raw-secret-value');
    expect(JSON.stringify(parsed.findings)).not.toContain('leaky-redacted-preview');
  });

  it('writes sanitized findings when TruffleHog reports matches', async () => {
    const outputDir = await makeTempDir();
    const summary = await scanExportDirectoryWithTruffleHog(
      {
        outputDir,
        mode: 'binary',
      },
      {
        commandExists: async command => command === 'trufflehog',
        runProcess: async () => ({
          exitCode: 183,
          stderr: 'do not persist scanner stderr',
          spawnError: null,
          stdout: JSON.stringify({
            DetectorName: 'ExampleDetector',
            DetectorType: 'Example',
            Verified: true,
            Raw: 'secret-that-must-not-be-written',
            SourceMetadata: {
              Data: {
                Filesystem: {
                  file: path.join(outputDir, 'ses_xyz', 'session.json'),
                  line: 91,
                },
              },
            },
          }),
        }),
      }
    );

    expect(summary).toEqual(
      expect.objectContaining({
        status: 'findings',
        runner: 'binary',
        finding_count: 1,
        findings_by_detector: { ExampleDetector: 1 },
        findings_by_verification: { verified: 1 },
      })
    );
    expect(summary.findings_path).toBeTruthy();
    const findingsText = await readFile(summary.findings_path as string, 'utf8');
    expect(findingsText).toContain('ses_xyz/session.json');
    expect(findingsText).not.toContain('secret-that-must-not-be-written');
    expect(findingsText).not.toContain('do not persist scanner stderr');
  });
});
