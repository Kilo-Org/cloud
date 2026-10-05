import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlDiagnosticProjector } from '../../../src/shared/control-diagnostics.js';
import { SANDBOX_INTERCEPT_HTTPS_ENV } from '../../../src/shared/container-intercept.js';
import { installInterceptTrustIfEnabled, trustRuntimeCert } from './cert.js';

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

describe('intercept trust refusal projection', () => {
  it.each([
    { failure: 'cert_unavailable', fixture: 'missing', enabled: true },
    { failure: 'cert_unreadable', fixture: 'directory', enabled: true },
    { failure: 'cert_append_failed', fixture: 'bundle-directory', enabled: true },
    { failure: 'cert_unreadable', fixture: 'directory', enabled: false },
  ])(
    '$failure with native logs enabled=$enabled refuses before startup',
    async testCase => {
      const dir = await mkdtemp(join(tmpdir(), 'cert-refusal-'));
      const certPath = join(dir, 'ca.crt');
      const bundlePath = join(dir, 'bundle');
      const lines: string[] = [];
      const logs: string[] = [];
      const projector = createControlDiagnosticProjector({
        enabled: testCase.enabled,
        write: line => lines.push(line),
        now: () => 1,
      });
      const originalExit = process.exit.bind(process);
      const previous = process.env[SANDBOX_INTERCEPT_HTTPS_ENV];
      process.exit = ((code?: number) => {
        throw new ExitError(code ?? 0);
      }) as typeof process.exit;
      process.env[SANDBOX_INTERCEPT_HTTPS_ENV] = '1';
      try {
        if (testCase.fixture === 'directory') await mkdir(certPath);
        if (testCase.fixture === 'bundle-directory') {
          await writeFile(certPath, 'CERT');
          await mkdir(bundlePath);
        }
        const startedAt = Date.now();
        await installInterceptTrustIfEnabled(
          message => logs.push(message),
          {
            certPath,
            systemBundlePaths: testCase.fixture === 'bundle-directory' ? [bundlePath] : [],
          },
          projector
        ).then(
          () => {
            throw new Error('Expected certificate refusal');
          },
          error => {
            expect(error).toBeInstanceOf(ExitError);
            expect(error).toMatchObject({ code: 1 });
          }
        );
        if (testCase.fixture === 'missing') {
          expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_900);
        }
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain('refusing to start without HTTPS interception enabled');
        expect(lines).toHaveLength(testCase.enabled ? 1 : 0);
        if (testCase.enabled) {
          expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
            event: 'wrapper.lifecycle',
            fields: { phase: 'start_failed', interceptTrustFailure: testCase.failure },
          });
          expect(lines[0]).not.toContain(dir);
        }
      } finally {
        process.exit = originalExit;
        if (previous === undefined) delete process.env[SANDBOX_INTERCEPT_HTTPS_ENV];
        else process.env[SANDBOX_INTERCEPT_HTTPS_ENV] = previous;
        await rm(dir, { recursive: true, force: true });
      }
    },
    15_000
  );

  it('does not refuse or project when no system CA bundle is present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cert-refusal-'));
    const certPath = join(dir, 'ca.crt');
    const lines: string[] = [];
    const logs: string[] = [];
    try {
      await writeFile(certPath, 'CERT');
      await trustRuntimeCert(
        message => logs.push(message),
        { certPath, systemBundlePaths: [] },
        createControlDiagnosticProjector({ enabled: true, write: line => lines.push(line) })
      );
      expect(logs).toEqual(['No supported system CA bundle found']);
      expect(lines).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
