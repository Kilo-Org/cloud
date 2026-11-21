import { describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTAINERS_INTERCEPT_CA_PATH,
  SANDBOX_INTERCEPT_HTTPS_ENV,
} from '../../../src/shared/container-intercept.js';
import { CONTROL_PLANE_ALLOCATION_ID_ENV } from '../../../src/shared/control-plane-protocol.js';

const MAIN_PATH = join(import.meta.dir, 'main.ts');
const PRELOAD_PATH = join(import.meta.dir, 'main-cert-refusal-preload.ts');
const CREDENTIAL = 'test-credential';

function childEnv(url: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  return {
    ...environment,
    CLOUD_AGENT_SENTRY_DSN: '',
    CLOUD_AGENT_SENTRY_ENVIRONMENT: '',
    CONTROL_LOG_UPLOAD_URL: '',
    CONTROL_LOG_UPLOAD_GRANT: '',
    CONTROL_PLANE_NATIVE_LOGS: '1',
    [SANDBOX_INTERCEPT_HTTPS_ENV]: '1',
    SANDBOX_CONTROL_URL: url,
    SANDBOX_CONTROL_CREDENTIAL: CREDENTIAL,
    [CONTROL_PLANE_ALLOCATION_ID_ENV]: 'alloc-1',
    WRAPPER_LOG_PATH: join(tmpdir(), `cp-cert-refusal-${process.pid}-${Date.now()}.log`),
  };
}

async function waitForExit(child: Bun.Subprocess, timeoutMs: number): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited,
      new Promise<number>(resolve => {
        timer = setTimeout(() => resolve(Number.NaN), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('control-plane wrapper cert refusal process', () => {
  it('exits 1 with one cert_unavailable line, no path or secret, and no connection attempt', async () => {
    let attempts = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        attempts += 1;
        return new Response('unexpected', { status: 500 });
      },
    });
    const child = Bun.spawn([process.execPath, 'run', `--preload=${PRELOAD_PATH}`, MAIN_PATH], {
      env: childEnv(`ws://127.0.0.1:${server.port}/sandbox-control/fake`),
      stdout: 'ignore',
      stderr: 'pipe',
    });
    try {
      expect(await waitForExit(child, 12_000)).toBe(1);

      const stderr = await new Response(child.stderr).text();
      const refusalLines = stderr
        .split('\n')
        .filter(line => line.includes('"interceptTrustFailure":"cert_unavailable"'));
      expect(refusalLines).toHaveLength(1);
      expect(stderr).not.toContain(CONTAINERS_INTERCEPT_CA_PATH);
      expect(stderr).not.toContain(CREDENTIAL);
      expect(attempts).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
      void server.stop(true);
    }
  }, 20_000);
});
