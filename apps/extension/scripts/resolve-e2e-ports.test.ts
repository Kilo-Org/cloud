/* eslint-disable import/no-nodejs-modules, promise/avoid-new */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface DevStatus {
  services?: { name: string; port: number }[];
  portOffset?: number;
}

const scriptPath = fileURLToPath(new URL('resolve-e2e-ports.mjs', import.meta.url));
const nextjsPort = 3100;
const services = [
  { name: 'nextjs', port: nextjsPort },
  { name: 'cloud-agent-next', port: 8894 },
  { name: 'cloudflare-session-ingest', port: 8900 },
];

const managedVars = [
  'VITE_KILO_API_BASE_URL',
  'LOCAL_BACKEND_ORIGIN',
  'VITE_CLOUD_AGENT_WS_URL',
  'VITE_SESSION_INGEST_WS_URL',
];

function runScript(input: DevStatus, overrides: Record<string, string>): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of managedVars) {
    delete env[key];
  }
  Object.assign(env, overrides);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`resolve-e2e-ports exited with ${String(code)}: ${stderr}`));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

describe('resolve-e2e-ports', () => {
  it('prints LOCAL_BACKEND_ORIGIN when only VITE_KILO_API_BASE_URL is already set', async () => {
    const stdout = await runScript(
      { portOffset: 0, services },
      { VITE_KILO_API_BASE_URL: 'https://example.test' }
    );
    const exported = stdout.trim().split(/\s+/);
    expect(exported).toContain(`LOCAL_BACKEND_ORIGIN=http://localhost:${nextjsPort}`);
    expect(exported.some(entry => entry.startsWith('VITE_KILO_API_BASE_URL='))).toBe(false);
  });

  it('prints both variables with the same origin when both are unset', async () => {
    const stdout = await runScript({ portOffset: 0, services }, {});
    const exported = stdout.trim().split(/\s+/);
    expect(exported).toContain(`VITE_KILO_API_BASE_URL=http://localhost:${nextjsPort}`);
    expect(exported).toContain(`LOCAL_BACKEND_ORIGIN=http://localhost:${nextjsPort}`);
  });
});
