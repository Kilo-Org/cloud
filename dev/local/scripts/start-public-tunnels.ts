import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// The fake LLM's `/test/*` admin credential. Imported from the fake's own
// module so the dev tunnel, the local Node server and the E2E driver cannot
// disagree about the token name or the insecure development default.
import {
  LOCAL_FAKE_LLM_ADMIN_TOKEN,
  resolveFakeAdminToken,
} from '../../../services/cloud-agent-next/test/e2e/fake-llm-admin';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const cloudAgentDevVarsPath = path.join(repoRoot, 'services/cloud-agent-next/.dev.vars');
const TRYCLOUDFLARE_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export type PublicTunnelSpec = {
  label: string;
  port: string;
  key: string;
  suffix?: string;
};

export type FakeTunnelGuardResult = { allow: true } | { allow: false; reason: string };

export type FakeTunnelGuardInput = {
  /** Host-side fake LLM port. Absent means no fake-llm tunnel is published. */
  fakeLlmPort?: string;
  /** The token the tunnel's clients and the local fake are configured with. */
  adminToken: string;
  /** `GET /test/requests` with the configured token; true only on HTTP 200. */
  probeConfiguredToken: (port: string) => Promise<boolean>;
  /** The same probe with the insecure development default token. */
  probeDevDefaultToken: (port: string) => Promise<boolean>;
};

/**
 * Decide whether the fake LLM may be published publicly.
 *
 * The local fake binds `0.0.0.0`, so publishing it puts its `/test/*` control
 * endpoints on the public internet. The gate is the admin token:
 *
 *   1. the configured token must exist and not be the development default;
 *   2. the running server must accept it;
 *   3. the running server must NOT still accept the development default.
 *
 * Deliberately no length heuristic: rejecting an operator's short token is
 * invented policy, and the checks above already cover the documented weak
 * values.
 */
export async function evaluateFakeTunnelGuard(
  input: FakeTunnelGuardInput
): Promise<FakeTunnelGuardResult> {
  if (!input.fakeLlmPort) return { allow: true };

  if (!input.adminToken) {
    return {
      allow: false,
      reason: 'FAKE_LLM_ADMIN_TOKEN is unset or empty',
    };
  }
  if (input.adminToken === LOCAL_FAKE_LLM_ADMIN_TOKEN) {
    return {
      allow: false,
      reason: `FAKE_LLM_ADMIN_TOKEN is the insecure development default (${LOCAL_FAKE_LLM_ADMIN_TOKEN})`,
    };
  }
  if (!(await input.probeConfiguredToken(input.fakeLlmPort))) {
    return {
      allow: false,
      reason: `the fake LLM on port ${input.fakeLlmPort} rejected the configured admin token — is it running with FAKE_LLM_ADMIN_TOKEN set?`,
    };
  }
  if (await input.probeDevDefaultToken(input.fakeLlmPort)) {
    return {
      allow: false,
      reason: `the fake LLM on port ${input.fakeLlmPort} still accepts the development default token`,
    };
  }

  return { allow: true };
}

/**
 * The concrete probe the guard runs: `GET /test/requests` on the host-side fake
 * port, true only for an HTTP 200. Exported so a test can point it at a real
 * fake server.
 */
export async function probeFakeControlRoute(port: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}/test/requests`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await response.text();
    return response.status === 200;
  } catch {
    return false;
  }
}

export function parsePublicTunnelPorts(argv: string[]): {
  workerPort: string;
  nextjsPort: string;
  sessionIngestPort: string;
  fakeLlmPort?: string;
} {
  const [workerPort, nextjsPort, sessionIngestPort, fakeLlmPort] = argv;
  if (!workerPort || !nextjsPort || !sessionIngestPort) {
    throw new Error(
      'Usage: start-public-tunnels.ts <worker-port> <nextjs-port> <session-ingest-port> [fake-llm-port]'
    );
  }
  return {
    workerPort,
    nextjsPort,
    sessionIngestPort,
    ...(fakeLlmPort ? { fakeLlmPort } : {}),
  };
}

export function publicTunnelSpecs(ports: {
  workerPort: string;
  nextjsPort: string;
  sessionIngestPort: string;
  fakeLlmPort?: string;
}): PublicTunnelSpec[] {
  const specs: PublicTunnelSpec[] = [
    { label: 'worker', port: ports.workerPort, key: 'WORKER_URL' },
    { label: 'nextjs', port: ports.nextjsPort, key: 'KILOCODE_BACKEND_BASE_URL' },
    { label: 'session-ingest', port: ports.sessionIngestPort, key: 'KILO_SESSION_INGEST_URL' },
  ];
  if (ports.fakeLlmPort) {
    specs.push({
      label: 'fake-llm',
      port: ports.fakeLlmPort,
      key: 'KILO_OPENROUTER_BASE',
      suffix: '/api',
    });
  }
  return specs;
}

export function envValueForCapturedUrl(spec: PublicTunnelSpec, url: string): string {
  return spec.suffix ? `${url}${spec.suffix}` : url;
}

export function providerBaseFromBackendTunnel(backendUrl: string): string {
  return `${backendUrl.replace(/\/+$/, '')}/api`;
}

export function updateEnvValue(filePath: string, key: string, value: string): void {
  let content = '';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf-8');
  }

  const activePattern = new RegExp(`^${key}=.*`, 'm');
  const commentedPattern = new RegExp(`^# ${key}=.*`, 'm');

  if (activePattern.test(content)) {
    content = content.replace(activePattern, `${key}=${value}`);
  } else if (commentedPattern.test(content)) {
    content = content.replace(commentedPattern, `${key}=${value}`);
  } else {
    content = content.endsWith('\n') || content === '' ? content : content + '\n';
    content += `${key}=${value}\n`;
  }

  fs.writeFileSync(filePath, content);
}

async function main(): Promise<void> {
  if (spawnSync('cloudflared', ['version'], { stdio: 'ignore' }).error) {
    console.error(
      'cloudflared not found on PATH. Install it:\n  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n  brew install cloudflared'
    );
    process.exit(1);
  }

  const ports = parsePublicTunnelPorts(process.argv.slice(2));

  // Refuse to publish the fake LLM before spawning any tunnel: its `/test/*`
  // control endpoints must never be reachable with the development default.
  const adminToken = resolveFakeAdminToken();
  const guard = await evaluateFakeTunnelGuard({
    ...(ports.fakeLlmPort ? { fakeLlmPort: ports.fakeLlmPort } : {}),
    adminToken,
    probeConfiguredToken: port => probeFakeControlRoute(port, adminToken),
    probeDevDefaultToken: port => probeFakeControlRoute(port, LOCAL_FAKE_LLM_ADMIN_TOKEN),
  });
  if (!guard.allow) {
    console.error(`Refusing to publish the fake LLM tunnel: ${guard.reason}`);
    process.exit(1);
  }

  const specs = publicTunnelSpecs(ports);
  const children: Array<{ label: string; child: ReturnType<typeof spawn> }> = [];
  let exiting = false;

  function stopAll(signal: NodeJS.Signals): void {
    for (const { child } of children) child.kill(signal);
  }

  function exitAndStopOthers(originLabel: string, code: number | null): void {
    if (exiting) return;
    exiting = true;
    for (const { label, child } of children) {
      if (label !== originLabel) child.kill('SIGTERM');
    }
    process.exit(code ?? 1);
  }

  for (const spec of specs) {
    const child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${spec.port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push({ label: spec.label, child });
    console.log(`Starting quick tunnel (${spec.label}) -> http://localhost:${spec.port}...`);

    let captured = false;
    const handleOutput = (data: Buffer) => {
      process.stderr.write(data);
      if (captured) return;
      const match = data.toString().match(TRYCLOUDFLARE_URL);
      if (!match) return;
      captured = true;
      const value = envValueForCapturedUrl(spec, match[0]);
      updateEnvValue(cloudAgentDevVarsPath, spec.key, value);
      if (
        spec.key === 'KILOCODE_BACKEND_BASE_URL' &&
        !specs.some(item => item.key === 'KILO_OPENROUTER_BASE')
      ) {
        updateEnvValue(
          cloudAgentDevVarsPath,
          'KILO_OPENROUTER_BASE',
          providerBaseFromBackendTunnel(match[0])
        );
      }
      console.log(`\n${spec.label} tunnel URL: ${match[0]}`);
      console.log(`Set ${spec.key}=${value}`);
    };

    child.stdout.on('data', handleOutput);
    child.stderr.on('data', handleOutput);
    child.on('close', code => exitAndStopOthers(spec.label, code));
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      stopAll(signal);
      if (children.length === 0) process.exit(0);
    });
  }
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
