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
    this.name = 'ExitError';
  }
}

function stubExit(): { calls: number[]; restore: () => void } {
  const original = process.exit.bind(process);
  const calls: number[] = [];
  (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
    calls.push(code ?? 0);
    throw new ExitError(code ?? 0);
  }) as never;
  return {
    calls,
    restore: () => {
      (process as unknown as { exit: (code?: number) => never }).exit = original;
    },
  };
}

async function expectExit(operation: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ExitError);
}

function enabledProjector() {
  const lines: string[] = [];
  return {
    lines,
    projector: createControlDiagnosticProjector({
      enabled: true,
      write: line => lines.push(line),
      now: () => 1,
    }),
  };
}

async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'cert-refusal-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function recordOf(line: string | undefined): {
  event: string;
  fields: Record<string, unknown>;
} {
  return JSON.parse(line ?? '{}') as { event: string; fields: Record<string, unknown> };
}

describe('trustRuntimeCert refusal projection', () => {
  it('projects cert_unavailable, waits for the missing file, and exits 1', async () => {
    const harness = await tempDir();
    const exit = stubExit();
    const logs: string[] = [];
    const { lines, projector } = enabledProjector();
    const certPath = join(harness.dir, 'missing-ca.crt');
    const startedAt = Date.now();
    try {
      await expectExit(
        trustRuntimeCert(
          message => logs.push(message),
          { certPath, systemBundlePaths: [] },
          projector
        )
      );

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_900);
      expect(exit.calls).toEqual([1]);
      expect(logs).toEqual([
        'Certificate not found, refusing to start without HTTPS interception enabled',
      ]);
      expect(lines).toHaveLength(1);
      expect(recordOf(lines[0])).toMatchObject({
        event: 'wrapper.lifecycle',
        fields: { phase: 'start_failed', interceptTrustFailure: 'cert_unavailable' },
      });
      expect(lines[0]).not.toContain(certPath);
      expect(lines[0]).not.toContain(harness.dir);
    } finally {
      exit.restore();
      await harness.cleanup();
    }
  }, 15_000);

  it('projects cert_unreadable and exits 1 when the cert cannot be read', async () => {
    const harness = await tempDir();
    const exit = stubExit();
    const logs: string[] = [];
    const { lines, projector } = enabledProjector();
    const certPath = join(harness.dir, 'ca-directory.crt');
    await mkdir(certPath);
    try {
      await expectExit(
        trustRuntimeCert(
          message => logs.push(message),
          { certPath, systemBundlePaths: [] },
          projector
        )
      );

      expect(exit.calls).toEqual([1]);
      expect(logs).toEqual([
        'Failed to read runtime certificate, refusing to start without HTTPS interception enabled',
      ]);
      expect(lines).toHaveLength(1);
      expect(recordOf(lines[0])).toMatchObject({
        fields: { phase: 'start_failed', interceptTrustFailure: 'cert_unreadable' },
      });
      expect(lines[0]).not.toContain(harness.dir);
    } finally {
      exit.restore();
      await harness.cleanup();
    }
  });

  it('projects cert_append_failed and exits 1 when the append fails', async () => {
    const harness = await tempDir();
    const exit = stubExit();
    const logs: string[] = [];
    const { lines, projector } = enabledProjector();
    const certPath = join(harness.dir, 'ca.crt');
    const bundlePath = join(harness.dir, 'bundle-directory');
    await writeFile(certPath, 'CERT');
    await mkdir(bundlePath);
    try {
      await expectExit(
        trustRuntimeCert(
          message => logs.push(message),
          { certPath, systemBundlePaths: [bundlePath] },
          projector
        )
      );

      expect(exit.calls).toEqual([1]);
      expect(logs).toEqual([
        'Failed to append runtime certificate, refusing to start without HTTPS interception enabled',
      ]);
      expect(lines).toHaveLength(1);
      expect(recordOf(lines[0])).toMatchObject({
        fields: { phase: 'start_failed', interceptTrustFailure: 'cert_append_failed' },
      });
      expect(lines[0]).not.toContain(harness.dir);
    } finally {
      exit.restore();
      await harness.cleanup();
    }
  });

  it('writes no line but still exits 1 when the gate is unset', async () => {
    const harness = await tempDir();
    const exit = stubExit();
    const lines: string[] = [];
    const projector = createControlDiagnosticProjector({
      enabled: false,
      write: line => lines.push(line),
    });
    const certPath = join(harness.dir, 'ca-directory.crt');
    await mkdir(certPath);
    try {
      await expectExit(
        trustRuntimeCert(() => undefined, { certPath, systemBundlePaths: [] }, projector)
      );

      expect(exit.calls).toEqual([1]);
      expect(lines).toHaveLength(0);
    } finally {
      exit.restore();
      await harness.cleanup();
    }
  });

  it('does not refuse or project when no system CA bundle is present', async () => {
    const harness = await tempDir();
    const exit = stubExit();
    const logs: string[] = [];
    const { lines, projector } = enabledProjector();
    const certPath = join(harness.dir, 'ca.crt');
    await writeFile(certPath, 'CERT');
    try {
      await trustRuntimeCert(
        message => logs.push(message),
        { certPath, systemBundlePaths: [] },
        projector
      );

      expect(exit.calls).toEqual([]);
      expect(logs).toEqual(['No supported system CA bundle found']);
      expect(lines).toHaveLength(0);
    } finally {
      exit.restore();
      await harness.cleanup();
    }
  });

  it('forwards the projector through installInterceptTrustIfEnabled', async () => {
    const harness = await tempDir();
    const exit = stubExit();
    const { lines, projector } = enabledProjector();
    const certPath = join(harness.dir, 'ca-directory.crt');
    await mkdir(certPath);
    const previous = process.env[SANDBOX_INTERCEPT_HTTPS_ENV];
    process.env[SANDBOX_INTERCEPT_HTTPS_ENV] = '1';
    try {
      await expectExit(
        installInterceptTrustIfEnabled(
          () => undefined,
          { certPath, systemBundlePaths: [] },
          projector
        )
      );

      expect(exit.calls).toEqual([1]);
      expect(lines).toHaveLength(1);
      expect(recordOf(lines[0])).toMatchObject({
        fields: { phase: 'start_failed', interceptTrustFailure: 'cert_unreadable' },
      });
    } finally {
      if (previous === undefined) delete process.env[SANDBOX_INTERCEPT_HTTPS_ENV];
      else process.env[SANDBOX_INTERCEPT_HTTPS_ENV] = previous;
      exit.restore();
      await harness.cleanup();
    }
  });
});
