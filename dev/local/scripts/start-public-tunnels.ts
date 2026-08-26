import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const cloudAgentDevVarsPath = path.join(repoRoot, 'services/cloud-agent-next/.dev.vars');
const TRYCLOUDFLARE_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export type PublicTunnelSpec = {
  label: string;
  port: string;
  key: string;
  suffix?: string;
};

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

function main(): void {
  if (spawnSync('cloudflared', ['version'], { stdio: 'ignore' }).error) {
    console.error(
      'cloudflared not found on PATH. Install it:\n  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n  brew install cloudflared'
    );
    process.exit(1);
  }

  const specs = publicTunnelSpecs(parsePublicTunnelPorts(process.argv.slice(2)));
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
  main();
}
