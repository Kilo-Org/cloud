/* eslint-disable import/no-nodejs-modules -- Runs the resolver as a real process to observe its command line contract. */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveE2ePorts } from './resolve-e2e-ports.mjs';

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'resolve-e2e-ports.mjs');

const devStatus = (services: { name: string; port: unknown }[], portOffset = 0): unknown => ({
  portOffset,
  services: services.map(service => ({ group: 'app', status: 'up', ...service })),
  session: 'kilo-dev-test',
});

const runScript = (input: string) =>
  spawnSync(process.execPath, [SCRIPT_PATH], { encoding: 'utf8', input });

describe('e2e port resolution', () => {
  it('uses every port the dev stack reports', () => {
    expect(
      resolveE2ePorts(
        devStatus(
          [
            { name: 'nextjs', port: 3100 },
            { name: 'cloud-agent-next', port: 8894 },
            { name: 'cloudflare-session-ingest', port: 8900 },
          ],
          100
        ),
        {}
      )
    ).toStrictEqual({
      LOCAL_BACKEND_ORIGIN: 'http://localhost:3100',
      VITE_CLOUD_AGENT_WS_URL: 'ws://localhost:8894',
      VITE_KILO_API_BASE_URL: 'http://localhost:3100',
      VITE_SESSION_INGEST_WS_URL: 'ws://localhost:8900',
    });
  });

  it('falls back to offset defaults for values that are not usable ports', () => {
    expect(
      resolveE2ePorts(
        devStatus(
          [
            { name: 'nextjs', port: '3000 && echo injected' },
            { name: 'cloud-agent-next', port: 70_000 },
            { name: 'cloudflare-session-ingest', port: -1 },
          ],
          100
        ),
        {}
      )
    ).toStrictEqual({
      LOCAL_BACKEND_ORIGIN: 'http://localhost:3100',
      VITE_CLOUD_AGENT_WS_URL: 'ws://localhost:8894',
      VITE_KILO_API_BASE_URL: 'http://localhost:3100',
      VITE_SESSION_INGEST_WS_URL: 'ws://localhost:8900',
    });
  });

  it('falls back to defaults when the stack reports no services', () => {
    expect(
      resolveE2ePorts({ portOffset: 0, services: [], session: 'kilo-dev-test' }, {})
    ).toStrictEqual({
      LOCAL_BACKEND_ORIGIN: 'http://localhost:3000',
      VITE_CLOUD_AGENT_WS_URL: 'ws://localhost:8794',
      VITE_KILO_API_BASE_URL: 'http://localhost:3000',
      VITE_SESSION_INGEST_WS_URL: 'ws://localhost:8800',
    });
  });

  it('leaves variables that are already set alone', () => {
    expect(
      resolveE2ePorts(devStatus([{ name: 'nextjs', port: 3100 }]), {
        VITE_CLOUD_AGENT_WS_URL: 'wss://example.test',
        VITE_KILO_API_BASE_URL: 'https://example.test',
      })
    ).toStrictEqual({ VITE_SESSION_INGEST_WS_URL: 'ws://localhost:8800' });
  });
});

describe('resolve-e2e-ports command line', () => {
  it('prints quoted exports without repeating a rejected value', () => {
    const result = runScript(
      JSON.stringify(
        devStatus([
          { name: 'nextjs', port: '3000; touch /tmp/should-not-run' },
          { name: 'cloud-agent-next', port: 8894 },
          { name: 'cloudflare-session-ingest', port: 8900 },
        ])
      )
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "export VITE_KILO_API_BASE_URL='http://localhost:3000' LOCAL_BACKEND_ORIGIN='http://localhost:3000' VITE_CLOUD_AGENT_WS_URL='ws://localhost:8894' VITE_SESSION_INGEST_WS_URL='ws://localhost:8900'\n"
    );
    expect(result.stderr).toContain('nextjs reported no usable port');
    expect(result.stdout).not.toContain('should-not-run');
    expect(result.stderr).not.toContain('should-not-run');
  });

  it('fails with a clear message when dev:status prints no JSON', () => {
    const result = runScript('No dev session running\n');

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('did not print JSON');
  });
});
